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
