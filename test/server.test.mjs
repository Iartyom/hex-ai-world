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
import http from 'node:http';
import { WebSocket } from 'ws';
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

// Local-only guard: transcripts hold code + prompts, so a foreign Host (DNS rebinding) or a foreign
// page's WebSocket must be refused, while the local page and the hook (no Origin) still work.
const hostStatus = (host) => new Promise((res, rej) => {
  http.get({ port: server.address().port, path: '/state', headers: { host } }, (r) => { r.resume(); res(r.statusCode); }).on('error', rej);
});
const wsOpens = (origin) => new Promise((res) => {
  const ws = new WebSocket(`ws://localhost:${server.address().port}`, origin ? { origin } : {});
  ws.on('open', () => { ws.close(); res(true); });
  ws.on('error', () => res(false));
});

test('refuses a non-local Host header (DNS rebinding)', async () => {
  assert.equal(await hostStatus('evil.example:8787'), 403);
  assert.equal(await hostStatus('127.0.0.1:8787'), 200);
});

test('WebSocket: accepts local/no Origin, refuses a foreign page', async () => {
  assert.equal(await wsOpens(null), true);
  assert.equal(await wsOpens(`http://localhost:${server.address().port}`), true);
  assert.equal(await wsOpens('https://evil.example'), false);
});

// Incremental parsing: a line appended in two writes (cut mid multi-byte char) must be ignored while
// partial, then parsed intact once its newline lands — without re-reading from the start.
test('/chat picks up appended lines incrementally, including a line split mid-UTF-8', async () => {
  const p = worlds[SID].transcriptPath;
  const line = Buffer.from(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'MARKER_LATE über' }] } }) + '\n');
  const cut = line.indexOf(Buffer.from('ü')) + 1;           // inside the 2-byte 'ü'
  const get = () => fetch(`${base}/chat?session=${SID}&agent=main`).then((x) => x.json()).then((r) => JSON.stringify(r.entries));
  fs.appendFileSync(p, '\n');                                // terminate the seed's last line
  await get();                                               // prime the cache
  fs.appendFileSync(p, line.subarray(0, cut));
  assert.ok(!(await get()).includes('MARKER_LATE'), 'partial line not parsed yet');
  fs.appendFileSync(p, line.subarray(cut));
  const done = await get();
  assert.ok(done.includes('MARKER_LATE über'), 'completed line parsed with the ü intact');
  assert.ok(done.includes('MARKER_MAIN'), 'earlier entries kept');
});

// #4: the hook's POST /permission is held open while a board is connected, and a click answers it.
const post = (p, body, headers = {}) => fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('/permission answers {} at once when no board is open (never delays the terminal prompt)', async () => {
  const t = Date.now();
  const r = await post('/permission', { session_id: SID, tool_name: 'Bash', tool_input: { command: 'rm -rf x' } }).then((x) => x.json());
  assert.deepEqual(r, {});
  assert.ok(Date.now() - t < 1000);
});

test('/permission round-trip: board sees the card, Allow click resolves the held hook', async () => {
  const ws = new WebSocket(`ws://localhost:${server.address().port}`);
  const cards = [];
  ws.on('message', (m) => { const w = JSON.parse(m).worlds[SID]; if (w && w.permission) cards.push(w.permission); });
  await new Promise((r) => ws.on('open', r));
  const held = post('/permission', { session_id: SID, tool_name: 'Bash', tool_input: { command: 'npm publish' } }).then((x) => x.json());
  for (let i = 0; i < 50 && !cards.length; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(cards[0].summary, 'npm publish');
  // a foreign page can't approve it (CSRF), and a non-JSON body is refused
  assert.equal((await post('/permission/decide', { id: cards[0].id, behavior: 'allow' }, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await fetch(`${base}/permission/decide`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ id: cards[0].id, behavior: 'allow' }) })).status, 415);
  assert.equal((await post('/permission/decide', { id: cards[0].id, behavior: 'allow' })).status, 204);
  assert.deepEqual(await held, { behavior: 'allow' });
  assert.equal((await post('/permission/decide', { id: cards[0].id, behavior: 'deny' })).status, 404, 'already settled');
  ws.close();
});

test('POST /event from a foreign origin is refused; the hook (no Origin) is accepted', async () => {
  assert.equal((await post('/event', { session_id: 'x' }, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await post('/event', { session_id: 'x-hook' })).status, 204);
  delete worlds['x-hook'];
});

test('/stats sums a session and its subagents', async () => {
  const r = await fetch(`${base}/stats?session=${SID}`).then((x) => x.json());
  assert.equal(r.subagents, 1);
  assert.equal(r.series.tools.length, 24);
  assert.equal(typeof r.cost, 'number');
});

test('/permission: AskUserQuestion ships the questions; answering returns allow + updatedInput.answers', async () => {
  const ws = new WebSocket(`ws://localhost:${server.address().port}`);
  const cards = [];
  ws.on('message', (m) => { const w = JSON.parse(m).worlds[SID]; if (w && w.permission) cards.push(w.permission); });
  await new Promise((r) => ws.on('open', r));
  const questions = [{ question: 'Which DB?', header: 'DB', multiSelect: false, options: [{ label: 'Postgres', description: 'relational' }, { label: 'Mongo' }] }];
  const held = post('/permission', { session_id: SID, tool_name: 'AskUserQuestion', tool_input: { questions } }).then((x) => x.json());
  for (let i = 0; i < 50 && !cards.length; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(cards[0].questions[0].options[0].description, 'relational');
  assert.equal((await post('/permission/decide', { id: cards[0].id, behavior: 'allow', answers: { 'Which DB?': 'Postgres' } })).status, 204);
  assert.deepEqual(await held, { behavior: 'allow', updatedInput: { questions, answers: { 'Which DB?': 'Postgres' } } });
  // "Terminal" releases a held prompt with no decision
  cards.length = 0;
  const held2 = post('/permission', { session_id: SID, tool_name: 'Bash', tool_input: { command: 'ls' } }).then((x) => x.json());
  for (let i = 0; i < 50 && !cards.length; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal((await post('/permission/decide', { id: cards[0].id, behavior: 'terminal' })).status, 204);
  assert.deepEqual(await held2, {});
  ws.close();
});

test('held prompt is released when you answer in the terminal (same tool ran) or the last board tab closes', async () => {
  const open = async () => { const ws = new WebSocket(`ws://localhost:${server.address().port}`); await new Promise((r) => ws.on('open', r)); return ws; };
  const waitCard = async () => { for (let i = 0; i < 50 && !(worlds[SID] && worlds[SID].permission); i++) await new Promise((r) => setTimeout(r, 20)); };
  const ws = await open();
  const held = post('/permission', { session_id: SID, tool_name: 'Bash', tool_input: { command: 'make' } }).then((x) => x.json());
  await waitCard();
  await post('/event', { session_id: SID, hook_event_name: 'PostToolUse', tool_name: 'Read' });   // a different tool: still held
  assert.ok(worlds[SID].permission, 'unrelated activity keeps the card');
  await post('/event', { session_id: SID, hook_event_name: 'PostToolUse', tool_name: 'Bash' });
  assert.deepEqual(await held, {}, 'the same tool ran → answered in the terminal → released');
  const held2 = post('/permission', { session_id: SID, tool_name: 'Bash', tool_input: { command: 'make' } }).then((x) => x.json());
  await waitCard();
  ws.close();
  assert.deepEqual(await held2, {}, 'last board tab closed → back to the terminal');
});
