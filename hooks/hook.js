#!/usr/bin/env node
/*
 * Phase 0 spike — dumb, fast hook logger for the Hex-World Agent Visualizer.
 *
 * WHY dumb: Claude Code hooks block the agent while they run (~50ms budget), and
 * Phase 0's whole point is to observe RAW hook output before trusting any field
 * names/event names (see BUILD runbook rule 2 & 4). So this captures + appends only;
 * ALL parsing/state logic lives in the Phase 1 server, never in the hook.
 *
 * Contract: argv[2] = event name (passed by the settings.json registration).
 * stdin = the raw JSON payload Claude Code sends. We write one grep-able line
 *   "<EventName> <rawJSON>" to agent-events.jsonl in this script's dir (append =
 *   order-preserving).
 *
 * Cross-platform: uses __dirname + pure Node, so it runs identically on Mac and
 * Windows. CommonJS on purpose (no package.json "type":"module").
 */
const fs = require('fs');
const path = require('path');
const http = require('http');

const eventName = process.argv[2] || 'UNKNOWN';
// Log lives next to this script (same dir) so all sessions' events land in the
// repo, not scattered in the home dir — easy to find, inspect, and .gitignore.
const outFile = path.join(__dirname, 'agent-events.jsonl');
const LOG_MAX = 20 * 1024 * 1024; // rotate to agent-events.jsonl.1 past this

// Forward the raw payload to the Phase 1 event-spine server, then call done().
// Fire-and-forget with a tight timeout: if the server is down we must NOT block or
// crash the agent — done() runs on success, error, or timeout, whichever is first.
// PermissionRequest is the one event that WAITS: the server holds it open while the board shows an
// Allow/Deny card (it answers {} at once if no board is open, or after its wait cap).
const IS_PERMISSION = eventName === 'PermissionRequest';
// The permission wait is open-ended (the server releases it); Claude Code's own hook `timeout` in
// settings.json (set by install-hooks) is the outer bound.
const WAIT_MS = IS_PERMISSION ? 24 * 3600 * 1000 : 200;

function forward(raw, done) {
  let finished = false;
  const finish = (body) => { if (!finished) { finished = true; done(body || ''); } };
  try {
    const req = http.request({
      host: '127.0.0.1', port: 8787, path: IS_PERMISSION ? '/permission' : '/event', method: 'POST',
      // ppid lets the server find this session's `claude` process and drop the world when it exits.
      headers: { 'content-type': 'application/json', 'x-hook-event': eventName, 'x-hook-ppid': String(process.ppid) },
    }, (res) => { let b = ''; res.setEncoding('utf8'); res.on('data', (c) => { b += c; }); res.on('end', () => finish(b)); });
    req.on('error', () => finish());      // server not running / refused → move on
    req.setTimeout(WAIT_MS, () => { req.destroy(); finish(); });
    req.end(raw);
  } catch (_) { finish(); }               // never let forwarding break the hook
}

// Print a decision only for an explicit allow/deny; anything else → no output → normal prompt.
// `updatedInput` rides along when the board answered an AskUserQuestion.
function answer(body) {
  if (!IS_PERMISSION) return;
  let d = null;
  try { d = JSON.parse(body); } catch (_) { /* no decision */ }
  if (!d || (d.behavior !== 'allow' && d.behavior !== 'deny')) return;
  const decision = { behavior: d.behavior };
  if (d.behavior === 'allow' && d.updatedInput && typeof d.updatedInput === 'object') decision.updatedInput = d.updatedInput;
  if (d.behavior === 'deny' && typeof d.message === 'string') decision.message = d.message;
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } }));
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  const oneLine = raw.replace(/\r?\n/g, ' ').trim();
  // 1) append to the local JSONL (replay/debug log), 2) forward to the server.
  try {
    // ponytail: one-generation rotation keeps the log bounded (~2×LOG_MAX); every event carries full
    // tool payloads, so an unrotated log grows without limit. A race between sessions just loses a line.
    if (fs.statSync(outFile).size > LOG_MAX) fs.renameSync(outFile, `${outFile}.1`);
  } catch (_) { /* no log yet */ }
  try { fs.appendFileSync(outFile, `${eventName} ${oneLine}\n`); } catch (_) { /* ignore */ }
  forward(oneLine || '{}', (body) => { answer(body); process.exit(0); });
});
// Defensive: if stdin somehow never closes, don't hang the agent forever.
setTimeout(() => process.exit(0), WAIT_MS + 2000);
