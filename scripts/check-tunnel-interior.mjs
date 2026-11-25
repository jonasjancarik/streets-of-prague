// A sloping road passes underneath the upper street. The approaches are open,
// its roof faces down, and switching to walking below it preserves the upper road.
import assert from 'node:assert/strict';
import { tunnelInterior } from '../src/map/tunnelInterior.ts';
import { splitTunnelEarth, TunnelIndex, tunnelPrisms } from '../src/map/tunnelEarth.ts';

const floor = (x, y) => y / 20;
const ground = (x, y) => floor(x, y) + 4;
const polys = [[[[2, 0], [8, 0], [8, 30], [2, 30]]]];
const positions = [], indices = [];
for (let y = 0; y <= 30; y++) {
  positions.push(2, floor(2, y), -y, 8, floor(8, y), -y);
  const i = y * 2;
  if (y) indices.push(i - 2, i - 1, i + 1, i - 2, i + 1, i);
}
const mesh = {
  position: Float32Array.from(positions),
  index: Uint32Array.from(indices),
  normal: new Float32Array(positions.length),
};
const { roof, walls } = tunnelInterior(polys, mesh, [[[5, 5], [5, 25]]], [-5, -2, 15, 34], ground, floor);
function assertGeometry(g) {
  assert.ok(g.index.length > 0);
  assert.ok([...g.position, ...g.normal, ...g.uv].every(Number.isFinite));
  assert.equal(g.position.length, g.normal.length);
  assert.equal(g.uv.length, g.position.length / 3 * 2);
  assert.ok(Math.max(...g.index) < g.position.length / 3);
}
for (const g of [roof, walls]) assertGeometry(g);
const extent = (g, i) => {
  const p = g.position.filter((_, j) => j % 3 === i);
  return [Math.min(...p) + 0, Math.max(...p) + 0];
};
assert.deepEqual(extent(roof, 2), [-25, -5]);
assert.deepEqual(extent(walls, 2), [-25, -5]);
for (let i = 0; i < roof.index.length; i += 3) {
  const [a, b, c] = roof.index.slice(i, i + 3).map((v) => v * 3), p = roof.position;
  const up = (p[b + 2] - p[a + 2]) * (p[c] - p[a]) - (p[b] - p[a]) * (p[c + 2] - p[a + 2]);
  assert.ok(up <= 0, 'the ceiling is visible from below');
}
for (let j = 0; j < walls.index.length; j += 3) {
  const xs = walls.index.slice(j, j + 3).map((i) => Math.round(walls.position[i * 3]));
  assert.equal(xs[0], xs[1]);
  assert.equal(xs[1], xs[2], 'no end wall blocks the approach');
}
const seam = tunnelInterior(polys, mesh, [[[5, 0], [5, 30]]], [0, 0, 10, 30], ground, floor);
assert.deepEqual(extent(seam.roof, 2), [-30, 0]);
const old = tunnelInterior(polys, mesh, [], [-5, -2, 15, 34], ground, floor);
assertGeometry(old.roof);
const shallow = tunnelInterior(polys, mesh, [], [-5, -2, 15, 34], floor, floor);
assert.equal(shallow.roof.index.length, 0);
const rampGround = (x, y) => floor(x, y) + Math.min(3.6, .12 * y);
const ramp = tunnelInterior(polys, mesh, [[[5, 0], [5, 30]]], [-5, -2, 15, 34], rampGround, floor);
assertGeometry(ramp.roof);
for (const surface of [ramp.roof, ramp.walls]) {
  for (let i = 0; i < surface.position.length; i += 3) {
    const [x, h, z] = surface.position.subarray(i, i + 3);
    assert.ok(h <= rampGround(x, -z) - .45, 'the portal lining stays below the upper street');
  }
}

const prism = new TunnelIndex(tunnelPrisms(polys, floor));
function quad(h) {
  const position = Float32Array.from([0, h, 0, 10, h, 0, 10, h, -30, 0, h, -30]);
  return {
    position,
    normal: new Float32Array(12),
    index: Uint32Array.of(0, 1, 2, 0, 2, 3),
    alpha: Float32Array.of(0, 1, 1, 0),
  };
}
const high = quad(15);
assert.equal(splitTunnelEarth(high, prism), undefined, 'upper streets above the clearance stay whole');
const g = quad(3), outside = splitTunnelEarth(g, prism);
assert.ok(outside > 0 && outside < g.index.length);
const area = (from, to) => {
  let sum = 0;
  for (let k = from; k < to; k += 3) {
    const [a, b, c] = g.index.slice(k, k + 3).map((v) => v * 3);
    const p = g.position;
    sum += Math.abs((p[b] - p[a]) * (p[c + 2] - p[a + 2]) - (p[c] - p[a]) * (p[b + 2] - p[a + 2])) / 2;
  }
  return sum;
};
assert.ok(Math.abs(area(0, outside) - 120) < .0001, 'the two outer shoulders are retained');
assert.ok(Math.abs(area(0, g.index.length) - 300) < .0001, 'from above the full ground area is retained');
for (let i = 0; i < g.alpha.length; i++) {
  assert.ok(Math.abs(g.alpha[i] - g.position[i * 3] / 10) < 1e-6, 'surface paint interpolates across cuts');
}
console.log('Tunnel portals, winding, legacy maps, tile seams, ground area and paint interpolation passed');
