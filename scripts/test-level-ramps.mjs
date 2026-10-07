// Stairs on a bridge level read from their own profile (src/terrain.ts, withRamps); no browser or map needed.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withRamps } from '../src/terrain.ts';

const deck = () => 20; // the level's lattice: a deck at 20 m above the game's zero
const ramp = { w: 2, pts: [[0, 0, 200], [10, 0, 195]] }; // stairs along x, 200 m a.s.l. down to 195

test('on the stairs the height is their profile, elsewhere the lattice', () => {
  const h = withRamps(deck, [ramp], 180);
  assert.ok(Math.abs(h(0.001, 0) - 19.9995) < 1e-9);
  assert.equal(h(5, 0), 17.5);
  assert.equal(h(5, 0.9), 17.5);
  assert.equal(h(5, 1.2), 20); // beside them
  assert.equal(h(-0.5, 0), 20); // before their first point: square ends
  assert.equal(h(10.5, 0), 20);
});

test('a bend is followed, and the nearer flight wins where two lie side by side', () => {
  const bent = { w: 2, pts: [[0, 0, 200], [10, 0, 195], [10, 10, 190]] };
  const h = withRamps(deck, [bent, { w: 2, pts: [[0, 3, 190], [10, 3, 185]] }], 180);
  assert.equal(h(10, 5), 12.5);
  assert.equal(h(10.4, -0.4), 15); // round the outside of the bend
  assert.equal(h(5, 0.5), 17.5);
  assert.equal(h(5, 2.5), 7.5);
});

test('a level without stairs is its lattice', () => {
  assert.equal(withRamps(deck, undefined, 180), deck);
  assert.equal(withRamps(deck, [], 180), deck);
});
