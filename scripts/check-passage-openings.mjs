import assert from 'node:assert/strict';
import * as T from 'three';
import { ARCH_SPRING, openPassages, PASSAGE_HEAD, reachPassages, vaultHeight } from '../src/map/passageOpenings.ts';
import { passageLining } from '../src/map/passageLining.ts';

const p = new Float32Array([-4, 0, 0, 4, 0, 0, 4, 7, 0, -4, 0, 0, 4, 7, 0, -4, 7, 0]);
const g = new T.BufferGeometry();
g.setAttribute('position', new T.BufferAttribute(p, 3));
g.computeVertexNormals();
const uv = Float32Array.from({ length: 12 }, (_, i) => p[Math.floor(i / 2) * 3 + i % 2]);
const data = {
  position: p,
  color: new Float32Array(p.length).fill(.5),
  normal: g.attributes.normal.array,
  facade: Float32Array.from({ length: 24 }, (_, i) => i % 4 < 2 ? uv[Math.floor(i / 4) * 2 + i % 4] : i % 4 === 2 ? 8 : .2),
  drapeUv: uv,
  streetWalls: Uint32Array.from([2, 0, 1]),
  parts: { extras: 6, clutter: 6 },
};
const path = { hw: 'footway', w: 3, pts: [[0, -8], [0, 8]] };
const open = openPassages(data, [path], () => 0);
assert(open !== data);
assert.equal(open.parts.extras, open.position.length / 3);
assert.equal(open.streetWalls[0], open.position.length / 9);
assert.equal(open.streetWalls.at(-1), open.position.length / 9 - 1);
for (let i = 0; i < open.position.length / 3; i++) {
  assert(Math.abs(open.position[3 * i] - open.facade[4 * i]) < 1e-5);
  assert(Math.abs(open.position[3 * i + 1] - open.drapeUv[2 * i + 1]) < 1e-5);
}
const geom = new T.BufferGeometry();
geom.setAttribute('position', new T.BufferAttribute(open.position, 3));
const wall = new T.Mesh(geom, new T.MeshBasicMaterial({ side: T.DoubleSide }));
function hits(x, y) {
  return new T.Raycaster(new T.Vector3(x, y, 2), new T.Vector3(0, 0, -1)).intersectObject(wall).length > 0;
}
assert(!hits(0, 1.75) && !hits(1.45, 2.4));
assert(hits(1.8, 1.75) && hits(0, PASSAGE_HEAD + .1));
assert.equal(openPassages(data, [{ ...path, hw: 'tram' }], () => 0), data);

// A gateway (průjezd) for a street: an arch, its walls ARCH_SPRING high, the crown above.
const gate = { hw: 'residential', w: 4, pts: [[0, -8], [0, 8]] };
const arched = openPassages(data, [gate], () => 0);
const archWall = new T.BufferGeometry();
archWall.setAttribute('position', new T.BufferAttribute(arched.position, 3));
const archMesh = new T.Mesh(archWall, wall.material);
const solid = (x, y) => new T.Raycaster(new T.Vector3(x, y, 2), new T.Vector3(0, 0, -1)).intersectObject(archMesh).length > 0;
const crown = vaultHeight(0, 2.08);
assert(!solid(0, crown - .1) && solid(0, crown + .15), 'the crown of the arch');
assert(!solid(1.9, ARCH_SPRING + .4) && solid(1.9, ARCH_SPRING + 1.2), 'the curve near its foot');
assert(!solid(-1.9, 1) && solid(-2.4, 1), 'the jambs');
assert(arched.facades.length === 4 && Math.abs(arched.facades[1]) < .01, 'the wall it was cut through');

// Loose ends are carried out of the building (here 1.5 m short of its wall); a
// pavement beside a road under one arch joins the road's strip.
const house = [{ rings: [[[-5, -5], [5, -5], [5, 5], [-5, 5], [-5, -5]]] }];
const [short] = reachPassages([{ hw: 'footway', w: 2, pts: [[0, -8], [0, 3.5]] }], house, [-50, -50, 50, 50]);
assert(short.pts.at(-1)[1] >= 5 && short.pts.at(-1)[1] < 5.6, 'carried out of the building');
const pair = reachPassages([gate, { hw: 'footway', w: 1, pts: [[2.4, -8], [2.4, 8]] }], house, [-50, -50, 50, 50]);
assert.equal(pair.length, 1);
assert(Math.abs(pair[0].w - 4.9) < .01 && Math.abs(pair[0].pts[0][0] - .45) < .01, 'one strip under one arch');
// Two arches either side of a pillar stay apart.
const two = reachPassages([gate, { ...gate, pts: [[5.5, -8], [5.5, 8]] }], house, [-50, -50, 50, 50]);
assert.equal(two.length, 2);
const homes = [{ rings: [[[-5, -5], [5, -5], [5, 5], [-5, 5]]] }];
const lining = passageLining([path, { ...path, pts: [[-8, 0], [8, 0]] }], homes, [-10, -10, 10, 10], () => 0);
assert(lining?.position.every(Number.isFinite));
const shell = new T.BufferGeometry();
shell.setAttribute('position', new T.BufferAttribute(lining.position, 3));
const room = new T.Mesh(shell, wall.material);
const rays = (origin, direction, range) =>
  new T.Raycaster(new T.Vector3(...origin), new T.Vector3(...direction), 0, range).intersectObject(room).length;
assert.equal(rays([0, 1.7, 7], [0, 0, -1], 14), 0, 'the entrance and the crossing stay open');
assert.equal(rays([-7, 1.7, 0], [1, 0, 0], 14), 0, 'the cross passage stays open');
assert(rays([0, 1.7, 0], [0, 1, 0], 2) > 0 && rays([0, 1.7, 0], [0, -1, 0], 2) > 0);
assert.equal(rays([0, 1.7, 7], [0, 1, 0], 2), 0, 'the ceiling ends at the building');
console.log(
  'Verified open portals, preserved lintels, interpolated attributes, wall groups, intersecting passages, outdoor pavement, arched gateways and loose ends.',
);
