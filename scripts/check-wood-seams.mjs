#!/usr/bin/env node
// Checks that a wood is planted the same across a tile border (src/map/woodScatter.ts): the
// crowns a tile works out just past its edge are the ones its neighbour plants there, no
// tree is planted twice or left out, and a strip along the border is as dense as the wood
// away from it (it used to get a line of extra small trees).
import assert from 'node:assert/strict';
import { Geo, Grid } from '../src/map/geo.ts';
import { scatterWoods, WOOD, MARGIN } from '../src/map/woodScatter.ts';

const T = 250;
const tile = (i, j) => {
  const geo = new Geo({ size: [T, T], origin: [-i * T, -j * T] });
  const grid = new Grid(geo, 1, null, new Uint8Array(T * T).fill(WOOD));
  const trees = [];
  scatterWoods(geo, grid, () => false, () => false, trees);
  return { geo, trees, own: trees.filter((t) => !t[5]), ghosts: trees.filter((t) => t[5]) };
};
const key = (t) => `${t[0].toFixed(3)},${t[1].toFixed(3)},${t[2].toFixed(3)}`;

const a = tile(40, -7), b = tile(41, -7), c = tile(40, -6);
for (const [name, one, other, axis] of [['east', a, b, 0], ['north', a, c, 1]]) {
  const edge = axis ? one.geo.maxY : one.geo.maxX;
  // The neighbour's trees within the margin, against what this tile expected there.
  const real = other.own.filter((t) => t[axis] < edge + MARGIN - 3 && t[1 - axis] > (axis ? one.geo.minX : one.geo.minY) + 20 && t[1 - axis] < (axis ? one.geo.maxX : one.geo.maxY) - 20);
  const expected = new Set(one.ghosts.map(key));
  const matched = real.filter((t) => expected.has(key(t))).length;
  assert(real.length > 20, `${name}: trees beside the border (${real.length})`);
  assert(matched / real.length > 0.9, `${name}: ${matched} of ${real.length} of the neighbour's trees by the border were expected`);
  // Trees per 5 m strip, across the border and away from it.
  const all = [...one.own, ...other.own];
  const strip = (from) => all.filter((t) => t[axis] >= from && t[axis] < from + 5).length;
  const small = (from) => all.filter((t) => t[axis] >= from && t[axis] < from + 5 && t[2] < 2.9).length;
  const inner = [-100, -80, -60, 60, 80, 100].map((d) => strip(edge + d)), mean = inner.reduce((s, n) => s + n, 0) / inner.length;
  const innerSmall = [-100, -80, -60, 60, 80, 100].map((d) => small(edge + d)), meanSmall = innerSmall.reduce((s, n) => s + n, 0) / innerSmall.length;
  for (const d of [-5, 0]) {
    assert(Math.abs(strip(edge + d) / mean - 1) < 0.2, `${name}: ${strip(edge + d)} trees in the strip at ${d} m, ${mean.toFixed(0)} away from the border`);
    assert(small(edge + d) < meanSmall * 1.35 + 5, `${name}: ${small(edge + d)} small trees in the strip at ${d} m, ${meanSmall.toFixed(0)} away from the border`);
  }
  console.log(`${name} border: ${matched}/${real.length} expected trees, strips ${strip(edge - 5)} and ${strip(edge)} (inner mean ${mean.toFixed(0)}), small ${small(edge - 5)} and ${small(edge)} (inner mean ${meanSmall.toFixed(0)})`);
}
// Each tile's own trees lie in it, and none is planted by two tiles.
for (const t of [a, b, c]) assert(t.own.every(([x, y]) => x >= t.geo.minX && x < t.geo.maxX && y >= t.geo.minY && y < t.geo.maxY));
const seen = new Set(a.own.map(key));
assert(![...b.own, ...c.own].some((t) => seen.has(key(t))), 'no tree in two tiles');
assert.deepEqual(tile(40, -7).own.map(key), a.own.map(key), 'the same every time');
console.log(`Wood seams passed (${a.own.length} trees in a tile of wood)`);
