/*
 * SINGLE SOURCE OF TRUTH for the per-session "worlds" (the floating hex platforms).
 * Phase 3 art: each session is rendered as one of these StarCraft-style isometric
 * floating-hex-platform images (generated in PixelLab, saved under public/assets/worlds/).
 * The renderer assigns each active session a world at random (see public/alloc.mjs), reusing
 * freed worlds when sessions end so no two live sessions collide.
 *
 * To add/alter worlds you edit ONLY this file: drop a PNG in public/assets/worlds/
 * and add a row. `color` is the world's accent — also used to tint that session's
 * units so they read as belonging to their base.
 *
 * ANIMATED worlds: add `anim`. Two forms are supported:
 *   - spritesheet: { sheet, cols, rows, frames, fps } — one PNG grid (row-major), sliced
 *     into frame textures at runtime (what PixelLab's creator exports).
 *   - frame files:  { frames, fps } — individual /assets/worlds/anim/<id>/frame_NNN.png.
 * The renderer plays an AnimatedSprite backdrop, falling back to the static `file` if the
 * animation assets are missing. `cols*rows` should be >= `frames`.
 * fps 4.5 = 75% of a natural 6, so the platforms read as calm-but-alive, not busy.
 *
 * TOGGLE: animation is OFF by default (static PNGs). The `anim` rows below stay defined either way;
 * the renderer only loads their textures when the server env `HEX_WORLD_ANIM=1` is set (served to the
 * browser at /config/runtime.json). Env off → the static `file` is used. So the switch is env-only.
 */
const sheetAnim = (id) => ({ sheet: `/assets/worlds/anim/sheet-${id}.png`, cols: 3, rows: 3, frames: 9, fps: 4.5 });

export const WORLDS = [
  { id: 'cyan',   color: 0x39c6d6, file: '/assets/worlds/world-cyan.png',   elements: 'minerals + refinery',   anim: sheetAnim('cyan') },
  { id: 'red',    color: 0xe0533a, file: '/assets/worlds/world-red.png',    elements: 'extractor + fuel tanks', anim: sheetAnim('red') },
  { id: 'orange', color: 0xf0902a, file: '/assets/worlds/world-orange.png', elements: 'workbench + robot arm',  anim: sheetAnim('orange') },
  { id: 'green',  color: 0x4ad66a, file: '/assets/worlds/world-green.png',  elements: 'scanner + data console', anim: sheetAnim('green') },
  { id: 'purple', color: 0xa86bff, file: '/assets/worlds/world-purple.png', elements: 'warp gate + pylon',       anim: sheetAnim('purple') },
  { id: 'blue',   color: 0x4a90e2, file: '/assets/worlds/world-blue.png',   elements: 'satellite + uplink',     anim: sheetAnim('blue') },
  { id: 'teal',   color: 0x2fd7c4, file: '/assets/worlds/world-teal.png',   elements: 'bio tanks + pods',       anim: sheetAnim('teal') },
  { id: 'yellow', color: 0xf2d21a, file: '/assets/worlds/world-yellow.png', elements: 'reactor + capacitors',  anim: sheetAnim('yellow') },
  { id: 'pink',   color: 0xff6bd0, file: '/assets/worlds/world-pink.png',   elements: 'command hub + spires' },
  { id: 'white',  color: 0xdfe6f2, file: '/assets/worlds/world-white.png',  elements: 'depot + landing pad' },
];

// Frame path for an animated world using individual frame files (the non-spritesheet form).
export const worldFramePath = (id, i) => `/assets/worlds/anim/${id}/frame_${String(i).padStart(3, '0')}.png`;
