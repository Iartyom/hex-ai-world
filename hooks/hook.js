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

// Forward the raw payload to the Phase 1 event-spine server, then call done().
// Fire-and-forget with a tight timeout: if the server is down we must NOT block or
// crash the agent — done() runs on success, error, or timeout, whichever is first.
function forward(raw, done) {
  let finished = false;
  const finish = () => { if (!finished) { finished = true; done(); } };
  try {
    const req = http.request({
      host: '127.0.0.1', port: 8787, path: '/event', method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hook-event': eventName },
    }, (res) => { res.resume(); res.on('end', finish); });
    req.on('error', finish);              // server not running / refused → move on
    req.setTimeout(200, () => { req.destroy(); finish(); });
    req.end(raw);
  } catch (_) { finish(); }               // never let forwarding break the hook
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  const oneLine = raw.replace(/\r?\n/g, ' ').trim();
  // 1) append to the local JSONL (replay/debug log), 2) forward to the server.
  try { fs.appendFileSync(outFile, `${eventName} ${oneLine}\n`); } catch (_) { /* ignore */ }
  forward(oneLine || '{}', () => process.exit(0));
});
// Defensive: if stdin somehow never closes, don't hang the agent forever.
setTimeout(() => process.exit(0), 2000);
