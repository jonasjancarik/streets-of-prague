#!/usr/bin/env node
// Checks, on a made-up house, that a mansard's windows take the bays of the wall below it
// (src/facades.ts, mansardCoords) and that the roof clutter (src/map/roofClutter.ts) stays
// on its roof and comes out as whole, finite triangles.
import assert from 'node:assert/strict';
import { facadeCoords, mansardCoords, baysOf, STYLE } from '../src/facades.ts';
import { roofClutter } from '../src/map/roofClutter.ts';

const quad = (a, b, c, d) => [...a, ...b, ...c, ...a, ...c, ...d];
// A wall 11.6 m long and 9 m high facing +z, and a mansard above it that starts 1 m in.
const house = (x0, steep) => new Float32Array([
  ...quad([x0, 0, 0], [x0 + 11.6, 0, 0], [x0 + 11.6, 9, 0], [x0, 9, 0]),
  ...(steep
    ? quad([x0 + 1, 9, 0], [x0 + 11.6, 9, 0], [x0 + 11.6, 12, -1.2], [x0 + 1, 12, -1.2])
    : quad([x0, 9, 0], [x0 + 11.6, 9, 0], [x0 + 11.6, 14, -5], [x0, 14, -5])),
]);
const flat = () => 0, tenement = () => STYLE.tenement;

{
  const p = house(0, true), lines = [];
  const facade = facadeCoords(p, flat, tenement, lines);
  assert.equal(lines.length, 1, 'one wall');
  const bays = baysOf(STYLE.tenement, 11.6);
  assert.equal(bays, 4);
  mansardCoords(p, facade, lines);
  // The mansard's vertices: 6 after the wall's 6. Its length is the wall's bays × 3.2 m,
  // and a point above the wall's k-th bay edge is at k × 3.2.
  for (let v = 6; v < 12; v++) {
    const x = p[v * 3], along = facade[v * 4], length = facade[v * 4 + 2];
    assert(Math.abs(length - bays * 3.2) < 1e-4, 'mansard length ' + length);
    assert(Math.abs(Math.abs(along - x / 11.6 * bays * 3.2) % (bays * 3.2)) < 1e-3 || Math.abs(along - (11.6 - x) / 11.6 * bays * 3.2) < 1e-3, `mansard along ${along} at x ${x}`);
  }
  // Without the walls it keeps its own measure.
  const alone = facadeCoords(p, flat, tenement);
  mansardCoords(p, alone);
  assert(Math.abs(alone[6 * 4 + 2] - 10.6) < 1e-4);
}

let made = 0, dormers = 0;
for (let i = 0; i < 60; i++) {
  const x0 = i * 37.3, p = house(x0, false), lines = [];
  const facade = facadeCoords(p, flat, tenement, lines);
  const col = new Float32Array(p.length).fill(0.5);
  const material = (o) => (o >= 2 ? 1 : 0);
  const out = roofClutter(p, col, facade, 4, material, lines, flat);
  if (!out) continue;
  made++;
  assert.equal(out.position.length % 9, 0);
  assert.equal(out.normal.length, out.position.length);
  assert.equal(out.color.length, out.position.length);
  assert.equal(out.facade.length / 4, out.position.length / 3);
  assert(out.position.every(Number.isFinite) && out.normal.every(Number.isFinite) && out.facade.every(Number.isFinite));
  for (let v = 0; v < out.position.length; v += 3) {
    const x = out.position[v], y = out.position[v + 1], z = out.position[v + 2];
    assert(x > x0 - 0.5 && x < x0 + 12.1 && z < 0.6 && z > -5.5 && y > 8 && y < 18, `clutter off the roof at ${x - x0}, ${y}, ${z}`);
  }
  // Dormers: their plaster fronts are upright quads facing +z; each stands over a bay's middle.
  for (let t = 0; t < out.position.length; t += 9) {
    if (out.normal[t + 2] < 0.99 || out.position[t + 1] === out.position[t + 4] && out.position[t + 4] === out.position[t + 7]) continue;
    const xs = [out.position[t], out.position[t + 3], out.position[t + 6]];
    const width = Math.max(...xs) - Math.min(...xs);
    if (Math.abs(width - 1.25) > 0.01) continue;
    dormers++;
    const mid = (Math.max(...xs) + Math.min(...xs)) / 2 - x0, bay = 11.6 / 4;
    assert(Math.abs(((mid / bay) % 1) - 0.5) < 0.02, 'a dormer off its bay: ' + mid);
  }
  assert.deepEqual(roofClutter(p, col, facade, 4, material, lines, flat), out, 'the same roof gets the same clutter');
}
assert(made > 5, 'clutter on some roofs: ' + made);
assert(dormers > 0, 'dormers on some roofs');
console.log('roof clutter ok: on %d of 60 roofs, %d dormer faces over their bays; mansards take the wall\'s bays', made, dormers);
