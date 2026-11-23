#!/usr/bin/env node
// The same wall projected into 3D, with a real two-metre passage through it.
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { buildStreetWall, packStreetWalls, streetModule } from '../src/map/streetFacade.ts';
import { FACADE_ON, F_SURFACE, F_BAY, F_STOREY, F_STREET_WIDTH } from '../src/facades.ts';
import apertures from '../src/map/facadeOpenings.json' with { type: 'json' };
import { StreetFacades } from '../src/streetFacades.ts';

const p = [], f = [], colors = [], labels = [];
function wall(x0, y0, x1, y1) {
  for (const [x, y] of [[x0, y0], [x1, y0], [x1, y1], [x0, y0], [x1, y1], [x0, y1]]) {
    p.push(x, y, 0); f.push(x, y, 12, .5 / 32768); colors.push(.5, .42, .32); labels.push(.8);
  }
}
wall(0, 0, 5, 13); wall(5, 3, 7, 13); wall(7, 0, 12, 13);
const buffers = { position: Float32Array.from(p), color: Float32Array.from(colors), facade: Float32Array.from(f) };
const tris = Uint32Array.from({ length: p.length / 9 }, (_, i) => i), sky = Float32Array.from(labels);
const groups = packStreetWalls(buffers.facade, [{ tris: [...tris] }]);
const result = buildStreetWall(buffers, sky, tris);
assert.ok(result);
const count = result.position.length / 3;
for (const [key, size] of Object.entries({ normal: 3, color: 3, facade: 4, detail: 4, sky: 1 })) {
  assert.equal(result[key].length, count * size, key); assert.ok(result[key].every(Number.isFinite), key);
}
let front = 0, deep = 0, sill = 0, glass = 0, jambs = 0;
for (let i = 0; i < count; i += 3) {
  let x = 0, y = 0;
  for (let k = i; k < i + 3; k++) {
    const z = result.position[k * 3 + 2];
    if (z < -.15) deep++; if (z > .10) sill++; if (result.detail[k * 4 + 2] === 1) glass++;
    x += result.position[k * 3] / 3; y += result.position[k * 3 + 1] / 3;
    assert.ok(Math.abs(Math.hypot(...result.normal.subarray(k * 3, k * 3 + 3)) - 1) < 1e-5, 'unit surface normal');
  }
  assert.ok(!(x > 5.001 && x < 6.999 && y < 2.999), 'no face closes the existing passage');
  if (result.detail[i * 4 + 2] === F_SURFACE.reveal) {
    const depths = [0, 1, 2].map(j => result.position[(i + j) * 3 + 2]);
    const heights = [0, 1, 2].map(j => result.position[(i + j) * 3 + 1]);
    if (Math.min(...depths) < -.08 && Math.max(...heights) - Math.min(...heights) > .45) {
      jambs++;
      assert.ok(Math.max(...depths) <= .0471, 'a tall jamb never projects out to sill depth');
    }
  }
  if (result.position[i * 3 + 2] === 0 && result.normal[i * 3 + 2] > .99) front++;
}
assert.ok(front && deep && sill && glass && jambs, 'front planes, actual recesses, projecting stone, straight jambs and panes');
const blank = buffers.facade.slice(); for (let i = 3; i < blank.length; i += 4)blank[i] += 5;
assert.equal(packStreetWalls(blank, [{ tris: [...tris] }]).length, 0, 'party walls excluded');
assert.equal(streetModule(1 + .5 / 32768, 0, 0, 1) === 19, false, 'an inferred entrance never masquerades as an open tunnel');

// A worker response arriving after returning overhead must not hide a wall.
const scene = new THREE.Scene(), geom = new THREE.BufferGeometry();
for (const [name, array, size] of [['position', buffers.position, 3], ['color', buffers.color, 3], ['facade', buffers.facade, 4], ['sky', sky, 1]])
  geom.setAttribute(name, new THREE.BufferAttribute(array, size));
geom.computeVertexNormals();
const base = new THREE.Mesh(geom); scene.add(base);
let ready, cancelled = 0, jobs = 0;
const workers = { submit: () => { jobs++; return { promise: new Promise(resolve => ready = resolve), cancel: () => cancelled++ }; } };
const manager = new StreetFacades(scene, workers);
manager.register(base, groups, [-10, -10, 30, 30]); FACADE_ON.value = 1;
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
manager.update(false, 4, 1, 4); assert.equal(jobs, 0);
manager.update(true, 4, 1, 4, 'lowest'); assert.equal(jobs, 0);
manager.update(true, 4, 1, 4); assert.equal(jobs, 1); assert.equal(geom.index, null);
manager.update(false, 4, 1, 4); assert.equal(cancelled, 1);
ready(result); await tick(); assert.equal(scene.children.length, 1); assert.equal(geom.index, null);
manager.update(true, 4, 1, 4); ready(result); await tick();
assert.equal(scene.children.length, 2); assert.equal(geom.index.array[1], 0);
const fitted = scene.children.find(o => o.name === 'Street façade');
let disposedObject = false;
fitted.addEventListener('dispose', () => { disposedObject = true; });
manager.update(false, 4, 1, 4); assert.equal(scene.children.length, 1);
assert.ok(disposedObject, 'retiring the fitted wall releases its renderer object as well as its vertex buffers');
for (let i = 0; i < geom.index.count; i++)assert.equal(geom.index.array[i], i, 'original triangle restored');
manager.update(true, 4, 1, 4); manager.drop(base); ready(result); await tick(); assert.equal(scene.children.length, 1);
console.log('Verified recessed geometry, stone profiles, passage clipping, camera swaps and late worker results.', count / 3, 'triangles in the test wall.');

// An Art Nouveau shopfront has glass above its sill and solid joinery round
// the panes. The display finish cannot leak into the doors or the flats above.
const shopFacade = buffers.facade.slice();
for (let i = 3; i < shopFacade.length; i += 4) shopFacade[i] = (53 + .25) / 32768;
const shopWall = buildStreetWall({ ...buffers, facade: shopFacade }, sky, tris);
const shopPanes = [];
for (let i = 0; i < shopWall.detail.length; i += 4) {
  if (shopWall.detail[i + 2] === F_SURFACE.display) shopPanes.push([shopWall.facade[i + 1], shopWall.detail[i]]);
}
assert(shopPanes.length > 0 && shopPanes.every(([h, layer]) => h < 4.4 && (layer === 66 || layer === 71)));
console.log('Ground-floor display panes stay within the authored shop windows.');

// Buildings with equal period and composition can have different wall seeds
// and storey fits around a corner. Their principal floors still belong together.
const packed = (look, composition, wall = 0, fit = 0) =>
  Math.fround((wall * 1024 + fit * 32 + look + (composition + .5) / 8) / 32768);
const upper = (w, row, bays = 7) => Array.from({ length: bays }, (_, bay) => streetModule(w, bay, row, bays));
for (const bays of [1, 2, 5, 6, 11]) for (let composition = 0; composition < 8; composition++) {
  const w = packed(0, composition), first = upper(w, 1, bays);
  assert.deepEqual(first, upper(packed(0, composition, 31, 17), 1, bays));
  assert.deepEqual(first, first.toReversed(), 'balanced window hoods on even and odd fronts');
  assert.equal(new Set(first).size, bays < 3 ? 1 : 2);
  assert.equal(new Set(upper(w, 3, bays)).size, 1, 'a simpler upper storey');
}
for (const look of [3, 8, 10]) {
  const w = packed(look, 1, 14);
  assert.deepEqual(upper(w, 1), upper(w, 3), 'stacked modern windows and loggias');
}
const residential = Array.from({ length: 8 }, (_, bay) => streetModule(packed(1, 6), bay, 0, 8));
assert.equal(residential.filter(layer => layer === 18).length, 1, 'a single residential entrance');
assert.ok(residential.includes(21) && residential.includes(23) && residential.every(layer => [18, 21, 23].includes(layer)),
  'an Old Town residential front has a barred window and sheltered plaster beside its portal');

const awningWall = buildStreetWall({ ...buffers, facade: Float32Array.from(shopFacade, (v, i) =>
  i % 4 === 3 ? (101 + .25) / 32768 : v) }, sky, tris);
let canvas = 0, frame = 0, signs = 0;
for (let i = 0; i < awningWall.detail.length; i += 4) {
  const kind = awningWall.detail[i + 2], height = awningWall.facade[i + 1];
  if (kind === F_SURFACE.shopPaint) frame++;
  if (kind === F_SURFACE.shopSign) {
    signs++;
    assert.ok(awningWall.detail[i + 3] >= 0 && awningWall.detail[i + 3] < 4 && height < 4.4, 'a shop sign selects a display from the atlas');
  }
  if (kind !== F_SURFACE.canvas) continue;
  canvas++;
  assert.ok(height >= 2.24 && height < 4.4, 'fabric clears the pavement and the upper storeys');
  assert.ok(awningWall.position[i / 4 * 3 + 2] <= .95, 'awning stays close to its shop');
}
assert.ok(canvas && frame && signs, 'a rectangular display receives a lettered fascia and awning');
console.log('Verified window composition, vertically stacked bays and shop awning clearance.');

// The atlas rectangle is the physical opening, including the sash. A normal
// estate window admits daylight over about half the storey. Cellar lights
// below it remain small, and a tenement has a taller opening than a panel flat.
const metric = (layer, style) => {
  const [l, t, r, b] = apertures[layer][0];
  return [(r-l) / 256 * Math.min(F_BAY[style], F_STREET_WIDTH[layer]), (b-t) / 512 * F_STOREY[style]];
};
const [width, height] = metric(120, 3);
assert.ok(width > 2.5 && height > 1.4 && height < 1.65);
assert.ok(metric(49, 0)[1] > 1.9 && metric(108, 1)[1] > 1.4 && metric(127, 3)[1] < .7);

const access = 3 + packed(10, 1, 3, 14), sunny = 3 + packed(10, 1, 19, 14);
assert.equal(streetModule(access, 0, 0, 6), 126);
assert.equal(streetModule(access, 0, 4, 6), 124, 'stair lights stand over the common entrance');
const balconies = new Set([122, 123, 125]), guards = new Set();
for (let row = 1; row <= 10; row++) {
  const elevation = upper(sunny, row, 6);
  assert.deepEqual(elevation.map(layer => balconies.has(layer)), [false,true,true,false,true,true]);
  for (const part of elevation) if (balconies.has(part)) guards.add(part);
}
assert.equal(guards.size, 3, 'open rails, solid guards and glazed-in balconies share the same stack');
assert.ok(upper(sunny, 1, 2).every(layer => layer === 120), 'a short return is windowed');

const slabWidth = F_BAY[3] * 6, slabTop = 24;
const corners = [[0,0], [slabWidth,0], [slabWidth,slabTop], [0,0], [slabWidth,slabTop], [0,slabTop]];
const slab = buildStreetWall({
  position: Float32Array.from(corners.flatMap(([x,y]) => [x,y,0])),
  facade: Float32Array.from(corners.flatMap(([x,y]) => [x,y,slabWidth,sunny])),
  color: new Float32Array(18).fill(.6),
}, new Float32Array(6).fill(1), Uint32Array.of(0,1));
const highPanes = [];
for (let i = 0; i < slab.detail.length; i += 4) {
  if (slab.detail[i+2] === F_SURFACE.balconyGlass && slab.facade[i+1] > 16) highPanes.push(slab.detail[i+3]);
}
assert.ok(highPanes.length && highPanes.every(z => z < -.85), 'upper-floor balcony doors sit behind the front guard');
console.log('Verified apartment window dimensions, panel entrance sections and deep loggia stacks.');
