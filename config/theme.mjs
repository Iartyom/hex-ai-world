/*
 * Visual theme for the render layer (Phase 2+). Single source of truth for colors
 * and per-behavior motion, imported by the browser render code. StarCraft-style:
 * per-session TEAM colors, per-tool-category ACCENT colors, and MOTION params that
 * turn each locked behavior key into a distinct placeholder animation.
 *
 * Colors are 0xRRGGBB numbers (PixiJS-native). Tune freely — keep the KEYS aligned
 * with config/behaviors.mjs (categories) and WORKER_BEHAVIOR values (motion names).
 */

// Per-session base colors (classic RTS player colors). Assigned stably by hash.
export const TEAM_COLORS = [
  0xff4d4d, 0x4d7cff, 0x2fd6c3, 0xb26bff,
  0xff9a2e, 0xf0e04a, 0x49d65e, 0xff77c2,
];

// Deterministic sessionId -> team color (stable across reconnects/updates).
export function teamColorFor(sessionId) {
  let h = 0;
  for (let i = 0; i < sessionId.length; i++) h = (h * 31 + sessionId.charCodeAt(i)) >>> 0;
  return TEAM_COLORS[h % TEAM_COLORS.length];
}

// Per-tool-category accent color (category comes from config/behaviors.mjs).
export const CATEGORY_COLOR = {
  shell: 0x49b6ff, // harvest — mineral-blue laser
  edit:  0xffa733, // weld — orange sparks
  read:  0x5ee36a, // scan — green sweep
  spawn: 0xc06bff, // warp — purple rift
  web:   0x45e6e6, // uplink — cyan beam
  tool:  0xb4b7c9, // operate — neutral
};
export const IDLE_COLOR = 0x8a94ad;      // standby (waiting on model)
export const DEFAULT_ACCENT = 0xb4b7c9;

// Per-behavior placeholder MOTION. `kind` picks the animation in render.mjs;
// amp/period are tuned so categories look DISTINCT (the readability test for GATE 2).
export const MOTION = {
  standby: { kind: 'bob',     amp: 2,  period: 1800 }, // gentle hover
  harvest: { kind: 'jab',     amp: 6,  period: 380  }, // quick vertical mining jab
  weld:    { kind: 'flicker', amp: 0,  period: 90   }, // rapid brightness flicker
  scan:    { kind: 'sweep',   amp: 7,  period: 900  }, // horizontal scanner sweep
  warp:    { kind: 'pulse',   amp: 0.5, period: 700 }, // scale in/out
  uplink:  { kind: 'beam',    amp: 8,  period: 1100 }, // vertical stretch
  operate: { kind: 'tap',     amp: 3,  period: 500  }, // small tap
};
export const DEFAULT_MOTION = { kind: 'bob', amp: 2, period: 1500 };
