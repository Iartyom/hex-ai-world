/*
 * Walkable-floor geometry for the robots, factored out of render.mjs (pure, no Pixi/DOM, so it's
 * unit-testable). Coords are world-local (origin = platform center). The deck is an iso-flattened
 * ellipse MINUS the two back corners where a world's thematic elements sit — units wander the open
 * front/center but never stand on an element.
 */
export function makeFloor(WORLD_W) {
  const FLOOR = {
    cx: 0, cy: WORLD_W * 0.06,               // ground center, nudged toward the open front
    rx: WORLD_W * 0.30, ry: WORLD_W * 0.15,  // iso-flattened deck radii
    zones: [                                  // element footprints to avoid (back-left, back-right)
      { x: -WORLD_W * 0.20, y: -WORLD_W * 0.14, r: WORLD_W * 0.15 },
      { x: WORLD_W * 0.20, y: -WORLD_W * 0.14, r: WORLD_W * 0.15 },
    ],
  };
  function onFloor(x, y) {
    const dx = (x - FLOOR.cx) / FLOOR.rx, dy = (y - FLOOR.cy) / FLOOR.ry;
    if (dx * dx + dy * dy > 1) return false;                 // outside the deck
    for (const z of FLOOR.zones) { const ex = x - z.x, ey = y - z.y; if (ex * ex + ey * ey < z.r * z.r) return false; } // on an element
    return true;
  }
  function randomFloorPoint() {
    for (let i = 0; i < 40; i++) {
      const a = Math.random() * Math.PI * 2, rr = Math.sqrt(Math.random());
      const x = FLOOR.cx + Math.cos(a) * FLOOR.rx * rr;
      const y = FLOOR.cy + Math.sin(a) * FLOOR.ry * rr;
      if (onFloor(x, y)) return { x, y };
    }
    return { x: FLOOR.cx, y: FLOOR.cy };
  }
  return { FLOOR, onFloor, randomFloorPoint };
}

/*
 * Robot personal space (pure, so it's simulated in test/floor.test.mjs). Units are plain objects with
 * _px/_py (position), _tx/_ty (walk target), _moving, _working, _hovered, _removing. Distance doubles
 * y because the deck is drawn iso-squashed: a robot slightly in front of another overlaps it on screen.
 */
export function makeSpacing({ onFloor, randomFloorPoint }, spacing) {
  const isoDist = (ax, ay, bx, by) => Math.hypot(ax - bx, (ay - by) * 2);
  // A floor point clear of every other robot (where each stands AND where it's heading).
  // ponytail: best-of-12 random samples, not path planning — fine for the handful of robots per platform.
  function clearPoint(peers, self) {
    let best = null, bestGap = -1;
    for (let k = 0; k < 12; k++) {
      const p = randomFloorPoint();
      let gap = Infinity;
      for (const o of peers || []) {
        if (o === self || o._removing) continue;
        gap = Math.min(gap, isoDist(p.x, p.y, o._px, o._py), isoDist(p.x, p.y, o._tx, o._ty));
      }
      if (gap >= spacing * 1.4) return p;
      if (gap > bestGap) { bestGap = gap; best = p; }
    }
    return best;
  }
  // One frame of easing `u` away from anyone closer than `spacing`. A working/hovered robot holds still
  // and the other yields; a push that would leave the deck is skipped; a walk aimed into someone re-routes.
  function separate(u, peers) {
    if (u._working || u._hovered) return;
    for (const o of peers || []) {
      if (o === u || o._removing) continue;
      const dx = u._px - o._px, dy = (u._py - o._py) * 2, d = Math.hypot(dx, dy) || 0.01;
      if (d >= spacing) continue;
      const share = o._working || o._hovered ? 1 : 0.5;
      const push = Math.min(2, (spacing - d) * share * 0.2);   // a few px per frame: a nudge, not a jump
      const nx = u._px + (dx / d) * push, ny = u._py + (dy / d / 2) * push;
      if (onFloor(nx, ny)) { u._px = nx; u._py = ny; }
      if (u._moving && isoDist(u._tx, u._ty, o._px, o._py) < spacing) { const t = clearPoint(peers, u); u._tx = t.x; u._ty = t.y; }
    }
  }
  return { clearPoint, separate, isoDist };
}
