#!/usr/bin/env node
/*
 * Event-Spine server (I/O shell) for the Hex-World Agent Visualizer.
 *
 * Turns Claude Code hook events (POSTed by hooks/hook.js) into live in-memory world/worker state
 * and broadcasts it to browsers over WebSocket. The PURE state-machine + transcript logic lives in
 * ./state.mjs (unit-tested); this file only does HTTP/WS/fs and calls into it.
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import {
  applyEvent, watchdog, serializeUnit, newTranscriptState, feedTranscript, transcriptDigest, FLASH_TTL,
  ensureWorld, cmdSummary, toSaved, fromSaved, recentSeries, summarize, recordActivity, timelineSeries, ACTIVITY, reconcilePids,
} from './state.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8787;
const PUBLIC = path.resolve(__dirname, '..', 'public');
const CONFIG = path.resolve(__dirname, '..', 'config'); // browser imports the shared config from here
const VENDOR = path.resolve(__dirname, '..', 'node_modules', 'pixi.js', 'dist'); // PixiJS served locally
const HLJS = path.resolve(__dirname, '..', 'node_modules', '@highlightjs', 'cdn-assets'); // syntax highlighter for the mirror
const MARKED = path.resolve(__dirname, '..', 'node_modules', 'marked', 'lib');           // markdown renderer for assistant text
const DOMPURIFY = path.resolve(__dirname, '..', 'node_modules', 'dompurify', 'dist');    // sanitizes markdown HTML before it hits the DOM
const STATE_FILE = process.env.HEX_WORLD_STATE_FILE || path.resolve(__dirname, '..', 'hooks', 'worlds.json'); // sessions saved across restarts
const HOST = process.env.HEX_WORLD_HOST || '127.0.0.1';   // Docker sets 0.0.0.0 and publishes the port on 127.0.0.1 only
// In a container we can't see the host's `claude` processes or show its notifications: turn those off
// (otherwise "no claude process in this folder" would wrongly drop every session).
const IN_DOCKER = process.env.HEX_WORLD_DOCKER === '1';
const TRACK_PROCS = !IN_DOCKER && process.platform !== 'win32';
const PROJECTS = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
// How long a board card may hold a prompt: 0 (default) = until you answer, press Terminal, answer in the
// terminal, or close the last board tab. Set seconds to cap it.
const PERMISSION_WAIT = (Number(process.env.HEX_WORLD_PERMISSION_WAIT) || 0) * 1000;
// Booted directly (not imported by tests) → the only mode that notifies, persists and binds the port.
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

/** worlds[sessionId] = { status, cwd, transcriptPath, source, lastSeen, main, workers } */
const worlds = Object.create(null);

// --- transcript digest: incremental tail-parse of the append-only JSONL -------------------
// Per path we remember how many bytes we've consumed and feed only the newly appended ones, so a
// 50MB transcript is read once, then a few KB per update. Split at the last '\n' BYTE (never inside
// a multi-byte UTF-8 char); the unterminated remainder is kept as bytes until its newline arrives.
// ponytail: detects a rewrite only by the file shrinking; entries never evicted (a few KB per session ever seen).
const txCache = new Map();                    // path -> { size, rest: Buffer, st, digest }
function readDigest(p) { const c = readTx(p); return c && c.digest; }
function readState(p) { const c = readTx(p); return c && c.st; }
function readTx(p) {
  if (!p) return null;
  let size;
  try { size = fs.statSync(p).size; } catch { return null; } // no transcript yet
  let c = txCache.get(p);
  if (!c || size < c.size) {
    const st = newTranscriptState();
    c = { size: 0, rest: Buffer.alloc(0), st, digest: transcriptDigest(st) };
    txCache.set(p, c);
  }
  if (size === c.size) return c;
  try {
    const buf = Buffer.alloc(size - c.size);
    const fd = fs.openSync(p, 'r');
    try { fs.readSync(fd, buf, 0, buf.length, c.size); } finally { fs.closeSync(fd); }
    c.size = size;
    let all = c.rest.length ? Buffer.concat([c.rest, buf]) : buf;
    const nl = all.lastIndexOf(0x0a);
    if (nl !== -1) { feedTranscript(c.st, all.toString('utf8', 0, nl)); all = all.subarray(nl + 1); }
    // A final line without '\n' is complete iff it parses (a cut JSON object never does).
    try { if (all.length) { JSON.parse(all.toString('utf8')); feedTranscript(c.st, all.toString('utf8')); all = all.subarray(all.length); } } catch { /* partial */ }
    c.rest = Buffer.from(all);                 // copy: don't pin the whole read buffer
    c.digest = transcriptDigest(c.st);
  } catch { /* read failed: serve the last good digest */ }
  return c;
}
function titleFor(w) { const d = readDigest(w.transcriptPath); return (d && d.title) || null; }

// A session's transcript + its subagents' (<session>/subagents/*.jsonl) — subagents cost money too.
function sessionFiles(mainPath) {
  if (!mainPath) return [];
  const dir = path.join(path.dirname(mainPath), path.basename(mainPath, '.jsonl'), 'subagents');
  let subs = [];
  try { subs = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(dir, f)); } catch { /* none */ }
  return [mainPath, ...subs];
}

// Every transcript touched in the last `days` days, under ~/.claude/projects (or CLAUDE_CONFIG_DIR).
function recentTranscripts(days) {
  const since = Date.now() - days * 86_400_000, out = [];
  const fresh = (f) => { try { return fs.statSync(f).mtimeMs >= since; } catch { return false; } };
  let projects = [];
  try { projects = fs.readdirSync(PROJECTS); } catch { return out; }
  for (const proj of projects) {
    let names = [];
    try { names = fs.readdirSync(path.join(PROJECTS, proj)); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith('.jsonl')) continue;
      for (const [i, f] of sessionFiles(path.join(PROJECTS, proj, n)).entries()) if (fresh(f)) out.push({ file: f, isSession: i === 0 });
    }
  }
  return out;
}
// The first /summary parses up to a few hundred MB — yield between files so hook POSTs (200ms
// budget) keep flowing; after that the incremental cache makes it cheap. Short TTL cache on top.
let summaryCache = null;                      // { at, days, data }
async function buildSummary(days) {
  if (summaryCache && summaryCache.days === days && Date.now() - summaryCache.at < 20_000) return summaryCache.data;
  const entries = [];
  for (const { file, isSession } of recentTranscripts(days)) {
    const st = readState(file);
    if (st) entries.push({ st, isSession });
    await new Promise((r) => setImmediate(r));
  }
  const data = summarize(entries, Date.now(), days);
  summaryCache = { at: Date.now(), days, data };
  return data;
}

// ---- desktop notifications (#1): from the server, so they work with the tab closed -------------
// argv (not string-building) keeps session text out of the AppleScript source — no injection.
const OS_NOTIFY = process.platform === 'darwin' || process.platform === 'linux';
const NOTIFY = isMain && OS_NOTIFY && !IN_DOCKER && process.env.HEX_WORLD_NOTIFY !== '0';
const lastNotified = new Map();               // sid -> ts, so PermissionRequest + Notification don't double-ping
function notify(sid, title, body) {
  if (!NOTIFY) return;
  const now = Date.now();
  if (now - (lastNotified.get(sid) || 0) < 15_000) return;
  lastNotified.set(sid, now);
  const text = String(body || '').slice(0, 200);
  const args = process.platform === 'darwin'
    ? ['osascript', ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv) sound name "Glass"', '-e', 'end run', title, text]]
    : ['notify-send', [title, text]];
  try { spawn(args[0], args[1], { stdio: 'ignore', detached: true }).on('error', () => {}).unref(); } catch { /* no notifier */ }
}
const nameOf = (sid) => { const w = worlds[sid]; return (w && (titleFor(w) || (w.cwd && path.basename(w.cwd)))) || sid.slice(0, 8); };

// ---- only live sessions: find each session's `claude` process, drop the world when it dies ----------
// The hook sends its parent pid; Claude Code runs hooks as its (grand)children, so walk up until the
// process named `claude`. Done once per session, before answering the hook (the chain must still exist).
// ponytail: macOS/Linux only (ps); pid reuse is ignored. Windows falls back to SessionEnd + the 12h timeout.
const psParent = (pid) => new Promise((resolve) => execFile('ps', ['-o', 'ppid=,comm=', '-p', String(pid)], { timeout: 500 }, (err, out) => {
  const m = !err && /^\s*(\d+)\s+(.+?)\s*$/.exec(out || '');
  resolve(m ? { ppid: Number(m[1]), comm: path.basename(m[2]) } : null);
}));
async function claudePidFrom(pid) {
  for (let i = 0; i < 6 && pid > 1; i++) {
    const info = await psParent(pid);
    if (!info) return null;
    if (/^claude(\.exe)?$/i.test(info.comm)) return pid;
    pid = info.ppid;
  }
  return null;
}
const pidLookups = new Set();                 // sessions with a lookup in flight
async function learnPid(sid, hookPpid) {
  const w = worlds[sid];
  if (!w || w.pid || !(hookPpid > 1) || !TRACK_PROCS || pidLookups.has(sid)) return;
  pidLookups.add(sid);
  try { const pid = await claudePidFrom(hookPpid); if (pid && worlds[sid]) worlds[sid].pid = pid; } finally { pidLookups.delete(sid); }
}
// Running `claude` processes by working folder (ps + lsof), for sessions we have no pid for yet.
const run = (cmd, args) => new Promise((resolve) => execFile(cmd, args, { timeout: 3000 }, (err, out) => resolve(err ? null : out)));
async function claudeProcsByCwd() {
  const ps = await run('ps', ['-ax', '-o', 'pid=,comm=']);
  if (ps === null) return null;
  const pids = ps.split('\n').map((l) => /^\s*(\d+)\s+(.+?)\s*$/.exec(l)).filter((m) => m && /^claude(\.exe)?$/i.test(path.basename(m[2]))).map((m) => m[1]);
  const map = new Map();
  if (!pids.length) return map;
  const lsof = await run('lsof', ['-a', '-d', 'cwd', '-Fpn', '-p', pids.join(',')]);
  if (lsof === null) return null;                // can't see cwds → decide nothing
  let pid = null;
  for (const line of lsof.split('\n')) {
    if (line[0] === 'p') pid = Number(line.slice(1));
    else if (line[0] === 'n' && pid) (map.get(line.slice(1)) || map.set(line.slice(1), []).get(line.slice(1))).push(pid);
  }
  return map;
}
async function reconcile() {
  if (!TRACK_PROCS || !Object.values(worlds).some((w) => !w.pid)) return;
  const procs = await claudeProcsByCwd();
  if (procs && reconcilePids(worlds, procs)) broadcast();
}
const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

// ---- persistence (#3): debounced atomic save; restored at boot -------------------------------
let saveTimer = null;
function scheduleSave(delay = 1000) {         // event changes save within 1s; timeline-only ticks within 30s
  if (!isMain || saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try { fs.writeFileSync(STATE_FILE + '.tmp', JSON.stringify(toSaved(worlds))); fs.renameSync(STATE_FILE + '.tmp', STATE_FILE); } catch { /* best effort */ }
  }, delay);
}

// ---- answer permission prompts from the board (#4) ---------------------------------------------
// hooks/hook.js holds Claude Code's PermissionRequest hook open on POST /permission. We wait for a
// click (POST /permission/decide) up to PERMISSION_WAIT, then answer {} = no decision, which leaves
// the normal terminal prompt. With no board open we answer {} at once, so nothing is ever delayed
// for nobody.
const pendingPerms = new Map();               // id -> { sid, res, timer, input, tool, agent }
// decision: null (no answer → terminal prompt) | { behavior, updatedInput? } — relayed as-is by the hook.
function settlePermission(id, decision) {
  const pp = pendingPerms.get(id);
  if (!pp) return false;
  pendingPerms.delete(id); clearTimeout(pp.timer);
  const w = worlds[pp.sid];
  if (w && w.permission && w.permission.id === id) w.permission = null;
  try { pp.res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(decision || {})); } catch { /* hook gone */ }
  broadcast();
  return true;
}
// You answered in the terminal (or Claude moved on): the same tool finished, or the turn ended /
// restarted → the held card is moot; release it so it can't linger.
function releaseIfMovedOn(sid, eventName, p) {
  for (const [id, pp] of pendingPerms) {
    if (pp.sid !== sid) continue;
    const sameTool = eventName === 'PostToolUse' && p.tool_name === pp.tool && (p.agent_id || null) === pp.agent;
    if (sameTool || eventName === 'Stop' || eventName === 'UserPromptSubmit' || eventName === 'SessionEnd') settlePermission(id, null);
  }
}
const clip = (v, n) => String(v == null ? '' : v).slice(0, n);
// What the card shows. AskUserQuestion is Claude asking YOU a multiple-choice question (it goes through
// the same PermissionRequest hook), so ship the questions + options; other tools get their command.
function permissionView(p) {
  const i = p.tool_input || {};
  if (p.tool_name === 'AskUserQuestion' && Array.isArray(i.questions)) {
    return { questions: i.questions.slice(0, 6).map((q) => ({
      question: clip(q.question, 2000), header: clip(q.header, 40), multiSelect: !!q.multiSelect,
      options: (q.options || []).slice(0, 8).map((o) => ({ label: clip(o.label, 200), description: clip(o.description, 600) })),
    })) };
  }
  return { summary: clip(cmdSummary(p.tool_name, i), 2000), description: clip(i.description, 300) };
}

// ---- transport ----------------------------------------------------------
const wss = new WebSocketServer({ noServer: true }); // wss.clients tracks open sockets

function serialize() {
  const out = {};
  const now = Date.now();
  for (const [sid, w] of Object.entries(worlds)) {
    const workers = {};
    for (const [aid, wk] of Object.entries(w.workers)) workers[aid] = serializeUnit(wk);
    out[sid] = {
      status: w.status, title: titleFor(w), cwd: w.cwd, transcriptPath: w.transcriptPath,
      source: w.source, lastSeen: w.lastSeen, main: serializeUnit(w.main), workers,
      attention: w.attention || null,          // "needs you": {reason,message,since} | null
      permission: w.permission || null,        // a prompt the board can answer: {id,tool,summary,since} | null
      stuck: !!w._stuck,                        // maintained by the watchdog
      // finish/error timestamps ship only while fresh, so a reconnecting client can't re-flash.
      finishedAt: w.finishedAt && now - w.finishedAt < FLASH_TTL ? w.finishedAt : null,
      lastError: w.lastError && now - w.lastError < FLASH_TTL ? w.lastError : null,
    };
  }
  return out;
}
function snapshot() { return JSON.stringify({ type: 'state', ts: Date.now(), worlds: serialize() }); }
function broadcast() {
  const msg = snapshot();
  for (const ws of wss.clients) { try { ws.send(msg); } catch { /* dropped client */ } }
  scheduleSave();
}

// Transcripts hold your code + prompts: only answer requests addressed to this machine by a local
// name (blocks DNS-rebinding), and only accept WebSockets from our own page (browsers let ANY site
// open ws://localhost). The hook sends no Origin, so it's unaffected.
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
const isLocalHost = (h) => LOCAL_HOST.test(h || '');
const isLocalOrigin = (o) => { if (!o) return true; try { return isLocalHost(new URL(o).host); } catch { return false; } };

const json = (res, code, obj) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(obj));
function readJson(req, cb) {
  let body = '';
  req.setEncoding('utf8');                     // decode across chunks (no split multi-byte chars)
  req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
  req.on('end', () => { let p = null; try { p = JSON.parse(body || '{}'); } catch { /* malformed */ } cb(p && typeof p === 'object' ? p : null); });
}

const server = http.createServer((req, res) => {
  if (!isLocalHost(req.headers.host)) { res.writeHead(403).end(); return; }
  // POSTs change state (and /permission/decide approves tool calls): refuse other sites' pages. A
  // foreign page can't forge Origin, and its JSON POST needs a CORS preflight we never answer.
  if (req.method === 'POST' && !isLocalOrigin(req.headers.origin)) { res.writeHead(403).end(); return; }
  const urlPath = req.url.split('?')[0];
  if (req.method === 'POST' && urlPath === '/event') {
    readJson(req, async (p) => {
      if (p) {
        const eventName = req.headers['x-hook-event'] || p.hook_event_name || 'UNKNOWN';
        const before = worlds[p.session_id] && worlds[p.session_id].attention;
        releaseIfMovedOn(p.session_id, eventName, p);
        if (applyEvent(worlds, eventName, p)) broadcast();
        await learnPid(p.session_id, Number(req.headers['x-hook-ppid']));
        const w = worlds[p.session_id];
        if (w && w.attention && w.attention.reason === 'permission' && !(before && before.reason === 'permission')) {
          notify(p.session_id, `🔔 Needs you — ${nameOf(p.session_id)}`, w.attention.message || 'Waiting for permission');
        }
      }
      res.writeHead(204).end();                // never 500 the agent's hook
    });
    return;
  }
  if (req.method === 'POST' && urlPath === '/permission') {
    readJson(req, async (p) => {
      if (!p || !p.session_id) { json(res, 200, {}); return; }
      const sid = p.session_id;
      const w = ensureWorld(worlds, sid, p);
      await learnPid(sid, Number(req.headers['x-hook-ppid']));
      const view = permissionView(p);
      const message = view.questions ? `Question: ${view.questions[0].question}` : `${p.tool_name || 'tool'}${view.summary ? ': ' + view.summary : ''}`;
      w.attention = { reason: 'permission', message, since: Date.now() };
      notify(sid, `🔔 Needs you — ${nameOf(sid)}`, message);
      if (!wss.clients.size) { broadcast(); json(res, 200, {}); return; } // nobody to click → terminal prompt now
      const id = randomUUID();
      w.permission = { id, tool: p.tool_name || 'tool', ...view, since: Date.now() };
      pendingPerms.set(id, { sid, res, input: p.tool_input || {}, tool: p.tool_name, agent: p.agent_id || null,
        timer: PERMISSION_WAIT ? setTimeout(() => settlePermission(id, null), PERMISSION_WAIT) : null });
      res.on('close', () => settlePermission(id, null)); // hook killed / Claude moved on → drop the card
      broadcast();
    });
    return;
  }
  if (req.method === 'POST' && urlPath === '/permission/decide') {
    if (!/^application\/json\b/.test(req.headers['content-type'] || '')) { res.writeHead(415).end(); return; }
    readJson(req, (p) => {
      const pp = p && pendingPerms.get(p.id);
      let decision;
      if (!pp) decision = undefined;
      else if (p.behavior === 'terminal') decision = null;                 // release now → normal prompt
      else if (p.behavior === 'deny') decision = { behavior: 'deny', message: 'Denied from the Hex-World board' };
      else if (p.behavior === 'allow' && p.answers && typeof p.answers === 'object') {
        // Answering a question = allow the tool with its input plus the chosen answers, the same
        // { questions, answers: { <question>: <label> } } shape Claude Code records when you answer.
        const answers = {};
        for (const [q, a] of Object.entries(p.answers)) answers[clip(q, 2000)] = clip(a, 2000);
        decision = { behavior: 'allow', updatedInput: { ...pp.input, answers } };
      } else if (p.behavior === 'allow') decision = { behavior: 'allow' };
      const ok = decision !== undefined && settlePermission(p.id, decision);
      res.writeHead(ok ? 204 : 404).end();
    });
    return;
  }
  if (req.method === 'GET' && urlPath === '/stats') {
    // One session (+ its subagents): totals and the last 2h in 5-minute buckets — for the hover graphs.
    const sid = new URL(req.url, 'http://localhost').searchParams.get('session');
    const w = sid && worlds[sid];
    if (!w) { json(res, 404, { error: 'unknown session' }); return; }
    const states = sessionFiles(w.transcriptPath).map(readState).filter(Boolean);
    const sum = (k) => states.reduce((a, st) => a + (st[k] || 0), 0);
    json(res, 200, { cost: sum('cost'), costPartial: states.some((st) => st.unpriced), tools: sum('tools'), activeMs: sum('activeMs'),
      subagents: Math.max(0, states.length - 1), series: recentSeries(states, Date.now(), 24), timeline: timelineSeries(w, Date.now(), 24) });
    return;
  }
  if (req.method === 'GET' && urlPath === '/summary') {
    const days = Math.min(60, Math.max(1, Number(new URL(req.url, 'http://localhost').searchParams.get('days')) || 14));
    // + live sessions' working/thinking/blocked/idle over the last 2h (sampled by the server, so it
    // only covers time the server was running).
    const live = Object.entries(worlds).map(([sid, w]) => ({ sid, title: titleFor(w), cwd: w.cwd, status: w.status, timeline: timelineSeries(w, Date.now(), 24) }));
    buildSummary(days).then((d) => json(res, 200, { ...d, live, activity: ACTIVITY }), (e) => json(res, 500, { error: String(e && e.message || e) }));
    return;
  }
  if (req.method === 'GET' && urlPath === '/state') {
    res.writeHead(200, { 'content-type': 'application/json' }).end(snapshot());
    return;
  }
  if (req.method === 'GET' && urlPath === '/chat') {
    // Recent conversation as structured entries + stats, for the live mirror.
    // ?session=<id>&agent=<agent_id|main> — a subagent uses its own transcript when we have it.
    const q = new URL(req.url, 'http://localhost').searchParams;
    const sid = q.get('session'); const agent = q.get('agent');
    const w = sid && worlds[sid];
    let tpath = null, fallback = false, title = null;
    if (w) {
      title = titleFor(w);
      if (agent && agent !== 'main') {
        // Each subagent has its own transcript. Claude Code only reports its path (agent_transcript_path)
        // at SubagentStop — i.e. AFTER the run — so for a LIVE subagent we construct the path from the
        // session transcript: <session>.jsonl → <session>/subagents/agent-<id>.jsonl (its on-disk layout,
        // confirmed against the hook-event log). The file is written continuously during the run.
        const wk = w.workers[agent];
        let sub = wk && wk.transcriptPath;
        if (!sub && w.transcriptPath) {
          const cand = path.join(path.dirname(w.transcriptPath), path.basename(w.transcriptPath, '.jsonl'), 'subagents', `agent-${agent}.jsonl`);
          try { if (fs.existsSync(cand)) sub = cand; } catch { /* fall back to session transcript */ }
        }
        tpath = sub || w.transcriptPath;
        fallback = !sub;                                  // no subagent transcript found → showing session's
      } else {
        tpath = w.transcriptPath;
      }
    }
    const d = tpath && readDigest(tpath);
    res.writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ title, entries: (d && d.entries) || [], fallback, stats: (d && d.stats) || null }));
    return;
  }
  // Runtime toggles the browser reads once at boot (env → client, since the browser can't see
  // process.env). worldAnim: the animated hex platforms are OFF by default (calm static art);
  // set HEX_WORLD_ANIM=1 in the server's environment to switch the animated backdrops on.
  // Intercept before the /config/ static handler — this file doesn't exist on disk.
  // osNotify: the server raises permission alerts itself, so the page skips its own for those.
  if (req.method === 'GET' && urlPath === '/config/runtime.json') {
    json(res, 200, { worldAnim: process.env.HEX_WORLD_ANIM === '1', osNotify: NOTIFY, permissionWait: PERMISSION_WAIT });
    return;
  }
  // Static: client from public/, shared config from config/, libraries from node_modules.
  if (urlPath.startsWith('/vendor/')) { serveStatic(res, VENDOR, urlPath.slice(8)); return; }
  if (urlPath.startsWith('/hljs/')) { serveStatic(res, HLJS, urlPath.slice(6)); return; }
  if (urlPath.startsWith('/marked/')) { serveStatic(res, MARKED, urlPath.slice(8)); return; }
  if (urlPath.startsWith('/dompurify/')) { serveStatic(res, DOMPURIFY, urlPath.slice(11)); return; }
  if (urlPath.startsWith('/config/')) { serveStatic(res, CONFIG, urlPath.slice(8)); return; }
  serveStatic(res, PUBLIC, urlPath === '/' ? 'index.html' : urlPath);
});

function contentType(f) {
  if (f.endsWith('.mjs') || f.endsWith('.js')) return 'text/javascript';
  if (f.endsWith('.css')) return 'text/css';
  if (f.endsWith('.json')) return 'application/json';
  if (f.endsWith('.png')) return 'image/png';
  if (f.endsWith('.webp')) return 'image/webp';
  if (f.endsWith('.svg')) return 'image/svg+xml';
  return 'text/html';
}
// Serve one file from `root`, with a path-traversal guard (file must stay strictly under root).
function serveStatic(res, root, rel) {
  const file = path.join(root, path.normalize(rel).replace(/^([/\\])+/, ''));
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (file !== root && !file.startsWith(rootWithSep)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, { 'content-type': contentType(file) }).end(data);
  });
}

server.on('upgrade', (req, socket, head) => {
  if (!isLocalHost(req.headers.host) || !isLocalOrigin(req.headers.origin)) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => {   // live state broadcast channel
    ws.send(snapshot()); // hand the newcomer the current world immediately
    // Last board tab gone → nobody can click; hand every held prompt back to its terminal.
    ws.on('close', () => { if (!wss.clients.size) for (const id of [...pendingPerms.keys()]) settlePermission(id, null); });
  });
});

// Only boot (bind the port + start the watchdog timer) when run directly, so importing this
// module for tests/tooling doesn't start a server or keep the process alive.
if (isMain) {
  try { fromSaved(JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')), worlds); } catch { /* first run / unreadable → start empty */ }
  reconcile();                                   // drop restored sessions whose terminal is already gone
  setInterval(reconcile, 20_000);
  let lastTick = Date.now();
  setInterval(() => {
    const now = Date.now(), dt = Math.min(now - lastTick, 5000); // cap: a sleeping laptop isn't "idle for hours"
    lastTick = now;
    for (const w of Object.values(worlds)) recordActivity(w, now, dt);
    // Closed terminal → its claude process is gone → drop the world (and hand back any held prompt).
    if (TRACK_PROCS) for (const [id, pp] of pendingPerms) { const w = worlds[pp.sid]; if (w && w.pid && !isAlive(w.pid)) settlePermission(id, null); }
    if (watchdog(worlds, now, TRACK_PROCS ? isAlive : null)) broadcast(); else scheduleSave(30_000);
  }, 2000);
  server.listen(PORT, HOST, () => {
    console.log(`Hex-World event spine listening on http://localhost:${PORT}`);
    console.log(`Open that URL in a browser; hooks POST to /event. Restored ${Object.keys(worlds).length} session(s).`);
  });
}

export { server, worlds }; // for tests
