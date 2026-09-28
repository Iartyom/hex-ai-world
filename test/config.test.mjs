/*
 * Unit tests for the pure / deterministic config + geometry logic.
 * Node built-in runner only (node:test + node:assert) — no npm deps.
 * These modules are side-effect-free (no server, no browser globals) so they
 * import cleanly under `node --test`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { WORLDS, worldFramePath } from '../config/worlds.mjs';
import {
  UNIT, NEAREST_CARDINAL, DIRS8, dirFromAngle, framePath,
} from '../config/units.mjs';
import {
  TOOL_CATEGORY, DEFAULT_CATEGORY, categoryFor,
  WORKER_BEHAVIOR, DEFAULT_WORKER_BEHAVIOR,
} from '../config/behaviors.mjs';
import {
  CATEGORY_COLOR, IDLE_COLOR, DEFAULT_ACCENT,
  MOTION, DEFAULT_MOTION,
} from '../config/theme.mjs';
import { axialToPixel, spiralCells, hexCorners } from '../public/hexgrid.mjs';

// ---------------------------------------------------------------------------
// config/worlds.mjs
// ---------------------------------------------------------------------------
test('worldFramePath zero-pads the frame index to 3 digits', () => {
  assert.equal(worldFramePath('cyan', 0), '/assets/worlds/anim/cyan/frame_000.png');
  assert.equal(worldFramePath('red', 7), '/assets/worlds/anim/red/frame_007.png');
  assert.equal(worldFramePath('green', 42), '/assets/worlds/anim/green/frame_042.png');
  assert.equal(worldFramePath('blue', 123), '/assets/worlds/anim/blue/frame_123.png');
});

test('WORLDS have unique ids and required fields', () => {
  const ids = WORLDS.map((w) => w.id);
  assert.equal(new Set(ids).size, ids.length, 'ids are unique');
  for (const w of WORLDS) {
    assert.equal(typeof w.id, 'string');
    assert.equal(typeof w.color, 'number');
    assert.match(w.file, /^\/assets\/worlds\/.*\.png$/);
  }
});

// ---------------------------------------------------------------------------
// config/units.mjs
// ---------------------------------------------------------------------------
test('dirFromAngle maps the four cardinals correctly (y-down screen space)', () => {
  assert.equal(dirFromAngle(0), 'east');            // 0°
  assert.equal(dirFromAngle(Math.PI / 2), 'south'); // +90° = down/front
  assert.equal(dirFromAngle(Math.PI), 'west');      // 180°
  assert.equal(dirFromAngle(-Math.PI / 2), 'north');// -90° = up
  assert.equal(dirFromAngle(3 * Math.PI / 2), 'north'); // 270°
});

test('dirFromAngle maps the four diagonals correctly', () => {
  assert.equal(dirFromAngle(Math.PI / 4), 'south-east');       // 45°
  assert.equal(dirFromAngle(3 * Math.PI / 4), 'south-west');   // 135°
  assert.equal(dirFromAngle(-3 * Math.PI / 4), 'north-west');  // 225°
  assert.equal(dirFromAngle(-Math.PI / 4), 'north-east');      // 315°
});

test('dirFromAngle returns a valid DIRS8 name across the atan2 domain [-π, π]', () => {
  // The sole caller feeds Math.atan2 output, so this is the real input contract.
  // (NOTE: angles below ~-2π currently break — JS `%` keeps a negative sign — but
  //  that is outside the atan2 range; see the report's untested/known-issues list.)
  assert.equal(dirFromAngle(2 * Math.PI), 'east');           // positive full turn = 0°
  assert.equal(dirFromAngle(2 * Math.PI + Math.PI / 2), 'south');
  for (let a = -Math.PI; a <= Math.PI; a += 0.05) {
    assert.ok(DIRS8.includes(dirFromAngle(a)), `angle ${a} → a valid DIRS8 name`);
  }
});

test('DIRS8 has 8 unique compass directions', () => {
  assert.equal(DIRS8.length, 8);
  assert.equal(new Set(DIRS8).size, 8);
});

test('NEAREST_CARDINAL snaps every DIRS8 name to a cardinal', () => {
  const cardinals = new Set(['north', 'south', 'east', 'west']);
  for (const d of DIRS8) {
    assert.ok(cardinals.has(NEAREST_CARDINAL[d]), `${d} snaps to a cardinal`);
  }
  assert.equal(NEAREST_CARDINAL['south-east'], 'east');
  assert.equal(NEAREST_CARDINAL['north-west'], 'west');
  assert.equal(NEAREST_CARDINAL.south, 'south');
});

test('framePath builds a zero-padded animation frame path from UNIT.base', () => {
  assert.equal(framePath('walk', 'south', 0), `${UNIT.base}/animations/walk/south/frame_000.png`);
  assert.equal(framePath('work', 'south', 9), `${UNIT.base}/animations/work/south/frame_009.png`);
});

test('UNIT.anims dirLists are subsets of DIRS8', () => {
  for (const [name, anim] of Object.entries(UNIT.anims)) {
    for (const d of anim.dirList) {
      assert.ok(DIRS8.includes(d), `${name} dir ${d} is a valid DIRS8 name`);
    }
    assert.ok(anim.frames > 0 && anim.fps > 0, `${name} has positive frames/fps`);
  }
});

// ---------------------------------------------------------------------------
// config/behaviors.mjs
// ---------------------------------------------------------------------------
test('categoryFor maps known tools and falls back for unknown ones', () => {
  assert.equal(categoryFor('Bash'), 'shell');
  assert.equal(categoryFor('PowerShell'), 'shell');
  assert.equal(categoryFor('Edit'), 'edit');
  assert.equal(categoryFor('Write'), 'edit');
  assert.equal(categoryFor('Read'), 'read');
  assert.equal(categoryFor('Grep'), 'read');
  assert.equal(categoryFor('Agent'), 'spawn');
  assert.equal(categoryFor('WebFetch'), 'web');
  assert.equal(categoryFor('SomeFutureTool'), DEFAULT_CATEGORY);
  assert.equal(categoryFor(undefined), DEFAULT_CATEGORY);
});

test('every TOOL_CATEGORY value has a matching working:<cat> behavior', () => {
  const cats = new Set(Object.values(TOOL_CATEGORY));
  cats.add(DEFAULT_CATEGORY);
  for (const c of cats) {
    assert.ok(`working:${c}` in WORKER_BEHAVIOR, `working:${c} is defined in WORKER_BEHAVIOR`);
  }
});

// ---------------------------------------------------------------------------
// config/theme.mjs
// ---------------------------------------------------------------------------
test('CATEGORY_COLOR covers every non-idle tool category', () => {
  const cats = new Set(Object.values(TOOL_CATEGORY));
  cats.add(DEFAULT_CATEGORY);
  for (const c of cats) {
    assert.equal(typeof CATEGORY_COLOR[c], 'number', `CATEGORY_COLOR has ${c}`);
  }
  assert.equal(typeof IDLE_COLOR, 'number');
  assert.equal(typeof DEFAULT_ACCENT, 'number');
});

test('MOTION entries have a kind and numeric amp/period', () => {
  for (const [name, m] of Object.entries(MOTION)) {
    assert.equal(typeof m.kind, 'string', `${name}.kind`);
    assert.equal(typeof m.amp, 'number', `${name}.amp`);
    assert.ok(m.period > 0, `${name}.period > 0`);
  }
  assert.equal(typeof DEFAULT_MOTION.kind, 'string');
});

// ---------------------------------------------------------------------------
// public/hexgrid.mjs  (pure geometry — imports nothing side-effectful)
// ---------------------------------------------------------------------------
test('axialToPixel maps the origin to (0,0)', () => {
  assert.deepEqual(axialToPixel(0, 0, 50), { x: 0, y: 0 });
});

test('axialToPixel spaces columns by 1.5*size and rows by sqrt(3)*size', () => {
  assert.equal(axialToPixel(1, 0, 10).x, 15);            // 10 * 1.5 * 1
  assert.ok(Math.abs(axialToPixel(0, 1, 10).y - 10 * Math.sqrt(3)) < 1e-9);
});

test('spiralCells returns exactly count unique cells starting at center', () => {
  for (const n of [1, 2, 7, 19, 50]) {
    const cells = spiralCells(n);
    assert.equal(cells.length, n, `count ${n}`);
    assert.deepEqual(cells[0], { q: 0, r: 0 }, 'first cell is center');
    const keys = new Set(cells.map((c) => `${c.q},${c.r}`));
    assert.equal(keys.size, n, `all ${n} cells are unique`);
  }
});

test('hexCorners returns 6 points on a circle of radius=size', () => {
  const pts = hexCorners(20);
  assert.equal(pts.length, 6);
  for (const p of pts) {
    assert.ok(Math.abs(Math.hypot(p.x, p.y) - 20) < 1e-9, 'point lies on radius');
  }
});
