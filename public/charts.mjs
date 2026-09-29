/*
 * Tiny inline-SVG bar charts (no chart library) for the hover tooltip and the 'd' panel. Pure: data in,
 * SVG string out, so it's unit-testable under Node. Mark specs follow the dataviz rules: one series
 * per chart (two measures → two charts, never a second y-axis), thin bars with a 2px surface gap,
 * rounded data-end / square baseline, recessive baseline, colors validated on the #0c111b surface.
 */
import { esc } from './pure.mjs';

export const SERIES = { activity: '#3987e5', cost: '#d95926' }; // validated dark-mode slots 1 + 2
// Session states, stacked bottom→top in this fixed order; idle is the empty space above (validated
// on #0c111b; green/amber match the board's working / needs-you glows).
export const STATE_COLORS = { working: '#199e70', thinking: '#3987e5', blocked: '#c98500' };
export const STATE_LABELS = { working: 'working', thinking: 'thinking', blocked: 'waiting on you', idle: 'idle' };
const AXIS = '#2a3346';

/**
 * values: numbers. opts: { w, h, color, titles?: string[] (per-bar hover text), highlightLast?: bool }.
 * Zero buckets draw nothing (the baseline shows the quiet time). Bars scale to the max value.
 */
export function barChart(values, { w = 200, h = 28, color = SERIES.activity, titles = null, highlightLast = false } = {}) {
  const n = values.length || 1;
  const gap = 2, slotW = w / n, barW = Math.max(1, Math.min(24, slotW - gap));
  const max = Math.max(0, ...values);
  const r = Math.min(2, barW / 2);
  let marks = '';
  values.forEach((v, i) => {
    const x = i * slotW + (slotW - barW) / 2;
    const bh = max > 0 && v > 0 ? Math.max(1.5, (v / max) * (h - 1)) : 0;
    const title = titles && titles[i] ? `<title>${esc(titles[i])}</title>` : '';
    // Hit target is the full slot height (bigger than the mark) so tiny bars are still hoverable.
    if (title) marks += `<rect x="${(i * slotW).toFixed(1)}" y="0" width="${slotW.toFixed(1)}" height="${h}" fill="transparent">${title}</rect>`;
    if (!bh) return;
    const y = h - bh;
    const op = highlightLast && i !== n - 1 ? 0.55 : 1;
    // Rounded top, square baseline: a path with arcs only on the two top corners.
    marks += `<path d="M${x.toFixed(1)},${h} V${(y + r).toFixed(1)} Q${x.toFixed(1)},${y.toFixed(1)} ${(x + r).toFixed(1)},${y.toFixed(1)} `
      + `H${(x + barW - r).toFixed(1)} Q${(x + barW).toFixed(1)},${y.toFixed(1)} ${(x + barW).toFixed(1)},${(y + r).toFixed(1)} V${h} Z" `
      + `fill="${color}" fill-opacity="${op}" pointer-events="none"/>`;
  });
  return `<svg class="hw-chart" width="${w}" height="${h + 1}" viewBox="0 0 ${w} ${h + 1}" role="img">`
    + `<line x1="0" y1="${h + 0.5}" x2="${w}" y2="${h + 0.5}" stroke="${AXIS}" stroke-width="1"/>${marks}</svg>`;
}

/**
 * Stacked columns: layers = [{ values, color }] bottom→top, each column scaled to `full` (e.g. 5 min
 * of ms) so empty space above a column = the remainder (idle). 1px surface gap between segments
 * (ponytail: the spec's 2px would eat a 22px-tall chart).
 */
export function stackedBars(layers, full, { w = 200, h = 28, titles = null } = {}) {
  const n = layers.length ? layers[0].values.length : 0;
  const slotW = w / (n || 1), barW = Math.max(1, Math.min(24, slotW - 2));
  let marks = '';
  for (let i = 0; i < n; i++) {
    const x = (i * slotW + (slotW - barW) / 2).toFixed(1);
    let y = h;
    for (const { values, color } of layers) {
      const seg = full > 0 ? (Math.min(values[i], full) / full) * h : 0;
      if (seg < 0.5) continue;
      const top = Math.max(0, y - seg);
      marks += `<rect x="${x}" y="${top.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(0.5, y - top - (y < h ? 1 : 0)).toFixed(1)}" fill="${color}" pointer-events="none"/>`;
      y = top;
    }
    if (titles && titles[i]) marks += `<rect x="${(i * slotW).toFixed(1)}" y="0" width="${slotW.toFixed(1)}" height="${h}" fill="transparent"><title>${esc(titles[i])}</title></rect>`;
  }
  return `<svg class="hw-chart" width="${w}" height="${h + 1}" viewBox="0 0 ${w} ${h + 1}" role="img">`
    + `<line x1="0" y1="${h + 0.5}" x2="${w}" y2="${h + 0.5}" stroke="${AXIS}" stroke-width="1"/>${marks}</svg>`;
}
/** Legend chips (identity is never color-alone). */
export const stateLegend = (keys = ['working', 'thinking', 'blocked']) => keys.map((k) =>
  `<span class="lg"><i style="background:${STATE_COLORS[k]}"></i>${STATE_LABELS[k]}</span>`).join('');

export const fmtUsd = (c) => (c == null ? '—' : c > 0 && c < 0.01 ? '<$0.01' : '$' + (c >= 100 ? c.toFixed(0) : c.toFixed(2)));
export function fmtDur(ms) {
  if (!ms || ms < 0) return '0m';
  const m = Math.round(ms / 60_000), h = Math.floor(m / 60);
  return h ? `${h}h ${m % 60}m` : `${m}m`;
}
