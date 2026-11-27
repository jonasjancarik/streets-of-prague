#!/usr/bin/env node
// Check that setts, mosaic, slabs and concrete are laid along the edges of what they cover.
import assert from 'node:assert/strict';
import { layingAngles } from '../src/laying.ts';
import { groundLayers, layerBuffers } from '../src/ground.ts';

const deg = (a) => (a * 180) / Math.PI;
// Same laying (mod 180°: a row of stones has no front).
const near = (a, b, tol = 1.01) => { const d = Math.abs(((deg(a - b) % 180) + 270) % 180 - 90); return d <= tol; };
// A polygon as a mesh: fan-triangulated, in the ground's (x, 0, -y).
function mesh(polys) {
  const pos = [], idx = [];
  for (const ring of polys) {
    const base = pos.length / 3;
    for (const [x, y] of ring) pos.push(x, 0, -y);
    for (let i = 1; i < ring.length - 1; i++) idx.push(base, base + i, base + i + 1);
  }
  return { position: new Float32Array(pos), index: new Uint32Array(idx) };
}
const turn = (ring, a, [cx, cy] = [0, 0]) => ring.map(([x, y]) => [cx + x * Math.cos(a) - y * Math.sin(a), cy + x * Math.sin(a) + y * Math.cos(a)]);

// A pavement 40 m long and 3 m wide, turned 27°: laid along its length.
const strip = [[0, 0], [40, 0], [40, 3], [0, 3]];
for (const a of [0, 0.47, 1.2, -0.9, 2.6]) {
  const { position, index } = mesh([turn(strip, a, [500, -300])]);
  const lay = layingAngles(position, index);
  assert.ok(lay.every((v) => v === lay[0]), 'one direction over a piece');
  assert.ok(near(lay[0], a), `strip at ${deg(a).toFixed(0)}° laid at ${deg(lay[0]).toFixed(1)}°`);
}

// An L round a block corner: its two arms agree on the grid.
const ell = [[0, 0], [30, 0], [30, 3], [3, 3], [3, 25], [0, 25]];
{
  const a = 0.3, { position, index } = mesh([turn(ell, a)]);
  const lay = layingAngles(position, index);
  assert.ok(near(lay[0], a) || near(lay[0], a + Math.PI / 2), 'an L keeps its arms square to the grid');
}

// Two pieces, each its own way; and the tile's edge, which cut the first, doesn't count.
{
  const box = [0, 0, 100, 100];
  // A street at 20° cut off by the tile's left edge (x = 0): the cut is a long side at 90°.
  const cut = [[0, 10], [60, 10 + 60 * Math.tan(0.35)], [60, 13 + 60 * Math.tan(0.35)], [0, 13]];
  const other = turn([[0, 0], [12, 0], [12, 2], [0, 2]], -0.6, [70, 70]);
  const { position, index } = mesh([cut, other]);
  const lay = layingAngles(position, index, box);
  assert.ok(near(lay[0], 0.35, 2), `the cut street keeps its own direction (${deg(lay[0]).toFixed(1)}°)`);
  assert.ok(near(lay[lay.length - 1], -0.6), 'the second piece is laid its own way');
}

// On the ground: every laid layer carries its direction, and the worker hands it over.
{
  const poly = [[turn([[0, 0], [60, 0], [60, 4], [0, 4]], 0.5, [20, 10])]];
  const result = groundLayers({ areas: { square: poly, square_setts: poly }, roads: { pavement: poly, sett: poly }, rails: [] }, { box: [0, 0, 100, 100] });
  const laid = result.layers.filter((l) => ['setts', 'slabs', 'pavement'].includes(l.pattern));
  assert.equal(laid.length, 4);
  const buffers = layerBuffers(result);
  for (const l of laid) {
    assert.equal(l.geometry.lay.length, l.geometry.position.length / 3);
    assert.ok(l.geometry.lay.every((v) => near(v, 0.5)), `${l.pattern} laid along its long side`);
    assert.ok(buffers.includes(l.geometry.lay.buffer));
  }
  assert.ok(result.layers.filter((l) => l.pattern === 'asphalt' || l.pattern === 'flat').every((l) => !l.geometry.lay), 'only laid surfaces carry it');
}
console.log('Laying: strips, an L, tile-cut pieces and the ground layers passed');
