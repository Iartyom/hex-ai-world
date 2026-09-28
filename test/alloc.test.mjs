// Tests for the render-layer allocators + floor geometry extracted from render.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorldAllocator, makeCellAllocator } from '../public/alloc.mjs';
import { makeFloor } from '../public/floor.mjs';
import { spiralCells } from '../public/hexgrid.mjs';

const WORLDS = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
const rng0 = () => 0; // deterministic: always pick the first of the pool

test('worldAllocator: unique across active sessions until exhausted; stable on re-assign', () => {
  const a = makeWorldAllocator(WORLDS, rng0);
  const w1 = a.assign('s1'); const w2 = a.assign('s2'); const w3 = a.assign('s3');
  const ids = new Set([w1.id, w2.id, w3.id]);
  assert.equal(ids.size, 3);                         // all distinct while unused ones remain
  assert.equal(a.assign('s1').id, w1.id);            // stable on re-assign
});

test('worldAllocator: picks only from UNUSED worlds while any remain', () => {
  // rng0 always returns index 0 of the current pool → each pick is the first still-unused world.
  const a = makeWorldAllocator(WORLDS, rng0);
  assert.equal(a.assign('s1').id, 'a');              // pool [a,b,c] → a
  assert.equal(a.assign('s2').id, 'b');              // pool [b,c]   → b
  assert.equal(a.assign('s3').id, 'c');              // pool [c]     → c
});

test('worldAllocator: freed world becomes available again', () => {
  const a = makeWorldAllocator(WORLDS, rng0);
  a.assign('s1'); a.assign('s2'); a.assign('s3');    // all used
  a.free('s2');                                       // 'b' freed
  assert.equal(a.assign('s4').id, 'b');              // only unused one → 'b'
});

test('worldAllocator: when all used, still assigns (random among all, no crash)', () => {
  const a = makeWorldAllocator(WORLDS, rng0);
  a.assign('s1'); a.assign('s2'); a.assign('s3');
  const w4 = a.assign('s4');                          // none free → random among all
  assert.ok(WORLDS.some((w) => w.id === w4.id));
});

test('cellAllocator: sequential slots, stable, reuse smallest freed', () => {
  const c = makeCellAllocator(spiralCells);
  c.take('s1'); c.take('s2'); c.take('s3');
  assert.equal(c.slotOf('s1'), 0);
  assert.equal(c.slotOf('s3'), 2);
  c.release('s1');                                   // frees slot 0
  c.take('s4');
  assert.equal(c.slotOf('s4'), 0);                  // reused smallest free slot
  const before = c.slotOf('s2');
  assert.equal(c.take('s2') && c.slotOf('s2'), before); // stable
});

test('floor: randomFloorPoint stays on the deck and off element zones', () => {
  const { FLOOR, onFloor, randomFloorPoint } = makeFloor(320);
  for (let i = 0; i < 200; i++) {
    const p = randomFloorPoint();
    assert.ok(onFloor(p.x, p.y), `point off floor: ${JSON.stringify(p)}`);
  }
  // a point inside a back-corner element zone is NOT walkable
  assert.equal(onFloor(FLOOR.zones[0].x, FLOOR.zones[0].y), false);
  // far outside the deck is not walkable
  assert.equal(onFloor(9999, 9999), false);
});
