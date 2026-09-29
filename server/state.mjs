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
import { costOf } from '../config/pricing.mjs';

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
const MAX_BUCKETS = 288;                             // keep 24h of 5-minute buckets per transcript
export const dayKey = (ts) => new Date(ts).toLocaleDateString('sv');  // local YYYY-MM-DD

export function newTranscriptState() {
  return { title: null, cwd: null, entries: [], startTs: null, endTs: null, lastTs: null, tools: 0,
    tokIn: 0, tokOut: 0, tokCR: 0, tokCW: 0, cost: 0, unpriced: 0, activeMs: 0, files: new Set(),
    seenMsg: new Set(),                               // message ids already costed (see feedTranscript)
    buckets: new Map(),                               // bucketStart -> { tools, cost }
    days: new Map() };                                // 'YYYY-MM-DD' -> { tools, cost, activeMs }
}
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
      if (gap > 0 && gap <= IDLE_GAP) { s.activeMs += gap; slot(s.days, dayKey(ts), () => ({ tools: 0, cost: 0, activeMs: 0 })).activeMs += gap; }
      if (s.lastTs === null || ts > s.lastTs) s.lastTs = ts;
    }
    const bucket = has ? slot(s.buckets, ts - (ts % BUCKET_MS), () => ({ tools: 0, cost: 0 })) : null;
    const day = has ? slot(s.days, dayKey(ts), () => ({ tools: 0, cost: 0, activeMs: 0 })) : null;
    // Claude Code writes ONE line per content block of a response, each repeating the full `usage` —
    // count a message's usage once (by message.id), or tokens/cost come out ~2-3× too high.
    const msg = o.message;
    const usage = msg && msg.usage;
    if (usage && !(msg.id && s.seenMsg.has(msg.id))) {
      if (msg.id) s.seenMsg.add(msg.id);
      s.tokIn += usage.input_tokens || 0; s.tokOut += usage.output_tokens || 0; s.tokCR += usage.cache_read_input_tokens || 0; s.tokCW += usage.cache_creation_input_tokens || 0;
      const c = costOf(msg.model, usage);
      if (c === null) s.unpriced++;
      else { s.cost += c; if (bucket) bucket.cost += c; if (day) day.cost += c; }
    }
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
          s.tools++; if (bucket) bucket.tools++; if (day) day.tools++;
          const fp = b.input && (b.input.file_path || b.input.notebook_path);
          if (fp && (b.name === 'Edit' || b.name === 'MultiEdit' || b.name === 'Write' || b.name === 'NotebookEdit')) s.files.add(fp);
          s.entries.push({ k: 'tool', id: b.id || null, name: b.name || 'tool', input: pickToolInput(b.name, b.input) });
        }
      }
    }
  }
  if (s.entries.length > 2 * CHAT_TAIL) s.entries = s.entries.slice(-CHAT_TAIL); // bounded memory
  if (s.buckets.size > MAX_BUCKETS) { const keep = [...s.buckets.keys()].sort((a, b) => a - b).slice(-MAX_BUCKETS); s.buckets = new Map(keep.map((k) => [k, s.buckets.get(k)])); }
}

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
/** Last `n` 5-minute buckets ending at `now`, summed across states (a session + its subagents). */
export function recentSeries(states, now, n = 24) {
  const end = now - (now % BUCKET_MS), start = end - (n - 1) * BUCKET_MS;
  const tools = new Array(n).fill(0), cost = new Array(n).fill(0);
  for (const s of states) for (const [t, b] of s.buckets) {
    if (t < start || t > end) continue;
    const i = (t - start) / BUCKET_MS;
    tools[i] += b.tools; cost[i] += b.cost;
  }
  return { start, step: BUCKET_MS, tools, cost };
}

/** Per-project × per-day rollup over the last `nDays` days. entries: [{ st, isSession }]. */
export function summarize(entries, now, nDays = 14) {
  const days = [];
  for (let i = nDays - 1; i >= 0; i--) days.push(dayKey(now - i * 86_400_000));
  const idx = new Map(days.map((d, i) => [d, i]));
  const zeros = () => new Array(nDays).fill(0);
  const total = { cost: zeros(), tools: zeros(), activeMin: zeros() };
  const projects = new Map();
  let partial = false;
  for (const { st, isSession } of entries) {
    const cwd = st.cwd || '(unknown)';
    const p = projects.get(cwd) || { cwd, sessions: 0, cost: 0, tools: 0, activeMs: 0, costByDay: zeros() };
    projects.set(cwd, p);
    let touched = false;
    for (const [d, v] of st.days) {
      const i = idx.get(d); if (i === undefined) continue;
      touched = true;
      p.cost += v.cost; p.tools += v.tools; p.activeMs += v.activeMs; p.costByDay[i] += v.cost;
      total.cost[i] += v.cost; total.tools[i] += v.tools; total.activeMin[i] += v.activeMs / 60_000;
    }
    if (touched && isSession) p.sessions++;
    if (touched && st.unpriced) partial = true;
  }
  const list = [...projects.values()].filter((p) => p.cost || p.tools).sort((a, b) => b.cost - a.cost);
  return { days, total, projects: list, costPartial: partial };
}

// ---- working vs idle timeline: sampled from live state (not transcripts) ------------------------
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
