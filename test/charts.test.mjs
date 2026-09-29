import { test } from 'node:test';
import assert from 'node:assert/strict';
import { barChart, fmtUsd, fmtDur } from '../public/charts.mjs';

test('barChart: one mark per non-zero value, tallest = max, titles escaped', () => {
  const svg = barChart([0, 2, 4, 0], { w: 40, h: 20, titles: ['a', 'b', '<x>', 'd'] });
  assert.equal((svg.match(/<path /g) || []).length, 2, 'zeros draw nothing');
  assert.match(svg, / 23\.0,1\.0 /, 'max value reaches the top (y = 1)');
  assert.match(svg, /<rect x="10\.0" /, 'hit target covers its whole slot');
  assert.ok(svg.includes('&lt;x&gt;') && !svg.includes('<x>'));
  assert.equal((barChart([0, 0]).match(/<path /g) || []).length, 0, 'all-zero series is just a baseline');
});

test('fmtUsd / fmtDur', () => {
  assert.equal(fmtUsd(0.004), '<$0.01');
  assert.equal(fmtUsd(12.345), '$12.35');
  assert.equal(fmtUsd(null), '—');
  assert.equal(fmtDur(90 * 60_000), '1h 30m');
});

test('stackedBars: segments stack bottom→top, scaled to `full`, empty columns draw nothing', async () => {
  const { stackedBars } = await import('../public/charts.mjs');
  const svg = stackedBars([{ values: [0, 50], color: '#a' }, { values: [0, 50], color: '#b' }], 100, { w: 20, h: 20 });
  const rects = [...svg.matchAll(/<rect x="[\d.]+" y="([\d.]+)" width="[\d.]+" height="([\d.]+)" fill="(#\w)"/g)].map((m) => [m[3], +m[1], +m[2]]);
  assert.deepEqual(rects.map((r) => r[0]), ['#a', '#b'], 'only the non-empty column, bottom layer first');
  assert.equal(rects[0][1], 10, 'bottom half starts at mid-height');
  assert.equal(rects[1][1], 0, 'second layer fills to the top (100% of full)');
});
