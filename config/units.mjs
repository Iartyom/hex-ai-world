/*
 * SINGLE SOURCE OF TRUTH for the worker unit's animation set (Phase 3 units).
 * Frames live under public/assets/units/worker/animations/<anim>/<dir>/frame_NNN.png
 * (exported from PixelLab character 780f6e4f). walk + standby have all 8 directions;
 * the in-place work behaviors are south-only (extend to 8-dir later by regenerating).
 *
 * Animation names match the behavior vocabulary in behaviors.mjs (harvest/weld/scan/…),
 * plus `walk` (used while moving) and `powerdown` (dormant world). To add/alter a clip
 * you edit ONLY this file after dropping its frames in the folder above.
 */
export const UNIT = {
  base: '/assets/units/worker',
  // Current character: mining-harvester robot 29bca932 — walk + idle pulled (8-dir, 8f).
  // Work behaviors (harvest/weld/…) are being regenerated on this robot; until pulled,
  // working states fall back to `standby` in the renderer. Re-add them here on pull.
  // fps are 80% of their natural rate (user: "80% speed") so the robots move a touch calmer.
  anims: {
    walk:    { frames: 8, fps: 11.2, loop: true, dirList: ['south', 'south-east', 'east', 'north-east', 'north', 'north-west', 'west', 'south-west'] },
    standby: { frames: 8, fps: 6.4,  loop: true, dirList: ['south', 'south-east', 'east', 'north-east', 'north', 'north-west', 'west', 'south-west'] },
    // Single shared "working" clip = "robot arms pulses" (PixelLab GIF, 60x60, 9f, extracted to
    // work/south/frame_NNN.png). South-only, in-place — reused for EVERY facing (renderer falls
    // back to south for any missing direction; an in-place arm pulse reads fine from any angle).
    work:    { frames: 9, fps: 9.6, loop: true, dirList: ['south'] },
  },
};

// Snap an 8-way heading name to the nearest cardinal (for 4-direction clips like `work`).
export const NEAREST_CARDINAL = {
  south: 'south', north: 'north', east: 'east', west: 'west',
  'south-east': 'east', 'north-east': 'east', 'south-west': 'west', 'north-west': 'west',
};

// The 8 compass directions PixelLab exports (folder names).
export const DIRS8 = ['south', 'south-east', 'east', 'north-east', 'north', 'north-west', 'west', 'south-west'];

// Movement heading (radians, screen space y-down) → nearest compass folder name.
// east=0°, south=+90° (down/front), west=180°, north=270°.
export function dirFromAngle(rad) {
  // mod-before-add so any input (incl. rad < -2π) maps into [0,360); JS % keeps the dividend's sign.
  const deg = ((rad * 180 / Math.PI) % 360 + 360) % 360;
  const names = ['east', 'south-east', 'south', 'south-west', 'west', 'north-west', 'north', 'north-east'];
  return names[Math.round(deg / 45) % 8];
}

export const framePath = (anim, dir, i) => `${UNIT.base}/animations/${anim}/${dir}/frame_${String(i).padStart(3, '0')}.png`;
export const rotationPath = (dir) => `${UNIT.base}/rotations/${dir}.png`;
