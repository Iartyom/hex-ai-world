/*
 * Integration tests for the HTTP server routes (server/server.mjs) — boots a real listener on an
 * ephemeral port, writes real transcript files to a temp dir, and hits the routes over HTTP. This is
 * what unit tests on state.mjs can't prove: that /chat actually serves a LIVE subagent's own run by
 * constructing <session>/subagents/agent-<id>.jsonl (the fix), rather than falling back to main.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { server, worlds } from '../server/server.mjs';

let base;           // http://localhost:<port>
let tmp;            // temp project dir holding the transcript files
const SID = 'sess-integration-1';
const AGENT = 'a1b2c3d4e5';

// Build a minimal transcript JSONL with a unique marker word in an assistant text block.
const transcript = (marker) => [
  JSON.stringify({ type: 'ai-title', aiTitle: `title-${marker}` }),
  JSON.stringify({ type: 'user', message: { content: 'hi' }, timestamp: '2026-01-01T00:00:00Z' }),
  JSON.stringify({ type: 'assistant', timestamp: '2026-01-01T00:01:00Z', message: {
    usage: { input_tokens: 1, output_tokens: 1 },
    content: [{ type: 'text', text: `MARKER_${marker}` }],
  } }),
].join('\n');

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hexworld-it-'));
  // Claude Code's on-disk layout: <dir>/<session>.jsonl  and  <dir>/<session>/subagents/agent-<id>.jsonl
  const mainPath = path.join(tmp, `${SID}.jsonl`);
  const subDir = path.join(tmp, SID, 'subagents');
  fs.mkdirSync(subDir, { recursive: true });
  const subPath = path.join(subDir, `agent-${AGENT}.jsonl`);
  fs.writeFileSync(mainPath, transcript('MAIN'));
  fs.writeFileSync(subPath, transcript('SUB'));

  // Seed the world as if hooks had reported a session + one live subagent (whose transcriptPath is
  // still null mid-run — exactly the case the fix must handle by constructing the path).
  worlds[SID] = {
    status: 'active', cwd: tmp, transcriptPath: mainPath, source: 'test', lastSeen: Date.now(),
    main: { pending: new Map(), lastTool: null, lastCmd: null, busy: false, transcriptPath: mainPath, lastSeen: Date.now() },
    workers: { [AGENT]: { pending: new Map(), lastTool: null, lastCmd: null, busy: false, transcriptPath: null, lastSeen: Date.now() } },
  };

  await new Promise((res) => server.listen(0, res));
  base = `http://localhost:${server.address().port}`;
});

after(() => { delete worlds[SID]; server.close(); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

test('/chat?agent=<id> serves the LIVE subagent transcript, not the main chat', async () => {
  const r = await fetch(`${base}/chat?session=${SID}&agent=${AGENT}`).then((x) => x.json());
  const dump = JSON.stringify(r.entries);
  assert.ok(dump.includes('MARKER_SUB'), 'shows the subagent run');
  assert.ok(!dump.includes('MARKER_MAIN'), 'does NOT show the main chat');
  assert.equal(r.fallback, false, 'found a real subagent transcript (not a fallback)');
});

test('/chat?agent=main serves the session (main) transcript', async () => {
  const r = await fetch(`${base}/chat?session=${SID}&agent=main`).then((x) => x.json());
  const dump = JSON.stringify(r.entries);
  assert.ok(dump.includes('MARKER_MAIN'), 'shows the main chat');
  assert.ok(!dump.includes('MARKER_SUB'), 'does NOT leak the subagent run');
});

test('/chat for an unknown subagent falls back to the session transcript (fallback=true)', async () => {
  const r = await fetch(`${base}/chat?session=${SID}&agent=nonexistent999`).then((x) => x.json());
  const dump = JSON.stringify(r.entries);
  assert.ok(dump.includes('MARKER_MAIN'), 'falls back to main when no subagent file exists');
  assert.equal(r.fallback, true, 'flags the fallback so the UI can say so');
});

test('/state returns the seeded world over HTTP', async () => {
  const r = await fetch(`${base}/state`).then((x) => x.json());
  assert.equal(r.type, 'state');
  assert.ok(r.worlds[SID], 'the world is present in the broadcast snapshot');
});
