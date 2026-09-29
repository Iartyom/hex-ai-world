/*
 * Anthropic first-party API prices, $ per million tokens (Claude API pricing, as cached 2026-09-25).
 * Used to turn transcript `usage` into dollars. `read` = cache-read price when it isn't the usual
 * 0.1× input. Cache WRITES are 1.25× input (5-minute TTL) and 2× input (1-hour TTL); fast mode is 2×.
 * Keys match by prefix, so dated IDs like claude-haiku-4-5-20251001 resolve. Unknown model → null
 * (the UI shows the cost as partial instead of inventing a number).
 */
export const PRICING = {
  'claude-fable-5-1':  { in: 10, out: 50, read: 0.25 },
  'claude-mythos-5-1': { in: 10, out: 50, read: 0.25 },
  'claude-fable-5':    { in: 10, out: 50 },
  'claude-opus-5-5':   { in: 4,  out: 20, read: 0.20 },
  'claude-opus-5':     { in: 5,  out: 25 },
  'claude-opus-4-8':   { in: 5,  out: 25 },
  'claude-opus-4-7':   { in: 5,  out: 25 },
  'claude-opus-4-6':   { in: 5,  out: 25 },
  'claude-sonnet-5-5': { in: 2,  out: 10, read: 0.20 },
  'claude-sonnet-5':   { in: 2,  out: 10 },
  'claude-sonnet-4-6': { in: 3,  out: 15 },
  'claude-haiku-4-5':  { in: 1,  out: 5 },
};

// Longest matching prefix wins ('claude-opus-5-5' must not resolve to 'claude-opus-5').
const KEYS = Object.keys(PRICING).sort((a, b) => b.length - a.length);
export const priceFor = (model) => { const k = model && KEYS.find((p) => model.startsWith(p)); return k ? PRICING[k] : null; };

/** Dollar cost of one API response's `usage`, or null if the model has no known price. */
export function costOf(model, u) {
  if (!u) return null;
  const cc = u.cache_creation;                           // split by TTL when present
  const w1h = cc ? cc.ephemeral_1h_input_tokens || 0 : 0;
  const w5m = cc ? cc.ephemeral_5m_input_tokens || 0 : u.cache_creation_input_tokens || 0;
  // Zero tokens costs $0 whatever the model — e.g. Claude Code's "<synthetic>" placeholder messages.
  if (!(u.input_tokens || u.output_tokens || u.cache_read_input_tokens || w5m || w1h)) return 0;
  const p = priceFor(model);
  if (!p) return null;
  const read = p.read ?? p.in * 0.1;
  const usd = ((u.input_tokens || 0) * p.in + (u.output_tokens || 0) * p.out
    + (u.cache_read_input_tokens || 0) * read + w5m * p.in * 1.25 + w1h * p.in * 2) / 1e6;
  return u.speed === 'fast' ? usd * 2 : usd;
}
