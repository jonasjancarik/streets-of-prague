#!/usr/bin/env node
// The same wall projected into 3D, with a real two-metre passage through it.
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { buildStreetWall, packStreetWalls, streetModule } from '../src/map/streetFacade.ts';
import { FACADE_ON } from '../src/facades.ts';
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
let front = 0, deep = 0, sill = 0, glass = 0;
for (let i = 0; i < count; i += 3) {
  let x = 0, y = 0;
  for (let k = i; k < i + 3; k++) {
    const z = result.position[k * 3 + 2];
    if (z < -.15) deep++; if (z > .10) sill++; if (result.detail[k * 4 + 2] === 1) glass++;
    x += result.position[k * 3] / 3; y += result.position[k * 3 + 1] / 3;
    assert.ok(Math.abs(Math.hypot(...result.normal.subarray(k * 3, k * 3 + 3)) - 1) < 1e-5, 'unit surface normal');
  }
  assert.ok(!(x > 5.001 && x < 6.999 && y < 2.999), 'no face closes the existing passage');
  if (result.position[i * 3 + 2] === 0 && result.normal[i * 3 + 2] > .99) front++;
}
assert.ok(front && deep && sill && glass, 'front planes, actual recesses, projecting stone and panes');
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
manager.update(false, 4, 1, 4); assert.equal(scene.children.length, 1);
for (let i = 0; i < geom.index.count; i++)assert.equal(geom.index.array[i], i, 'original triangle restored');
manager.update(true, 4, 1, 4); manager.drop(base); ready(result); await tick(); assert.equal(scene.children.length, 1);
console.log('Verified recessed geometry, stone profiles, passage clipping, camera swaps and late worker results.', count / 3, 'triangles in the test wall.');
