/*
 * Pure allocators for the render layer, factored out of render.mjs so their invariants are
 * unit-testable (no two active sessions share a world; freed world/cell slots are reused so
 * positions don't drift outward forever). No Pixi/DOM — just Maps/Sets.
 */

// Assign each session a world at RANDOM from the ones not currently in use, so no two active
// sessions collide; once every world is taken, keep picking at random from all of them. `free`
// releases a world for reuse when its session ends. `rng` is injectable for deterministic tests.
export function makeWorldAllocator(WORLDS, rng = Math.random) {
  const used = new Set();
  const bySession = new Map();
  return {
    assign(sid) {
      if (bySession.has(sid)) return bySession.get(sid);
      const free = WORLDS.filter((w) => !used.has(w.id));
      const pool = free.length ? free : WORLDS;             // prefer unused; else any
      const chosen = pool[Math.floor(rng() * pool.length)] || WORLDS[0];
      used.add(chosen.id); bySession.set(sid, chosen);
      return chosen;
    },
    free(sid) { const w = bySession.get(sid); if (w) { used.delete(w.id); bySession.delete(sid); } },
    worldOf(sid) { return bySession.get(sid); }, // for tests
  };
}

// Assign each session the lowest FREE spiral-cell slot, reusing released slots smallest-first so
// the layout doesn't march outward as sessions come and go. `spiralCells(n)` returns n cells.
export function makeCellAllocator(spiralCells) {
  const bySession = new Map();
  const freeSlots = [];
  let count = 0;
  let cache = spiralCells(1);
  const at = (i) => { if (i >= cache.length) cache = spiralCells(i + 1); return cache[i]; };
  return {
    take(sid) {
      if (bySession.has(sid)) return at(bySession.get(sid));
      let idx;
      if (freeSlots.length) { freeSlots.sort((a, b) => a - b); idx = freeSlots.shift(); }
      else idx = count++;
      bySession.set(sid, idx);
      return at(idx);
    },
    release(sid) { const idx = bySession.get(sid); if (idx !== undefined) { freeSlots.push(idx); bySession.delete(sid); } },
    slotOf(sid) { return bySession.get(sid); }, // for tests
  };
}
