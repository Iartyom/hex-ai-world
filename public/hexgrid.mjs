/*
 * Flat-top hex math for the base map. Kept standalone so the layout scheme can be
 * swapped later without touching render logic.
 *  - axialToPixel: axial (q,r) → screen (x,y)
 *  - spiralCells:  the first N hex cells in an outward spiral from center (0,0),
 *                  so new bases spread out as sessions appear
 *  - hexCorners:   the 6 polygon points for drawing one flat-top hex of a given size
 */
const SQRT3 = Math.sqrt(3);

export function axialToPixel(q, r, size) {
  return { x: size * 1.5 * q, y: size * SQRT3 * (r + q / 2) };
}

const DIRS = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];

export function spiralCells(count) {
  const cells = [{ q: 0, r: 0 }];
  let radius = 1;
  while (cells.length < count) {
    // Start at one corner of the ring, then walk the six sides.
    let q = DIRS[4][0] * radius, r = DIRS[4][1] * radius;
    for (let side = 0; side < 6 && cells.length < count; side++) {
      for (let step = 0; step < radius && cells.length < count; step++) {
        cells.push({ q, r });
        q += DIRS[side][0]; r += DIRS[side][1];
      }
    }
    radius++;
  }
  return cells.slice(0, count);
}

export function hexCorners(size) {
  const pts = [];
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 180) * (60 * i); // flat-top: a vertex points right
    pts.push({ x: size * Math.cos(a), y: size * Math.sin(a) });
  }
  return pts;
}
