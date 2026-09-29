// Tests for the server event-spine + transcript parser (server/state.mjs) — now importable
// because the pure logic was split out of the side-effectful server.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyEvent, watchdog, unitState, worldStuck, serializeUnit, newUnit, parseTranscript,
  pickToolInput, resultText, cmdSummary, markPre,
  STUCK_AFTER, THINK_MAX, WORKER_GONE_AFTER, WORLD_REMOVE_AFTER,
} from '../server/state.mjs';

const fresh = () => Object.create(null);

test('applyEvent: main tool lifecycle → working then thinking then idle', () => {
  const w = fresh();
  applyEvent(w, 'UserPromptSubmit', { session_id: 's' });
  assert.equal(unitState(w.s.main), 'working:think');            // busy, no tool yet
  applyEvent(w, 'PreToolUse', { session_id: 's', tool_name: 'Bash', tool_use_id: 't1', tool_input: { command: 'ls' } });
  assert.ok(unitState(w.s.main).startsWith('working:'));         // tool in flight
  assert.equal(w.s.main.pending.size, 1);
  applyEvent(w, 'PostToolUse', { session_id: 's', tool_use_id: 't1' });
  assert.equal(w.s.main.pending.size, 0);
  assert.equal(unitState(w.s.main), 'working:think');            // still mid-turn
  applyEvent(w, 'Stop', { session_id: 's' });
  assert.equal(unitState(w.s.main), 'idle');
});

test('applyEvent: idempotent — duplicate PostToolUse is a no-op, no crash/negative', () => {
  const w = fresh();
  applyEvent(w, 'PreToolUse', { session_id: 's', tool_name: 'Read', tool_use_id: 't1', tool_input: { file_path: 'a.js' } });
  applyEvent(w, 'PostToolUse', { session_id: 's', tool_use_id: 't1' });
  applyEvent(w, 'PostToolUse', { session_id: 's', tool_use_id: 't1' }); // duplicate
  assert.equal(w.s.main.pending.size, 0);
});

test('applyEvent: orphan PostToolUse (no matching Pre) clears best-effort without throwing', () => {
  const w = fresh();
  assert.doesNotThrow(() => applyEvent(w, 'PostToolUse', { session_id: 's', tool_use_id: 'ghost' }));
  assert.equal(w.s.main.pending.size, 0);
});

test('applyEvent: subagent gets its own worker; SubagentStop removes it', () => {
  const w = fresh();
  applyEvent(w, 'PreToolUse', { session_id: 's', agent_id: 'a1', agent_type: 'explore', tool_name: 'Grep', tool_use_id: 'g1', tool_input: { pattern: 'x' } });
  assert.ok(w.s.workers.a1);
  assert.equal(w.s.workers.a1.agentType, 'explore');
  applyEvent(w, 'SubagentStop', { session_id: 's', agent_id: 'a1' });
  assert.equal(w.s.workers.a1, undefined);
});

test('applyEvent: Notification sets attention; type/message classify reason; activity clears it', () => {
  const w = fresh();
  applyEvent(w, 'Notification', { session_id: 's', notification_type: 'permission_prompt', message: 'needs permission' });
  assert.equal(w.s.attention.reason, 'permission');
  applyEvent(w, 'Notification', { session_id: 's', notification_type: 'idle_prompt', message: 'waiting for your input' });
  assert.equal(w.s.attention.reason, 'idle');
  applyEvent(w, 'PreToolUse', { session_id: 's', tool_name: 'Bash', tool_use_id: 't', tool_input: {} });
  assert.equal(w.s.attention, null);                            // real activity clears "needs you"
});

test('applyEvent: Stop finishes the turn WITHOUT faking "needs you"', () => {
  const w = fresh();
  applyEvent(w, 'UserPromptSubmit', { session_id: 's' });
  applyEvent(w, 'Stop', { session_id: 's' });
  assert.ok(w.s.finishedAt > 0);              // drives the one-shot "done" flash
  assert.equal(w.s.main.busy, false);         // no longer working
  assert.ok(!w.s.attention);                  // a normal finish is NOT "waiting for you"
  assert.equal(unitState(w.s.main), 'idle');
});

test('applyEvent: no session_id is unplaceable', () => {
  const w = fresh();
  assert.equal(applyEvent(w, 'Stop', {}), false);
  assert.deepEqual(Object.keys(w), []);
});

test('worldStuck: true only when a tool has been in flight past STUCK_AFTER', () => {
  const now = 1_000_000_000;
  const w = { main: newUnit(now), workers: {} };
  w.main.pending.set('t', { tool: 'Bash', cat: 'shell', startedAt: now - STUCK_AFTER - 1 });
  assert.equal(worldStuck(w, now), true);
  w.main.pending.clear();
  w.main.pending.set('t2', { tool: 'Bash', cat: 'shell', startedAt: now - 1000 });
  assert.equal(worldStuck(w, now), false);
});

test('watchdog: heals a dropped Stop (busy+idle+silent → not busy, no fake attention)', () => {
  const now = 2_000_000_000;
  const worlds = fresh();
  worlds.s = { status: 'active', lastSeen: now, main: newUnit(now), workers: {} };
  worlds.s.main.busy = true;
  worlds.s.main.lastSeen = now - THINK_MAX - 1;
  const changed = watchdog(worlds, now);
  assert.equal(changed, true);
  assert.equal(worlds.s.main.busy, false);
  assert.ok(!worlds.s.attention);   // waiting comes only from a Notification, not the watchdog
});

test('watchdog: removes an idle+quiet subagent, keeps a busy one', () => {
  const now = 3_000_000_000;
  const worlds = fresh();
  worlds.s = { status: 'active', lastSeen: now, main: newUnit(now), workers: {} };
  worlds.s.workers.gone = newUnit(now); worlds.s.workers.gone.lastSeen = now - WORKER_GONE_AFTER - 1;
  worlds.s.workers.busy = newUnit(now); worlds.s.workers.busy.lastSeen = now - WORKER_GONE_AFTER - 1;
  worlds.s.workers.busy.pending.set('t', { tool: 'Bash', cat: 'shell', startedAt: now });
  watchdog(worlds, now);
  assert.equal(worlds.s.workers.gone, undefined);
  assert.ok(worlds.s.workers.busy);
});

test('watchdog: removes a GHOST subagent (silent + stale pending) but keeps one mid long tool', () => {
  const now = 3_500_000_000;
  const worlds = fresh();
  worlds.s = { status: 'active', lastSeen: now, main: newUnit(now), workers: {} };
  // ghost: silent past WORKER_GONE_AFTER AND its only pending tool is itself stale (dropped SubagentStop)
  worlds.s.workers.ghost = newUnit(now); worlds.s.workers.ghost.lastSeen = now - WORKER_GONE_AFTER - 1;
  worlds.s.workers.ghost.pending.set('t', { tool: 'Bash', cat: 'shell', startedAt: now - STUCK_AFTER - 1 });
  // alive-but-slow: silent, but its pending tool is fresh (a legit long-running tool just started)
  worlds.s.workers.slow = newUnit(now); worlds.s.workers.slow.lastSeen = now - WORKER_GONE_AFTER - 1;
  worlds.s.workers.slow.pending.set('t', { tool: 'Bash', cat: 'shell', startedAt: now - 1000 });
  watchdog(worlds, now);
  assert.equal(worlds.s.workers.ghost, undefined, 'ghost (quiet + stuck pending) removed');
  assert.ok(worlds.s.workers.slow, 'a worker mid fresh tool is kept');
});

test('watchdog: ghost world removed after WORLD_REMOVE_AFTER', () => {
  const now = 4_000_000_000;
  const worlds = fresh();
  worlds.dead = { status: 'active', lastSeen: now - WORLD_REMOVE_AFTER - 1, main: newUnit(now), workers: {} };
  watchdog(worlds, now);
  assert.equal(worlds.dead, undefined);
});

test('watchdog: sets stuck flag when a tool hangs', () => {
  const now = 5_000_000_000;
  const worlds = fresh();
  worlds.s = { status: 'active', lastSeen: now, main: newUnit(now), workers: {} };
  worlds.s.main.pending.set('t', { tool: 'Bash', cat: 'shell', startedAt: now - STUCK_AFTER - 1 });
  watchdog(worlds, now);
  assert.equal(worlds.s._stuck, true);
});

test('serializeUnit: exposes derived state + lastTool + busySince', () => {
  const now = 6_000_000_000;
  const u = newUnit(now);
  u.lastTool = 'Edit';
  u.pending.set('t', { tool: 'Edit', cat: 'edit', startedAt: now });
  const s = serializeUnit(u);
  assert.equal(s.lastTool, 'Edit');
  assert.equal(s.busySince, now);
  assert.ok(s.state.startsWith('working:'));
});

test('parseTranscript: extracts title, entries, files, tokens', () => {
  const lines = [
    JSON.stringify({ type: 'ai-title', aiTitle: 'My Session' }),
    JSON.stringify({ type: 'user', message: { content: 'hello' }, timestamp: '2026-01-01T00:00:00Z' }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-01-01T00:01:00Z', message: {
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2, cache_creation_input_tokens: 3 },
      content: [
        { type: 'thinking', thinking: 'hmm' },
        { type: 'text', text: 'hi there' },
        { type: 'tool_use', id: 'tu1', name: 'Edit', input: { file_path: 'a.js', old_string: 'x', new_string: 'y' } },
      ],
    } }),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'done', is_error: false }] } }),
  ].join('\n');
  const d = parseTranscript(lines);
  assert.equal(d.title, 'My Session');
  const kinds = d.entries.map((e) => e.k);
  assert.deepEqual(kinds, ['user', 'think', 'say', 'tool', 'result']);
  const tool = d.entries.find((e) => e.k === 'tool');
  assert.equal(tool.name, 'Edit');
  assert.equal(tool.input.file_path, 'a.js');
  const result = d.entries.find((e) => e.k === 'result');
  assert.equal(result.id, 'tu1');
  assert.equal(result.text, 'done');
  assert.equal(d.stats.tools, 1);
  assert.equal(d.stats.files, 1);
  assert.equal(d.stats.tokIn, 10);
  assert.equal(d.stats.tokOut, 5);
  assert.equal(d.stats.tokTotal, 20);       // 10+5+2+3
  assert.ok(d.stats.startTs < d.stats.endTs);
});

test('parseTranscript: latest ai-title wins; malformed lines skipped', () => {
  const lines = [
    JSON.stringify({ type: 'ai-title', aiTitle: 'First' }),
    'not json at all',
    JSON.stringify({ type: 'ai-title', aiTitle: 'Second' }),
  ].join('\n');
  assert.equal(parseTranscript(lines).title, 'Second');
});

test('pickToolInput/resultText/cmdSummary basics', () => {
  const e = pickToolInput('Edit', { file_path: 'a.js', old_string: 'x', new_string: 'y', extra: 'drop' });
  assert.deepEqual(Object.keys(e).sort(), ['file_path', 'new_string', 'old_string']);
  assert.equal(resultText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'a\nb');
  assert.equal(cmdSummary('Bash', { command: 'npm test' }), 'npm test');
});

test('toSaved/fromSaved: round-trips sessions, drops in-flight state and expired worlds', async () => {
  const { toSaved, fromSaved, WORLD_REMOVE_AFTER } = await import('../server/state.mjs');
  const worlds = {};
  applyEvent(worlds, 'SessionStart', { session_id: 's1', cwd: '/p', transcript_path: '/p/t.jsonl' });
  applyEvent(worlds, 'PreToolUse', { session_id: 's1', tool_name: 'Bash', tool_use_id: 'u1', tool_input: { command: 'npm test' } });
  applyEvent(worlds, 'PreToolUse', { session_id: 's1', agent_id: 'a1', tool_name: 'Read', tool_use_id: 'u2' });
  applyEvent(worlds, 'Notification', { session_id: 's1', notification_type: 'permission_prompt', message: 'ok?' });
  const saved = JSON.parse(JSON.stringify(toSaved(worlds)));     // must survive JSON
  const back = fromSaved(saved, {}, worlds.s1.lastSeen + 1000);
  assert.equal(back.s1.cwd, '/p');
  assert.equal(back.s1.attention.reason, 'permission');
  assert.equal(back.s1.main.lastCmd, 'npm test');
  assert.equal(back.s1.main.pending.size, 0, 'in-flight tools not restored');
  assert.deepEqual(Object.keys(back.s1.workers), [], 'subagents not restored');
  assert.equal(unitState(back.s1.main), 'idle');
  assert.deepEqual(fromSaved(saved, {}, worlds.s1.lastSeen + WORLD_REMOVE_AFTER + 1), {}, 'expired world dropped');
});

test('markPre: a tool with no summary field does not inherit the previous command', () => {
  const u = newUnit(0);
  markPre(u, 't1', 'Bash', { command: 'npm test' }, 1);
  markPre(u, 't2', 'mcp__some__tool', { foo: 1 }, 2);
  assert.equal(u.lastTool, 'mcp__some__tool');
  assert.equal(u.lastCmd, null);
});

test('activity timeline: classifies blocked/working/thinking/idle, buckets it, survives save/restore', async () => {
  const { activityOf, recordActivity, timelineSeries, toSaved, fromSaved, BUCKET_MS } = await import('../server/state.mjs');
  const worlds = {};
  applyEvent(worlds, 'SessionStart', { session_id: 't', cwd: '/p' });
  const w = worlds.t;
  const t0 = Math.ceil(Date.now() / BUCKET_MS) * BUCKET_MS;       // start of a fresh bucket
  assert.equal(activityOf(w), 'idle');
  recordActivity(w, t0, 1000);
  applyEvent(worlds, 'UserPromptSubmit', { session_id: 't' });
  assert.equal(activityOf(w), 'thinking');
  recordActivity(w, t0 + 1000, 2000);
  applyEvent(worlds, 'PreToolUse', { session_id: 't', agent_id: 'a', tool_name: 'Bash', tool_use_id: 'x' });
  assert.equal(activityOf(w), 'working', 'a subagent tool counts');
  recordActivity(w, t0 + 3000, 3000);
  applyEvent(worlds, 'Notification', { session_id: 't', notification_type: 'permission_prompt' });
  assert.equal(activityOf(w), 'blocked');
  recordActivity(w, t0 + 6000, 4000);
  const s = timelineSeries(w, t0 + 7000, 24);
  assert.deepEqual([s.idle[23], s.thinking[23], s.working[23], s.blocked[23]], [1000, 2000, 3000, 4000]);
  const back = fromSaved(JSON.parse(JSON.stringify(toSaved(worlds))), {}, t0 + 7000);
  assert.equal(timelineSeries(back.t, t0 + 7000, 24).blocked[23], 4000);
  w.status = 'dormant'; recordActivity(w, t0 + 8000, 5000);
  assert.equal(timelineSeries(w, t0 + 8000, 24).idle[23], 1000, 'ended sessions do not accrue');
});

test('only live sessions: SessionEnd removes the world; a dead claude process removes it too', async () => {
  const { watchdog, toSaved, fromSaved } = await import('../server/state.mjs');
  const worlds = {};
  applyEvent(worlds, 'SessionStart', { session_id: 'a' });
  applyEvent(worlds, 'SessionStart', { session_id: 'b' });
  applyEvent(worlds, 'SessionStart', { session_id: 'c' });
  applyEvent(worlds, 'SessionEnd', { session_id: 'a' });
  assert.equal(worlds.a, undefined, 'exited session is gone at once');
  worlds.b.pid = 111; worlds.c.pid = 222;
  assert.equal(fromSaved(JSON.parse(JSON.stringify(toSaved(worlds))), {}).b.pid, 111, 'pid survives a restart');
  const changed = watchdog(worlds, Date.now(), (pid) => pid !== 111);
  assert.ok(changed);
  assert.deepEqual(Object.keys(worlds), ['c'], 'closed terminal (dead pid) is gone; live one stays');
});

test('reconcilePids: extra pid-less sessions in a folder are dead; a 1:1 match adopts the pid', async () => {
  const { reconcilePids } = await import('../server/state.mjs');
  const w = (cwd, lastSeen, pid) => ({ cwd, lastSeen, pid, main: newUnit(0), workers: {} });
  const worlds = {
    live: w('/a', 100, 7),          // known pid 7 (claims one of /a's processes)
    newer: w('/a', 90), older: w('/a', 50),   // 2 pid-less in /a, but only 1 unclaimed process there
    solo: w('/b', 10),              // 1 pid-less in /b, exactly 1 process → adopt
    gone: w('/c', 10),              // no claude process in /c at all → dead
  };
  const changed = reconcilePids(worlds, new Map([['/a', [7, 8]], ['/b', [9]]]));
  assert.ok(changed);
  assert.deepEqual(Object.keys(worlds).sort(), ['live', 'newer', 'solo']);
  assert.equal(worlds.solo.pid, 9, 'sole match adopts the pid');
  assert.equal(worlds.newer.pid, undefined, 'ambiguous → keep, learn the pid from its next event');
});
