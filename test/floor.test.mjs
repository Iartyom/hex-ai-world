import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeFloor, makeSpacing } from '../public/floor.mjs';

// Same wander loop as render.mjs's ticker (walk to target, dwell, pick a new target) ± spacing.
function simulate({ n, frames, spacing, withSpacing, working = [] }) {
  const floor = makeFloor(320), sp = makeSpacing(floor, spacing);
  const units = [];
  for (let i = 0; i < n; i++) {
    const p = withSpacing ? sp.clearPoint(units, null) : floor.randomFloorPoint();
    units.push({ _px: p.x, _py: p.y, _tx: p.x, _ty: p.y, _moving: false, _dwell: Math.random() * 500, _working: working.includes(i) });
  }
  let overlapFrames = 0;
  for (let f = 0; f < frames; f++) {
    for (const u of units) {
      if (!u._working) {
        if (u._moving) {
          const dx = u._tx - u._px, dy = u._ty - u._py, d = Math.hypot(dx, dy);
          if (d < 2) { u._moving = false; u._dwell = 500 + Math.random() * 2500; }
          else { const step = Math.min(d, 56 * 16 / 1000); u._px += (dx / d) * step; u._py += (dy / d) * step; }
        } else if ((u._dwell -= 16) <= 0) {
          const t = withSpacing ? sp.clearPoint(units, u) : floor.randomFloorPoint(); u._tx = t.x; u._ty = t.y; u._moving = true;
        }
      }
      if (withSpacing) sp.separate(u, units);
    }
    let close = false;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (sp.isoDist(units[i]._px, units[i]._py, units[j]._px, units[j]._py) < spacing * 0.6) close = true;
    if (close && f > 60) overlapFrames++;          // allow the first second to settle
  }
  return (100 * overlapFrames) / frames;
}

test('spacing: robots rarely overlap, and far less than without it', () => {
  const spacing = 320 * 0.085;
  const off = simulate({ n: 6, frames: 3000, spacing, withSpacing: false });
  const on = simulate({ n: 6, frames: 3000, spacing, withSpacing: true, working: [0, 3] });
  console.log(`# overlap: ${off.toFixed(1)}% of frames without spacing → ${on.toFixed(1)}% with it`);
  assert.ok(on < 2, `with spacing: overlapping ${on.toFixed(1)}% of frames`);
  assert.ok(off > on * 3, `baseline ${off.toFixed(1)}% should be much worse`);
});

test('spacing: a push never moves a robot off the deck; a working robot holds still', () => {
  const floor = makeFloor(320), sp = makeSpacing(floor, 27);
  // Two robots squeezed together at the deck's front edge, one of them working.
  const edge = { x: floor.FLOOR.cx, y: floor.FLOOR.cy + floor.FLOOR.ry * 0.97 };
  const a = { _px: edge.x, _py: edge.y, _tx: edge.x, _ty: edge.y, _working: true };
  const b = { _px: edge.x + 3, _py: edge.y - 1, _tx: edge.x + 3, _ty: edge.y - 1 };
  for (let i = 0; i < 400; i++) { sp.separate(a, [a, b]); sp.separate(b, [a, b]); assert.ok(floor.onFloor(b._px, b._py)); }
  assert.equal(a._px, edge.x, 'the working robot never moved');
  assert.ok(sp.isoDist(a._px, a._py, b._px, b._py) > 20, 'the other one moved away along the deck');
});
