/*
 * Pure event-spine + transcript logic for the Hex-World server, with NO I/O and no side effects,
 * so it's unit-testable under Node (see test/state.test.mjs). server.mjs is the thin shell that
 * owns the `worlds` object, does the HTTP/WS/fs work, and calls into here.
 *
 * Design rules (proven at GATE 0): one worker per subagent keyed by agent_id; the main agent is
 * events with NO agent_id. Events are unordered / can be orphaned, so every transition is
 * idempotent (set/clear, never push/pop) and the watchdog heals stale/dropped events.
 */
import { categoryFor } from '../config/behaviors.mjs';
import { TOOLS, MULTIEDIT_CAP } from '../config/tools.mjs';
import { costParts } from '../config/pricing.mjs';
import { flagCount } from '../config/quality.mjs';

// Watchdog thresholds (ms). Loose enough to survive normal gaps.
export const WORKER_GONE_AFTER = 60_000;            // an IDLE subagent this quiet → removed (in-flight ones kept)
export const TOOL_MAX_INFLIGHT = 15 * 60_000;       // a tool pending longer than this → assume its Post dropped
export const WORLD_REMOVE_AFTER = 12 * 60 * 60_000; // total silence this long → remove the whole world
export const STUCK_AFTER = 3 * 60_000;              // a tool in-flight this long with no Post → world "stuck"
export const THINK_MAX = 90_000;                    // "thinking" (busy, no tool) this long with no events → idle
export const FLASH_TTL = 6_000;                     // finish/error timestamps only ship while this fresh

// ---- transcript parsing (pure: operates on the raw JSONL text) ---------------
export const cap = (s, n) => (typeof s === 'string' && s.length > n ? s.slice(0, n) + '\n… (truncated)' : (typeof s === 'string' ? s : ''));

// One-line summary of a tool call (for the robot's floating ticker) — first non-empty summary field.
export function cmdSummary(name, input) {
  const i = input || {};
  const meta = TOOLS[name];
  if (!meta) return '';
  for (const f of meta.summary) if (i[f]) return i[f];
  return '';
}

// Only the fields the mirror renders, size-capped so /chat stays reasonable (driven by config/tools).
export function pickToolInput(name, input) {
  const i = input || {};
  const meta = TOOLS[name];
  if (!meta) return {};
  if (meta.pick === 'multiedit') {
    return { file_path: i.file_path, edits: (i.edits || []).slice(0, 25).map((e) => ({ old_string: cap(e.old_string, MULTIEDIT_CAP), new_string: cap(e.new_string, MULTIEDIT_CAP) })) };
  }
  const out = {};
  for (const [outField, spec] of Object.entries(meta.pick)) {
    const v = i[spec.from];
    out[outField] = spec.cap ? cap(v, spec.cap) : v;
  }
  return out;
}
export function resultText(content) {
  let t = '';
  if (typeof content === 'string') t = content;
  else if (Array.isArray(content)) t = content.map((b) => (typeof b === 'string' ? b : (b && b.type === 'text' ? b.text : ''))).join('\n');
  else if (content && typeof content.text === 'string') t = content.text;
  return cap(t, 8000);
}

export const CHAT_TAIL = 90;                         // how many recent entries the mirror keeps

// Transcripts are append-only JSONL, so the server parses them INCREMENTALLY: keep one accumulator
// per file and feed it only the newly appended lines. Pure (text in, data out).
export const BUCKET_MS = 5 * 60_000;                 // graph resolution (5-minute buckets)
export const IDLE_GAP = 5 * 60_000;                  // a gap longer than this between lines isn't "active" time
const MAX_BUCKETS = 288;                             // keep 24h of 5-minute activity buckets per session
export const dayKey = (ts) => new Date(ts).toLocaleDateString('sv');  // local YYYY-MM-DD

export function newTranscriptState() {
  return { title: null, cwd: null, entries: [], startTs: null, endTs: null, lastTs: null, tools: 0,
    tokIn: 0, tokOut: 0, tokCR: 0, tokCW: 0, cost: 0, unpriced: 0, activeMs: 0, files: new Set(),
    turns: 0, ctx: 0,                                 // model calls; context size of the LATEST call
    seenMsg: new Set(),                               // message ids already costed (see feedTranscript)
    days: new Map(),                                  // 'YYYY-MM-DD' -> newDay()
    out: newOutcome() };                              // shipped / checked / wasted — see trackOutcome
}
// Per day: cost split by what it paid for (see costParts), model calls, and the context they re-sent.
// Plus outcome signals: wasted tool runs by cause, time spent approving edits, the agent's waits for your reply.
const newDay = () => ({ tools: 0, cost: 0, activeMs: 0, in: 0, out: 0, read: 0, write: 0, turns: 0, ctx: 0,
  prs: 0, errs: {}, approveMs: 0, waits: [] });
const slot = (m, k, init) => { let v = m.get(k); if (!v) m.set(k, (v = init())); return v; };

// Fold complete JSONL lines into `s`. Malformed/partial lines are skipped.
export function feedTranscript(s, text) {
  for (const line of String(text).split('\n')) {
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'ai-title' && o.aiTitle) { s.title = o.aiTitle; continue; } // latest wins
    if (!s.cwd && o.cwd) s.cwd = o.cwd;
    const ts = o.timestamp ? Date.parse(o.timestamp) : NaN;
    const has = !isNaN(ts);
    if (has) {
      if (s.startTs === null || ts < s.startTs) s.startTs = ts;
      if (s.endTs === null || ts > s.endTs) s.endTs = ts;
      const gap = s.lastTs === null ? 0 : ts - s.lastTs;
      if (gap > 0 && gap <= IDLE_GAP) { s.activeMs += gap; slot(s.days, dayKey(ts), newDay).activeMs += gap; }
      if (s.lastTs === null || ts > s.lastTs) s.lastTs = ts;
    }
    const day = has ? slot(s.days, dayKey(ts), newDay) : null;
    // Claude Code writes ONE line per content block of a response, each repeating the full `usage` —
    // count a message's usage once (by message.id), or tokens/cost come out ~2-3× too high.
    const msg = o.message;
    const usage = msg && msg.usage;
    if (usage && !(msg.id && s.seenMsg.has(msg.id))) {
      if (msg.id) s.seenMsg.add(msg.id);
      s.tokIn += usage.input_tokens || 0; s.tokOut += usage.output_tokens || 0; s.tokCR += usage.cache_read_input_tokens || 0; s.tokCW += usage.cache_creation_input_tokens || 0;
      // Context = everything the model had to read this call; it's what makes a long session expensive.
      const ctx = (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
      if (msg.model !== '<synthetic>') {                // turns + context count even when the model has no known price
        s.turns++; s.ctx = ctx;
        if (day) { day.turns++; day.ctx += ctx; }
      }
      const p = costParts(msg.model, usage);
      if (p === null) s.unpriced++;
      else if (msg.model !== '<synthetic>') {
        const c = p.in + p.out + p.read + p.write;
        s.cost += c;
        if (day) { day.cost += c; for (const k of ['in', 'out', 'read', 'write']) day[k] += p[k]; }
      }
    }
    if (has) trackOutcome(s.out, o, ts, day);
    const content = o.message && o.message.content;
    if (o.type === 'user') {
      if (typeof content === 'string') { if (content.trim()) s.entries.push({ k: 'user', t: content.trim() }); }
      else if (Array.isArray(content)) {
        for (const b of content) {
          if (!b) continue;
          if (b.type === 'text' && b.text && b.text.trim()) s.entries.push({ k: 'user', t: b.text.trim() });
          else if (b.type === 'tool_result') s.entries.push({ k: 'result', id: b.tool_use_id || null, text: resultText(b.content), err: !!b.is_error });
        }
      }
    } else if (o.type === 'assistant' && Array.isArray(content)) {
      for (const b of content) {
        if (!b) continue;
        if (b.type === 'text' && b.text && b.text.trim()) s.entries.push({ k: 'say', t: b.text.trim() });
        else if (b.type === 'thinking' && b.thinking && b.thinking.trim()) s.entries.push({ k: 'think', t: b.thinking.trim() });
        else if (b.type === 'tool_use') {
          s.tools++; if (day) day.tools++;
          const fp = b.input && (b.input.file_path || b.input.notebook_path);
          if (fp && (b.name === 'Edit' || b.name === 'MultiEdit' || b.name === 'Write' || b.name === 'NotebookEdit')) s.files.add(fp);
          s.entries.push({ k: 'tool', id: b.id || null, name: b.name || 'tool', input: pickToolInput(b.name, b.input) });
        }
      }
    }
  }
  if (s.entries.length > 2 * CHAT_TAIL) s.entries = s.entries.slice(-CHAT_TAIL); // bounded memory
}

// ---- outcomes: did work ship, was it checked first, what runs were wasted, what it cost your time ----
// Per transcript we only RECORD events (edits with their file, checks that succeeded, commits that
// succeeded); summarize() decides per SESSION (main + subagents) what each commit shipped and whether a
// check ran after its last edit — subagents often write the code the main agent commits.
// "Checked" = a test / lint / build / typecheck that exited 0 after the last edit, before the commit.
// ponytail: regex over shell commands (quoted text stripped) + known skills; add your runner here if
// it's missed. A check piped into grep/tail reports the pipe's exit code, not the tests'.
const CHECK_RE = /\b(npm (run )?(test|lint|build|typecheck|check)|npx (jest|vitest|tsc|eslint|nx)|nx (test|lint|run|affected)|nxtest|nxlint|jest|vitest|tsc\b|eslint|pytest|go (test|vet|build)|cargo (test|check|build)|node --test|dotnet (test|build)|mvn (test|verify)|gradle\w* (test|check|build)|make (test|check))/;
const CHECK_SKILL = /lint-and-test|verify|code-review/;
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const MAX_EVENTS = 5000;                         // per transcript, per list — bounded memory
const newOutcome = () => ({ pending: new Map(), lastAssistant: 0,
  edits: [],                  // [ts, file] per edit call
  checks: [],                 // ts of each check that succeeded
  commits: [],                // { ts, msg } per commit that succeeded
  // Quality signals Anthropic's best practices name (code.claude.com/docs/en/best-practices):
  uncheckedEdits: 0,          // edits since the last test/lint/build — "if you can't verify it, don't ship it"
  recent: [],                 // your last RECENT_PROMPTS prompts: true = a correction (interrupt, reject, "no, …")
  compactions: 0,             // each one swaps detail for a summary
  branches: new Set() });     // git branches seen — more than one ≈ unrelated tasks in one context ("kitchen sink")
const RECENT_PROMPTS = 10;
// ponytail: phrase heuristic for "you're correcting it"; interrupts and rejected tool calls are exact.
const CORRECTION_RE = /^\s*(no\b|nope|wrong|that'?s not|not what|revert|undo|stop\b|why did you|you (broke|missed|forgot|didn'?t))/i;
const pushRecent = (x, corr) => { x.recent.push(corr); if (x.recent.length > RECENT_PROMPTS) x.recent.shift(); if (corr) x.correctionsTotal = (x.correctionsTotal || 0) + 1; };
/** Why a tool run was wasted, or null when it wasn't one (user rejects/interrupts are decisions, not waste). */
export function wasteCause(tool, text) {
  const t = String(text || '');
  if (/doesn't want to proceed|was rejected|interrupted by user/i.test(t)) return null;
  if (/hook error|blocked by .*hook/i.test(t)) return 'blocked by a hook';
  if (/auto mode classifier/i.test(t)) return 'blocked by the auto-mode classifier';
  if (/before you can access|must be connected|OIDC|not connected|failed to connect|extension disconnected|Streamable HTTP error|socket connection was closed|ECONNREFUSED/i.test(t)) return 'connector down / not logged in';
  if (/\b40[13]\b|Forbidden|Unauthorized|not installed on this/i.test(t)) return 'access denied by the service (401/403)';
  if (/InputValidationError|Input validation error|-32602|<tool_use_error>(?!.*(matches of the string|not found))/i.test(t)) return 'bad tool arguments';
  if (/has not been read yet|read it first|modified since/i.test(t)) return 'edit before reading the file';
  if (/String to replace not found|old_string|matches of the string to replace/i.test(t)) return 'edit text not found / ambiguous';
  if (/status:? 5\d\d|\b50[0-4]\b|status:? 4\d\d/i.test(t)) return 'service returned an error (4xx/5xx)';
  if (/Index check failed|COLLSCAN/i.test(t)) return 'guardrail refused (index check)';
  if (/timed? ?out/i.test(t)) return 'timeout';
  if (/ENOENT|No such file|does not exist/i.test(t)) return 'path not found';
  if (tool === 'Bash') return 'command failed';
  return 'other error';
}
// Shell text without quoted strings or heredoc bodies, so a commit message saying "bump eslint" isn't a check.
const bare = (cmd) => cmd.replace(/<<-?\s*['"]?(\w+)['"]?\n[\s\S]*?\n\s*\1/g, '').replace(/"(?:\\.|[^"\\])*"|'[^']*'/g, "''");
// `npm test && git commit …`: the commit only runs if the check passed — but not through ; || or a pipe.
const checkedChain = (cmd) => {
  const pre = bare(cmd).split(/\bgit commit\b/)[0], m = pre.match(CHECK_RE);
  return !!m && !/;|\|\||\||\n/.test(pre.slice(m.index));
};
const pushCapped = (arr, v) => { arr.push(v); if (arr.length > MAX_EVENTS) arr.splice(0, arr.length - MAX_EVENTS); };
const commitMsg = (cmd) => {
  const c = cmd.slice(cmd.search(/\bgit commit\b/));
  if (/--amend\b/.test(c) && /--no-edit\b/.test(c)) return '(amend, same message)';
  const m = c.match(/<<-?\s*['"]?(\w+)['"]?\n([\s\S]*?)\n\s*\1/) || c.match(/\s-[a-zA-Z]*m\s+(["'])([\s\S]*?)\1/);   // -m, -qm, -am …
  return (m ? m[2] : c).trim().split('\n')[0].slice(0, 90);
};
/** Fold one transcript line into the outcome accumulator `x` (and today's `day` slot). */
function trackOutcome(x, o, ts, day) {
  const content = o.message && o.message.content;
  if (o.gitBranch && !o.isSidechain) x.branches.add(o.gitBranch);
  if (o.isCompactSummary || o.subtype === 'compact_boundary') { x.compactions++; x.recent = []; return; }
  if (o.type === 'assistant') {
    x.lastAssistant = ts;
    if (!Array.isArray(content)) return;
    for (const b of content) {
      if (!b || b.type !== 'tool_use') continue;
      const cmd = (b.input && typeof b.input.command === 'string') ? b.input.command : '';
      const p = { name: b.name, ts };
      if (EDIT_TOOLS.has(b.name)) { x.uncheckedEdits++; pushCapped(x.edits, [ts, (b.input && (b.input.file_path || b.input.notebook_path)) || null]); }
      const isCommit = b.name === 'Bash' && /\bgit commit\b/.test(bare(cmd)) && !/--dry-run/.test(cmd);
      if (isCommit) { p.commit = { ts, msg: commitMsg(cmd) }; p.check = checkedChain(cmd); }
      else if ((b.name === 'Bash' && CHECK_RE.test(bare(cmd))) || (b.name === 'Skill' && CHECK_SKILL.test(JSON.stringify(b.input || {})))) p.check = true;
      if (b.name === 'Bash' && /\b(gh pr create|create-pr)\b/.test(cmd)) p.pr = true;
      if (b.id) x.pending.set(b.id, p);
    }
  } else if (o.type === 'user') {
    let rejected = false;                          // a rejected tool call also writes "[Request interrupted…]": count once
    if (Array.isArray(content)) for (const b of content) {
      if (!b || b.type !== 'tool_result') continue;
      const p = x.pending.get(b.tool_use_id); if (!p) continue;
      x.pending.delete(b.tool_use_id);
      const text = typeof b.content === 'string' ? b.content : JSON.stringify(b.content || '');
      if (!o.isSidechain && /doesn't want to proceed|was rejected/i.test(text)) { pushRecent(x, true); rejected = true; }
      if (b.is_error) { const c = wasteCause(p.name, text); if (c && day) day.errs[c] = (day.errs[c] || 0) + 1; continue; }
      if (p.check) { pushCapped(x.checks, p.ts); x.uncheckedEdits = 0; }  // a check counts only if it succeeded
      if (p.commit) pushCapped(x.commits, p.commit);
      if (p.pr && day) day.prs++;
      // Edits run instantly: a gap before their result is you deciding on the permission prompt.
      const g = ts - p.ts;
      if (EDIT_TOOLS.has(p.name) && g > 5000 && g < 3 * 3_600_000 && day) day.approveMs += g;
    }
    // A human prompt (not a tool result / meta / compaction / a subagent's brief): how long the agent had been waiting on you.
    const txt = typeof content === 'string' ? content : Array.isArray(content) ? content.filter((b) => b && b.type === 'text').map((b) => b.text).join('') : '';
    if (!o.isSidechain && !rejected && /\[Request interrupted by user/.test(txt)) pushRecent(x, true);
    const human = !o.isSidechain && txt.trim() && !o.isMeta && !o.isCompactSummary && !/^\s*(<|\[Request interrupted|Caveat:)/.test(txt);
    if (human) pushRecent(x, CORRECTION_RE.test(txt));
    if (human && x.lastAssistant) {
      const g = ts - x.lastAssistant;
      if (g > 0 && g < 3 * 3_600_000 && day) day.waits.push(Math.round(g / 1000));
    }
  }
  if (x.pending.size > 500) x.pending.clear();       // bounded: results that never came
}
/** The quality snapshot the hover shows for one transcript. */
export const qualityOf = (x) => ({ uncheckedEdits: x.uncheckedEdits, corrections: x.recent.filter(Boolean).length,
  recentPrompts: x.recent.length, compactions: x.compactions, branches: x.branches.size });

// Snapshot the accumulator as the /chat wire shape.
export function transcriptDigest(s) {
  const stats = { startTs: s.startTs, endTs: s.endTs, tools: s.tools, files: s.files.size, tokIn: s.tokIn, tokOut: s.tokOut,
    tokCacheRead: s.tokCR, tokCacheWrite: s.tokCW, tokTotal: s.tokIn + s.tokOut + s.tokCR + s.tokCW,
    cost: s.cost, costPartial: s.unpriced > 0, activeMs: s.activeMs };
  return { title: s.title, entries: s.entries.slice(-CHAT_TAIL), stats };
}

// Parse a whole transcript text → { title, entries, stats }.
export function parseTranscript(text) {
  const s = newTranscriptState();
  feedTranscript(s, text);
  return transcriptDigest(s);
}

// ---- unit + world state machine (operates on an explicit `worlds` object) ----
export function newUnit(now, agentType) {
  // lastCmd = summary of the last tool call (for the ticker). busy = "inside a turn" (true from
  // turn start until Stop) so the unit keeps working while Claude THINKS between tools.
  return { pending: new Map(), lastTool: null, lastCmd: null, busy: false, agentType: agentType || undefined, transcriptPath: null, lastSeen: now };
}
export function unitState(u) {
  if (u.pending.size) {
    let latest = null;
    for (const v of u.pending.values()) if (!latest || v.startedAt >= latest.startedAt) latest = v;
    return 'working:' + latest.cat;
  }
  if (u.busy) return 'working:think';                 // no tool in flight but mid-turn → thinking
  return 'idle';
}
export function markPre(u, toolUseId, tool, input, now) {
  const id = toolUseId || `anon:${now}:${Math.random().toString(36).slice(2)}`;
  u.pending.set(id, { tool, cat: categoryFor(tool), startedAt: now });
  u.lastTool = tool || u.lastTool;
  u.lastCmd = cmdSummary(tool, input) || null;  // never pair a new tool with the previous tool's command
  u.busy = true;
  u.lastSeen = now;
}
export function markPost(u, toolUseId, now) {
  if (toolUseId && u.pending.has(toolUseId)) {
    u.pending.delete(toolUseId);
  } else if (u.pending.size) {
    let oldestKey = null, oldest = Infinity;
    for (const [k, v] of u.pending) if (v.startedAt < oldest) { oldest = v.startedAt; oldestKey = k; }
    if (oldestKey !== null) u.pending.delete(oldestKey);
  }
  u.lastSeen = now;
}

export function ensureWorld(worlds, sessionId, p = {}, now = Date.now()) {
  let w = worlds[sessionId];
  if (!w) {
    w = worlds[sessionId] = {
      status: 'active', cwd: p.cwd || null, transcriptPath: p.transcript_path || null,
      source: p.source || null, lastSeen: now, main: newUnit(now), workers: Object.create(null),
    };
  }
  if (p.cwd) w.cwd = p.cwd;
  if (p.transcript_path) w.transcriptPath = p.transcript_path;
  return w;
}

/** Apply one hook event to `worlds`. Returns true if it was placeable. */
export function applyEvent(worlds, eventName, p) {
  const sessionId = p.session_id;
  if (!sessionId) return false;
  const now = Date.now();

  const w = ensureWorld(worlds, sessionId, p, now);
  w.lastSeen = now; w.status = 'active';
  if (eventName === 'SessionStart') { w.source = p.source || w.source; return true; }
  if (eventName !== 'Notification') w.attention = null; // any real activity clears "needs you"

  switch (eventName) {
    case 'Notification': {
      const msg = String(p.message || '');
      const nt = String(p.notification_type || '');
      const reason = (nt === 'permission_prompt' || /permission|approve|allow/i.test(msg)) ? 'permission' : 'idle';
      w.attention = { reason, message: msg, since: now };
      return true;
    }
    case 'UserPromptSubmit':
      w.main.busy = true;
      return true;
    case 'PreToolUse':
    case 'PostToolUse': {
      let unit;
      if (p.agent_id) {
        unit = w.workers[p.agent_id] || (w.workers[p.agent_id] = newUnit(now, p.agent_type));
        if (p.agent_type) unit.agentType = p.agent_type;
        if (p.agent_transcript_path) unit.transcriptPath = p.agent_transcript_path;
      } else {
        unit = w.main;
      }
      if (eventName === 'PreToolUse') markPre(unit, p.tool_use_id, p.tool_name, p.tool_input, now);
      else {
        markPost(unit, p.tool_use_id, now);
        const resp = p.tool_response;
        const errored = (resp && typeof resp === 'object' && (resp.is_error || resp.error || resp.success === false))
          || (typeof resp === 'string' && /^error\b/i.test(resp));
        if (errored) w.lastError = now;
      }
      return true;
    }
    case 'SubagentStop':
      if (p.agent_id) delete w.workers[p.agent_id];
      return true;
    case 'Stop':
      // Turn ended → main is idle and the world stops "working". This is NOT "needs you": a normal
      // finish just hands control back. Genuine "waiting for you" comes only from a Notification
      // (permission prompt instantly, or ~60s idle). finishedAt drives a one-shot "done" flash.
      w.main.pending.clear(); w.main.busy = false; w.finishedAt = now;
      return true;
    case 'SessionEnd':
      // You exited (or /clear started a fresh session): the board shows only live sessions.
      delete worlds[sessionId];
      return true;
    default:
      return true;
  }
}

/** A world is "stuck" if any unit has a tool in flight longer than STUCK_AFTER. */
export function worldStuck(w, now) {
  const hung = (u) => { for (const v of u.pending.values()) if (now - v.startedAt > STUCK_AFTER) return true; return false; };
  if (hung(w.main)) return true;
  for (const wk of Object.values(w.workers)) if (hung(wk)) return true;
  return false;
}

/** Drop tool calls in flight implausibly long (a dropped Post). Returns true if changed. */
export function pruneStale(u, now) {
  let changed = false;
  for (const [k, v] of u.pending) if (now - v.startedAt > TOOL_MAX_INFLIGHT) { u.pending.delete(k); changed = true; }
  return changed;
}

/**
 * Sweep stale state over `worlds` at time `now`. Returns true if anything changed. `isAlive(pid)`
 * reports whether a session's Claude Code process still runs: a closed terminal sends no SessionEnd,
 * so a dead process is the only signal that the session is gone.
 */
export function watchdog(worlds, now = Date.now(), isAlive = null) {
  let changed = false;
  for (const [sid, w] of Object.entries(worlds)) {
    if (now - w.lastSeen > WORLD_REMOVE_AFTER || (isAlive && w.pid && !isAlive(w.pid))) { delete worlds[sid]; changed = true; continue; }
    const stuck = worldStuck(w, now);
    if (stuck !== !!w._stuck) { w._stuck = stuck; changed = true; }
    changed = pruneStale(w.main, now) || changed;
    // Heal a dropped Stop: main "thinking" (busy, nothing in flight) but silent too long → idle.
    // Don't fake "waiting" here either — Claude Code's idle Notification is the real signal.
    if (w.main.busy && w.main.pending.size === 0 && now - w.main.lastSeen > THINK_MAX) {
      w.main.busy = false;
      changed = true;
    }
    for (const [aid, worker] of Object.entries(w.workers)) {
      changed = pruneStale(worker, now) || changed;
      if (worker.busy && worker.pending.size === 0 && now - worker.lastSeen > THINK_MAX) { worker.busy = false; changed = true; }
      // Remove a subagent that's gone quiet past WORKER_GONE_AFTER. A LIVE subagent emits Pre/Post
      // events continuously, so long silence means it's done. We used to keep any worker with a tool
      // in-flight — but a dropped SubagentStop leaves a "ghost" stuck on a pending tool that then
      // lingered ~15min (until TOOL_MAX_INFLIGHT). So also drop it once its only pending tools are
      // themselves stale (in-flight past STUCK_AFTER): quiet + stuck-pending == ghost, not alive.
      // (`every` on an empty pending Map is true, preserving the old idle+quiet removal.)
      const staleOrEmpty = [...worker.pending.values()].every((v) => now - v.startedAt > STUCK_AFTER);
      if (now - worker.lastSeen > WORKER_GONE_AFTER && staleOrEmpty) { delete w.workers[aid]; changed = true; }
    }
  }
  return changed;
}

/** Project a unit onto the stable wire shape the client consumes. */
export function serializeUnit(u) {
  const out = { state: unitState(u), lastTool: u.lastTool, lastCmd: u.lastCmd || null };
  if (u.agentType) out.agentType = u.agentType;
  let since = null;
  for (const v of u.pending.values()) if (since === null || v.startedAt < since) since = v.startedAt;
  if (since !== null) out.busySince = since;
  return out;
}

// ---- persistence across server restarts (#3) -----------------------------------
// Save what survives a restart: sessions, their folder/transcript, last activity, "needs you".
// In-flight tools, busy flags and subagents are NOT saved — events were missed while the server
// was down, so restoring them would show ghosts; the next hook event rebuilds live activity.
export function toSaved(worlds) {
  const out = {};
  for (const [sid, w] of Object.entries(worlds)) {
    out[sid] = { status: w.status, pid: w.pid || null, cwd: w.cwd, transcriptPath: w.transcriptPath, source: w.source, lastSeen: w.lastSeen,
      attention: w.attention || null, finishedAt: w.finishedAt || null, lastError: w.lastError || null,
      lastTool: w.main.lastTool, lastCmd: w.main.lastCmd,
      timeline: w.timeline ? [...w.timeline].map(([t, b]) => [t, b.working, b.thinking, b.blocked, b.idle]) : [] };
  }
  return out;
}
export function fromSaved(saved, worlds, now = Date.now()) {
  for (const [sid, v] of Object.entries(saved || {})) {
    if (!v || typeof v.lastSeen !== 'number' || now - v.lastSeen > WORLD_REMOVE_AFTER) continue;
    const main = newUnit(v.lastSeen);
    main.lastTool = v.lastTool || null; main.lastCmd = v.lastCmd || null;
    worlds[sid] = { status: v.status || 'active', pid: v.pid || null, cwd: v.cwd || null, transcriptPath: v.transcriptPath || null,
      source: v.source || null, lastSeen: v.lastSeen, attention: v.attention || null,
      finishedAt: v.finishedAt || null, lastError: v.lastError || null, main, workers: Object.create(null),
      timeline: new Map((v.timeline || []).map(([t, working, thinking, blocked, idle]) => [t, { working, thinking, blocked, idle }])) };
  }
  return worlds;
}

// ---- graph data (#5): pure aggregation over transcript states --------------------
/**
 * Per-project × per-day rollup over the last `nDays` days. entries: [{ st, isSession, sid? }].
 * Also: what the money paid for (`parts`), and per session (main + its subagents, grouped by `sid`)
 * the main agent's calls and average context — the lever you control (/compact, fresh session).
 */
export function summarize(entries, now, nDays = 14) {
  const days = [];
  for (let i = nDays - 1; i >= 0; i--) days.push(dayKey(now - i * 86_400_000));
  const idx = new Map(days.map((d, i) => [d, i]));
  const zeros = () => new Array(nDays).fill(0);
  const total = { cost: zeros(), tools: zeros(), activeMin: zeros() };
  const parts = { in: 0, out: 0, read: 0, write: 0 };
  const projects = new Map(), sessions = new Map();
  let partial = false;
  for (const { st, isSession, sid } of entries) {
    const cwd = st.cwd || '(unknown)';
    const p = projects.get(cwd) || { cwd, sessions: 0, cost: 0, tools: 0, activeMs: 0, costByDay: zeros() };
    projects.set(cwd, p);
    const key = sid || st;                              // no sid (tests / old callers): every entry its own session
    const ss = sessions.get(key) || { sid: sid || null, title: null, cwd, cost: 0, subCost: 0, turns: 0, ctx: 0, lastCtx: 0 };
    sessions.set(key, ss);
    let touched = false;
    for (const [d, v] of st.days) {
      const i = idx.get(d); if (i === undefined) continue;
      touched = true;
      p.cost += v.cost; p.tools += v.tools; p.activeMs += v.activeMs; p.costByDay[i] += v.cost;
      total.cost[i] += v.cost; total.tools[i] += v.tools; total.activeMin[i] += v.activeMs / 60_000;
      for (const k in parts) parts[k] += v[k] || 0;
      if (isSession) { ss.cost += v.cost; ss.turns += v.turns || 0; ss.ctx += v.ctx || 0; } else ss.subCost += v.cost;
    }
    if (isSession) { ss.title = st.title; ss.cwd = cwd; ss.lastCtx = st.ctx || 0; ss.lastTs = st.lastTs;
      if (st.out) Object.assign(ss, { branches: st.out.branches.size, compactions: st.out.compactions, corrections: st.out.correctionsTotal || 0, uncheckedEdits: st.out.uncheckedEdits }); }
    if (touched && isSession) p.sessions++;
    if (touched && st.unpriced) partial = true;
  }
  const list = [...projects.values()].filter((p) => p.cost || p.tools).sort((a, b) => b.cost - a.cost);
  // Ranked by best-practice quality flags (config/quality.mjs), then by size — not by cost.
  const top = [...sessions.values()].filter((x) => x.turns > 0)
    .map(({ ctx, ...x }) => ({ ...x, avgCtx: x.turns ? Math.round(ctx / x.turns) : 0 }))
    .sort((a, b) => flagCount(b) - flagCount(a) || b.turns - a.turns);
  return { days, total, parts, projects: list, sessions: top.slice(0, 15), costPartial: partial, outcomes: outcomes(entries, days, idx) };
}

// Outcomes over the window: what shipped, whether it was checked first, whether it held up (7-day
// rework: a file a commit shipped, edited again by a DIFFERENT session within a week), what runs were
// wasted, and what it cost your attention. Counts, not scores.
const REWORK_MS = 7 * 86_400_000;
function outcomes(entries, days, idx) {
  const n = days.length, zeros = () => new Array(n).fill(0);
  const byDay = { checked: zeros(), unchecked: zeros() }, errs = {}, waits = [];
  let prs = 0, approveMs = 0;
  // Group transcripts into sessions: a commit may ship a subagent's edits, checked by either agent.
  const sessions = new Map();                         // key -> { sid, title, cwd, edits, checks, commits }
  for (const e of entries) {
    const { st } = e, key = e.sid || st;                 // no sid (tests / old callers): its own session
    for (const [d, v] of st.days) {
      if (!idx.has(d)) continue;
      prs += v.prs || 0; approveMs += v.approveMs || 0;
      for (const [c, k] of Object.entries(v.errs || {})) errs[c] = (errs[c] || 0) + k;
      if (v.waits) for (const w of v.waits) waits.push(w);
    }
    if (!st.out) continue;
    const g = sessions.get(key) || { key, sid: e.sid || null, title: null, cwd: st.cwd, edits: [], checks: [], commits: [] };
    sessions.set(key, g);
    if (e.isSession) { g.title = st.title; g.cwd = st.cwd; }
    g.edits.push(...st.out.edits); g.checks.push(...st.out.checks); g.commits.push(...st.out.commits);
  }
  // file -> [[ts, sessionKey]] once, so rework is a lookup per shipped file (not a scan of every transcript).
  const byFile = new Map();
  for (const g of sessions.values()) for (const [t, f] of g.edits) if (f) (byFile.get(f) || byFile.set(f, []).get(f)).push([t, g.key]);
  const shipped = [];
  let files = 0, reworked = 0;
  for (const g of sessions.values()) {
    g.commits.sort((a, b) => a.ts - b.ts);
    let prev = -Infinity;
    for (const c of g.commits) {
      // What this commit shipped: the session's edits since its previous commit.
      const win = g.edits.filter(([t]) => t > prev && t <= c.ts);
      const lastEdit = win.reduce((m, [t]) => Math.max(m, t), -Infinity);
      const edited = win.length > 0, checked = edited && g.checks.some((t) => t >= lastEdit && t <= c.ts);
      const i = idx.get(dayKey(c.ts));
      if (i !== undefined) {
        shipped.push({ ...c, edited, checked, sid: g.sid, title: g.title, cwd: g.cwd });
        if (edited) byDay[checked ? 'checked' : 'unchecked'][i]++;
        for (const f of new Set(win.map(([, f]) => f).filter(Boolean))) {
          files++;
          if ((byFile.get(f) || []).some(([t, k]) => k !== g.key && t > c.ts && t - c.ts < REWORK_MS)) reworked++;
        }
      }
      prev = c.ts;
    }
  }
  waits.sort((a, b) => a - b);
  const edited = shipped.filter((c) => c.edited);
  return {
    commits: shipped.length, prs, edited: edited.length, checked: edited.filter((c) => c.checked).length, byDay,
    unchecked: edited.filter((c) => !c.checked).sort((a, b) => b.ts - a.ts).slice(0, 12)
      .map(({ ts, msg, title, cwd, sid }) => ({ ts, msg, title, cwd, sid })),
    rework: { files, reworked },
    wasted: Object.entries(errs).sort((a, b) => b[1] - a[1]).map(([cause, count]) => ({ cause, count })),
    approveMs, replyMedianS: waits.length ? waits[Math.floor(waits.length / 2)] : null, replies: waits.length,
  };
}

// ---- one-day view: per-minute tokens + when each agent was running -----------------------------
// One transcript = one agent (main session or a subagent). For the day [from, to) — 1440 minutes, or
// 1380 / 1500 on a DST change day:
//   tokens[model][minute] = [input, output, cacheRead, cacheWrite, $read, $write, $out]   (minute 0..1439, sparse;
//                            $write includes uncached input — see partsOf in public/charts.mjs)
//   turns / ctx = model calls that day and the context they re-sent (for avg context, $ per turn)
//   active = merged [startMin, endMin] spans — "running" = lines no more than IDLE_GAP apart,
//   the same rule activeMs uses. Usage is counted once per message.id (see feedTranscript).
export const DAY_MIN = 1440;
export function dayRecords(text, from, to = from + DAY_MIN * 60_000) {
  const mins = Math.round((to - from) / 60_000);
  const tokens = {}, seen = new Set(), active = [];
  let turns = 0, ctx = 0;
  let cwd = null, title = null, lastTs = null;
  const minOf = (ts) => Math.floor((ts - from) / 60_000);
  const inDay = (m) => m >= 0 && m < mins;
  const span = (a, b) => {                              // a..b in ms → clipped minute span, merged with the previous
    const s = Math.max(0, minOf(a)), e = Math.min(mins - 1, minOf(b));
    if (s > e) return;
    const p = active[active.length - 1];
    if (p && s <= p[1] + 1) p[1] = Math.max(p[1], e); else active.push([s, e]);
  };
  for (const line of String(text).split('\n')) {
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'ai-title' && o.aiTitle) { title = o.aiTitle; continue; }
    if (!cwd && o.cwd) cwd = o.cwd;
    const ts = o.timestamp ? Date.parse(o.timestamp) : NaN;
    if (isNaN(ts)) continue;
    span(lastTs !== null && ts - lastTs > 0 && ts - lastTs <= IDLE_GAP ? lastTs : ts, ts);
    if (lastTs === null || ts > lastTs) lastTs = ts;
    const msg = o.message, u = msg && msg.usage;
    if (!u || (msg.id && seen.has(msg.id))) continue;
    if (msg.id) seen.add(msg.id);
    const m = minOf(ts);
    if (!inDay(m) || msg.model === '<synthetic>') continue;
    const row = ((tokens[msg.model || 'unknown'] ||= {})[m] ||= [0, 0, 0, 0, 0, 0, 0]);
    row[0] += u.input_tokens || 0; row[1] += u.output_tokens || 0;
    row[2] += u.cache_read_input_tokens || 0; row[3] += u.cache_creation_input_tokens || 0;
    const c = costParts(msg.model, u);                  // unpriced model → tokens only, $0
    if (c) { row[4] += c.read; row[5] += c.write + c.in; row[6] += c.out; }
    turns++; ctx += (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
  }
  return { cwd, title, tokens, active, turns, ctx };
}

// ---- working vs idle timeline: sampled from live state (not transcripts)------------------------
// What a session is doing right now, from YOUR point of view:
//   working  = a tool is running (main or any subagent)     thinking = mid-turn, model generating
//   blocked  = a permission prompt / question waits on you  idle     = turn over, waiting for your next prompt
export const ACTIVITY = ['working', 'thinking', 'blocked', 'idle'];
export function activityOf(w) {
  if (w.permission || (w.attention && w.attention.reason === 'permission')) return 'blocked';
  const units = [w.main, ...Object.values(w.workers)];
  if (units.some((u) => u.pending.size)) return 'working';
  if (units.some((u) => u.busy)) return 'thinking';
  return 'idle';
}
/** Credit `dtMs` of the current activity to its 5-minute bucket. Dormant (ended) sessions don't accrue. */
export function recordActivity(w, now, dtMs) {
  if (w.status === 'dormant' || !(dtMs > 0)) return;
  const tl = w.timeline || (w.timeline = new Map());   // bucketStart -> { working, thinking, blocked, idle } ms
  const t = now - (now % BUCKET_MS);
  const b = tl.get(t) || { working: 0, thinking: 0, blocked: 0, idle: 0 };
  tl.set(t, b);
  b[activityOf(w)] += dtMs;
  if (tl.size > MAX_BUCKETS) tl.delete(Math.min(...tl.keys()));
}
/** Last `n` buckets of the timeline as parallel arrays (ms per state). */
export function timelineSeries(w, now, n = 24) {
  const end = now - (now % BUCKET_MS), start = end - (n - 1) * BUCKET_MS;
  const out = { start, step: BUCKET_MS };
  for (const k of ACTIVITY) out[k] = new Array(n).fill(0);
  for (const [t, b] of w.timeline || []) {
    if (t < start || t > end) continue;
    const i = (t - start) / BUCKET_MS;
    for (const k of ACTIVITY) out[k][i] += b[k];
  }
  return out;
}

/**
 * Sessions whose pid we haven't learned yet (restored from disk, not heard from since) matched against
 * the running `claude` processes by folder. procsByCwd: Map cwd -> [pid]. Per folder: more unmatched
 * sessions than unclaimed processes → the oldest extras are dead (removed); exactly one of each → that's
 * its pid. Returns true if anything changed.
 */
export function reconcilePids(worlds, procsByCwd) {
  const claimed = new Set(Object.values(worlds).map((w) => w.pid).filter(Boolean));
  const byCwd = new Map();
  for (const [sid, w] of Object.entries(worlds)) if (!w.pid && w.cwd) (byCwd.get(w.cwd) || byCwd.set(w.cwd, []).get(w.cwd)).push(sid);
  let changed = false;
  for (const [cwd, sids] of byCwd) {
    const free = (procsByCwd.get(cwd) || []).filter((pid) => !claimed.has(pid));
    if (sids.length === 1 && free.length === 1) { worlds[sids[0]].pid = free[0]; changed = true; continue; }
    if (sids.length > free.length) {
      sids.sort((a, b) => worlds[b].lastSeen - worlds[a].lastSeen);      // newest first; oldest are the dead ones
      for (const sid of sids.slice(free.length)) { delete worlds[sid]; changed = true; }
    }
  }
  return changed;
}
