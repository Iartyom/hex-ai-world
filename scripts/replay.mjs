#!/usr/bin/env node
/*
 * Replays a captured hooks/agent-events.jsonl into the running server's /event
 * endpoint, so the spine + client can be developed and tested OFFLINE (no live
 * sessions). GATE 1 itself still uses real sessions — this is a dev aid.
 *
 * Usage: node scripts/replay.mjs [delayMs]   (default 150ms between events)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG = path.resolve(__dirname, '..', 'hooks', 'agent-events.jsonl');
const URL = 'http://localhost:8787/event';
const delayMs = Number(process.argv[2] ?? 150);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const lines = fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean);
console.log(`Replaying ${lines.length} events into ${URL} (${delayMs}ms apart)…`);

let sent = 0;
for (const line of lines) {
  const sp = line.indexOf(' ');
  const eventName = line.slice(0, sp);
  const body = line.slice(sp + 1); // raw JSON, forwarded exactly like the hook does
  try {
    await fetch(URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hook-event': eventName },
      body,
    });
    sent++;
  } catch (e) {
    console.error('POST failed — is the server running? (node server/server.mjs)');
    process.exit(1);
  }
  await sleep(delayMs);
}
console.log(`Done — replayed ${sent} events.`);
