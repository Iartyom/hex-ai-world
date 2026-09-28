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
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { applyEvent, watchdog, serializeUnit, parseTranscript, FLASH_TTL } from './state.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8787;
const PUBLIC = path.resolve(__dirname, '..', 'public');
const CONFIG = path.resolve(__dirname, '..', 'config'); // browser imports the shared config from here
const VENDOR = path.resolve(__dirname, '..', 'node_modules', 'pixi.js', 'dist'); // PixiJS served locally
const HLJS = path.resolve(__dirname, '..', 'node_modules', '@highlightjs', 'cdn-assets'); // syntax highlighter for the mirror
const MARKED = path.resolve(__dirname, '..', 'node_modules', 'marked', 'lib');           // markdown renderer for assistant text
const DOMPURIFY = path.resolve(__dirname, '..', 'node_modules', 'dompurify', 'dist');    // sanitizes markdown HTML before it hits the DOM

/** worlds[sessionId] = { status, cwd, transcriptPath, source, lastSeen, main, workers } */
const worlds = Object.create(null);

// --- transcript digest (fs + mtime cache around the pure parseTranscript) -----
const txCache = new Map();                    // transcriptPath -> { mtime, title, entries, stats }
function readDigest(p) {
  if (!p) return null;
  let mtime;
  try { mtime = fs.statSync(p).mtimeMs; } catch { return null; } // no transcript yet
  const hit = txCache.get(p);
  if (hit && hit.mtime === mtime) return hit;
  let parsed;
  try { parsed = parseTranscript(fs.readFileSync(p, 'utf8')); } catch { parsed = { title: null, entries: [], stats: null }; }
  const digest = { mtime, ...parsed };
  txCache.set(p, digest);
  return digest;
}

// Cheap title lookup for serialize() (runs per world on EVERY broadcast). Must NOT re-parse the
// whole transcript here — during an active turn the mtime changes on nearly every event. Tail-read
// a little and cache with a short TTL: ai-title is written early and rarely changes.
const TITLE_TTL = 15_000;
const titleCache = new Map();                 // path -> { at, title }
function readTitle(p) {
  if (!p) return null;
  const now = Date.now();
  const hit = titleCache.get(p);
  if (hit && now - hit.at < TITLE_TTL) return hit.title;
  let title = null;
  try {
    const buf = fs.readFileSync(p, 'utf8');
    const tail = buf.length > 131072 ? buf.slice(-131072) : buf; // last ~128KB is plenty for ai-title
    for (const line of tail.split('\n')) {
      if (!line || line.indexOf('ai-title') === -1) continue;
      try { const o = JSON.parse(line); if (o.type === 'ai-title' && o.aiTitle) title = o.aiTitle; } catch { /* partial line */ }
    }
    if (title === null) { const d = readDigest(p); title = (d && d.title) || null; } // tail missed it → full (cached) parse once
  } catch { title = null; }
  titleCache.set(p, { at: now, title });
  return title;
}
function titleFor(w) { return readTitle(w.transcriptPath); }

// --- Warp "resume session" launch config -------------------------------------
function warpLaunchDir() {
  if (process.platform === 'win32') {
    const appdata = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appdata, 'warp', 'Warp', 'data', 'launch_configurations');
  }
  return path.join(os.homedir(), '.warp', 'launch_configurations'); // macOS + Linux
}
// Launch a URI through the OS's registered protocol handler (warp://…), from the SERVER — avoids
// Chrome's external-protocol prompt/blocking that made click-to-resume silently do nothing.
function openExternal(uri) {
  try {
    if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', uri], { detached: true, stdio: 'ignore' }).unref();
    else if (process.platform === 'darwin') spawn('open', [uri], { detached: true, stdio: 'ignore' }).unref();
    else spawn('xdg-open', [uri], { detached: true, stdio: 'ignore' }).unref();
    return true;
  } catch { return false; }
}
function writeResumeConfig(cwd, sid) {
  const dir = warpLaunchDir();
  fs.mkdirSync(dir, { recursive: true });
  const q = (s) => `'${String(s).replace(/'/g, "''")}'`; // single-quoted YAML: backslashes stay literal (Windows paths)
  const yaml = [
    '---', 'name: hexworld-resume', 'windows:', '  - tabs:',
    `      - title: ${q('resume ' + sid.slice(0, 8))}`,
    '        layout:', `          cwd: ${q(cwd)}`, '          commands:',
    `            - exec: ${q('claude --resume ' + sid)}`,
    '        color: Blue', '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'hexworld-resume.yaml'), yaml);
}

// ---- transport ----------------------------------------------------------
const wss = new WebSocketServer({ noServer: true });
const clients = new Set();

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
  for (const ws of clients) { try { ws.send(msg); } catch { /* dropped client */ } }
}

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/event') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try {
        const p = JSON.parse(body || '{}');
        const eventName = req.headers['x-hook-event'] || p.hook_event_name || 'UNKNOWN';
        if (applyEvent(worlds, eventName, p)) broadcast();
      } catch { /* malformed event: ignore, never 500 the agent's hook */ }
      res.writeHead(204).end();
    });
    return;
  }
  if (req.method === 'GET' && req.url === '/state') {
    res.writeHead(200, { 'content-type': 'application/json' }).end(snapshot());
    return;
  }
  if (req.method === 'GET' && req.url.split('?')[0] === '/chat') {
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
  if (req.method === 'GET' && req.url.split('?')[0] === '/resume') {
    // Write a Warp launch config that resumes this session, then LAUNCH it from the server.
    const sid = new URL(req.url, 'http://localhost').searchParams.get('session');
    const w = sid && worlds[sid];
    if (!w || !w.cwd) { res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'unknown session' })); return; }
    try {
      writeResumeConfig(w.cwd, sid);
      const launched = openExternal('warp://launch/hexworld-resume');
      console.log(`[resume] ${sid.slice(0, 8)} in ${w.cwd} — launched=${launched}`);
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ launched }));
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: String(e && e.message || e) }));
    }
    return;
  }
  // Runtime toggles the browser reads once at boot (env → client, since the browser can't see
  // process.env). worldAnim: the animated hex platforms are OFF by default (calm static art);
  // set HEX_WORLD_ANIM=1 in the server's environment to switch the animated backdrops on.
  // Intercept before the /config/ static handler — this file doesn't exist on disk.
  if (req.method === 'GET' && req.url.split('?')[0] === '/config/runtime.json') {
    res.writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ worldAnim: process.env.HEX_WORLD_ANIM === '1' }));
    return;
  }
  // Static: client from public/, shared config from config/, libraries from node_modules.
  const urlPath = req.url.split('?')[0];
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
  wss.handleUpgrade(req, socket, head, (ws) => {   // live state broadcast channel
    clients.add(ws);
    ws.send(snapshot()); // hand the newcomer the current world immediately
    ws.on('close', () => clients.delete(ws));
    ws.on('error', () => clients.delete(ws));
  });
});

// Only boot (bind the port + start the watchdog timer) when run directly, so importing this
// module for tests/tooling doesn't start a server or keep the process alive.
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  setInterval(() => { if (watchdog(worlds, Date.now())) broadcast(); }, 2000);
  server.listen(PORT, () => {
    console.log(`Hex-World event spine listening on http://localhost:${PORT}`);
    console.log('Open that URL in a browser; hooks POST to /event.');
  });
}

export { server, worlds, serialize, readDigest }; // for tooling/tests if ever needed
