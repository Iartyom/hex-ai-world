import { test } from 'node:test';
import assert from 'node:assert/strict';
import { costOf, priceFor } from '../config/pricing.mjs';
import { parseTranscript, newTranscriptState, feedTranscript, BUCKET_MS } from '../server/state.mjs';

const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≈ ${b}`);

test('priceFor: longest prefix wins; dated ids resolve; unknown → null', () => {
  assert.equal(priceFor('claude-opus-5-5').in, 4);             // not claude-opus-5's $5
  assert.equal(priceFor('claude-opus-5').in, 5);
  assert.equal(priceFor('claude-haiku-4-5-20251001').in, 1);
  assert.equal(priceFor('gpt-9'), null);
});

test('costOf: input/output/cache-read/5m+1h writes, fast mode 2x', () => {
  // opus-5-5: in 4, out 20, read 0.20 ; 5m write 5.00, 1h write 8.00 ($/MTok)
  const u = { input_tokens: 1e6, output_tokens: 1e6, cache_read_input_tokens: 1e6,
    cache_creation: { ephemeral_5m_input_tokens: 1e6, ephemeral_1h_input_tokens: 1e6 } };
  near(costOf('claude-opus-5-5', u), 4 + 20 + 0.2 + 5 + 8);
  near(costOf('claude-opus-5-5', { ...u, speed: 'fast' }), 2 * (4 + 20 + 0.2 + 5 + 8));
  near(costOf('claude-opus-4-8', { cache_read_input_tokens: 1e6 }), 0.5);      // default 0.1× input
  near(costOf('claude-sonnet-4-6', { cache_creation_input_tokens: 1e6 }), 3.75); // no split → 5-minute
  assert.equal(costOf('mystery-model', u), null);
  assert.equal(costOf('<synthetic>', { input_tokens: 0, output_tokens: 0 }), 0, 'zero-token placeholder is free, not unpriced');
});

test('parseTranscript: usage repeated on each content-block line is counted ONCE per message.id', () => {
  const usage = { input_tokens: 100, output_tokens: 1000 };
  const line = (type) => JSON.stringify({ type: 'assistant', timestamp: '2026-09-01T10:00:00Z',
    message: { id: 'msg_1', model: 'claude-opus-5-5', usage, content: [{ type }] } });
  const d = parseTranscript([line('thinking'), line('text'), line('tool_use')].join('\n'));
  assert.equal(d.stats.tokOut, 1000);
  near(d.stats.cost, (100 * 4 + 1000 * 20) / 1e6);
  assert.equal(d.stats.costPartial, false);
});

test('unknown model → costPartial; buckets, days and active time accumulate incrementally', () => {
  const s = newTranscriptState();
  const at = (iso, id, model = 'claude-opus-5-5') => JSON.stringify({ type: 'assistant', timestamp: iso,
    message: { id, model, usage: { output_tokens: 1e6 }, content: [{ type: 'tool_use', name: 'Bash', input: {} }] } });
  feedTranscript(s, at('2026-09-01T10:00:00Z', 'a'));
  feedTranscript(s, at('2026-09-01T10:02:00Z', 'b'));             // 2 min later → active
  feedTranscript(s, at('2026-09-01T11:00:00Z', 'c', 'mystery'));  // 58 min gap → not active; unpriced
  assert.equal(s.activeMs, 2 * 60_000);
  assert.equal(s.tools, 3);
  near(s.cost, 40);
  assert.equal(s.unpriced, 1);
  const first = s.buckets.get(Date.parse('2026-09-01T10:00:00Z') - (Date.parse('2026-09-01T10:00:00Z') % BUCKET_MS));
  assert.equal(first.tools, 2);
  const day = [...s.days.values()].reduce((a, d) => a + d.tools, 0);
  assert.equal(day, 3);
});

test('recentSeries + summarize: bucket placement, project rollup, session counting', async () => {
  const { recentSeries, summarize, dayKey } = await import('../server/state.mjs');
  const s = newTranscriptState();
  const t0 = Date.parse('2026-09-01T10:00:00Z');
  const line = (ts, id) => JSON.stringify({ type: 'assistant', timestamp: new Date(ts).toISOString(), cwd: '/proj/a',
    message: { id, model: 'claude-opus-5-5', usage: { output_tokens: 1e6 }, content: [{ type: 'tool_use', name: 'Bash', input: {} }] } });
  feedTranscript(s, [line(t0, 'a'), line(t0 + 60_000, 'b')].join('\n'));
  const now = t0 + 10 * 60_000;
  const ser = recentSeries([s], now, 24);
  assert.equal(ser.tools.reduce((a, b) => a + b, 0), 2);
  assert.equal(ser.tools[ser.tools.length - 1], 0, 'latest bucket empty');
  assert.equal(ser.tools[21], 2, 'both calls land 2 buckets (10 min) back');
  const sub = newTranscriptState(); feedTranscript(sub, line(t0 + 120_000, 'c'));
  const sum = summarize([{ st: s, isSession: true }, { st: sub, isSession: false }], now, 3);
  assert.equal(sum.days.at(-1), dayKey(now));
  assert.equal(sum.projects.length, 1);
  assert.equal(sum.projects[0].sessions, 1, 'subagent file is not a session');
  assert.equal(sum.projects[0].tools, 3);
  near(sum.projects[0].cost, 60);
  near(sum.total.cost.at(-1), 60);
});
