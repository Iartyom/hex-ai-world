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

const category = categoryFor;

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

// Parse the whole transcript text → { title, entries, stats }. Pure (string in, data out).
export function parseTranscript(text) {
  let title = null; const entries = [];
  let startTs = null, endTs = null, tools = 0, tokIn = 0, tokOut = 0, tokCR = 0, tokCW = 0;
  const files = new Set();
  for (const line of String(text).split('\n')) {
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'ai-title' && o.aiTitle) { title = o.aiTitle; continue; } // latest wins
    const ts = o.timestamp ? Date.parse(o.timestamp) : NaN;
    if (!isNaN(ts)) { if (startTs === null || ts < startTs) startTs = ts; if (endTs === null || ts > endTs) endTs = ts; }
    const usage = o.message && o.message.usage;
    if (usage) { tokIn += usage.input_tokens || 0; tokOut += usage.output_tokens || 0; tokCR += usage.cache_read_input_tokens || 0; tokCW += usage.cache_creation_input_tokens || 0; }
    const content = o.message && o.message.content;
    if (o.type === 'user') {
      if (typeof content === 'string') { if (content.trim()) entries.push({ k: 'user', t: content.trim() }); }
      else if (Array.isArray(content)) {
        for (const b of content) {
          if (!b) continue;
          if (b.type === 'text' && b.text && b.text.trim()) entries.push({ k: 'user', t: b.text.trim() });
          else if (b.type === 'tool_result') entries.push({ k: 'result', id: b.tool_use_id || null, text: resultText(b.content), err: !!b.is_error });
        }
      }
    } else if (o.type === 'assistant' && Array.isArray(content)) {
      for (const b of content) {
        if (!b) continue;
        if (b.type === 'text' && b.text && b.text.trim()) entries.push({ k: 'say', t: b.text.trim() });
        else if (b.type === 'thinking' && b.thinking && b.thinking.trim()) entries.push({ k: 'think', t: b.thinking.trim() });
        else if (b.type === 'tool_use') {
          tools++;
          const fp = b.input && (b.input.file_path || b.input.notebook_path);
          if (fp && (b.name === 'Edit' || b.name === 'MultiEdit' || b.name === 'Write' || b.name === 'NotebookEdit')) files.add(fp);
          entries.push({ k: 'tool', id: b.id || null, name: b.name || 'tool', input: pickToolInput(b.name, b.input) });
        }
      }
    }
  }
  const stats = { startTs, endTs, tools, files: files.size, tokIn, tokOut, tokCacheRead: tokCR, tokCacheWrite: tokCW, tokTotal: tokIn + tokOut + tokCR + tokCW };
  return { title, entries: entries.slice(-CHAT_TAIL), stats };
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
  u.pending.set(id, { tool, cat: category(tool), startedAt: now });
  u.lastTool = tool || u.lastTool;
  u.lastCmd = cmdSummary(tool, input) || u.lastCmd;
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

export function ensureWorld(worlds, sessionId, p = {}) {
  let w = worlds[sessionId];
  if (!w) {
    w = worlds[sessionId] = {
      status: 'active', cwd: p.cwd || null, transcriptPath: p.transcript_path || null,
      source: p.source || null, lastSeen: Date.now(), main: newUnit(Date.now()), workers: Object.create(null),
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

  if (eventName === 'SessionStart') {
    const w = ensureWorld(worlds, sessionId, p);
    w.status = 'active'; w.source = p.source || w.source; w.lastSeen = now;
    return true;
  }

  const w = ensureWorld(worlds, sessionId, p);
  w.lastSeen = now; w.status = 'active';
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
      w.status = 'dormant';
      w.main.pending.clear(); w.main.busy = false;
      for (const wk of Object.values(w.workers)) { wk.pending.clear(); wk.busy = false; }
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

/** Sweep stale state over `worlds` at time `now`. Returns true if anything changed. */
export function watchdog(worlds, now = Date.now()) {
  let changed = false;
  for (const [sid, w] of Object.entries(worlds)) {
    if (now - w.lastSeen > WORLD_REMOVE_AFTER) { delete worlds[sid]; changed = true; continue; }
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
      if (worker.pending.size === 0 && now - worker.lastSeen > WORKER_GONE_AFTER) { delete w.workers[aid]; changed = true; }
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
