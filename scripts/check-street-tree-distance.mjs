// A mixed page must keep each surveyed tree exactly once through camera
// movement, an overhead switch, and reuse by another tile.
import assert from 'node:assert/strict';
import * as THREE from 'three';
import './offline-city.mjs';
const { TreePool, STREET_TREES, setStreetTreeMaterial } = await import('../src/trees.ts');

setStreetTreeMaterial(() => new THREE.MeshLambertMaterial(), { value: true });
const pool = new TreePool(new THREE.Scene(), 8);
function data(xs) {
  const n = xs.length, matrices = new Float32Array(n * 16);
  xs.forEach((x, i) => new THREE.Matrix4().makeTranslation(x, 3 + i, 0).toArray(matrices, i * 16));
  return { matrices, count: n, big: 0, shrubs: 0, conifers: 0,
    colours: Float32Array.from({ length: 3*n }, (_, i) => .02*i),
    yearly: Float32Array.from(xs, (_, i) => .1*i),
    outlines: Float32Array.from({ length: 8*n }, (_, i) => .75+i*.005) };
}
function rows(mesh) {
  const attrs = [mesh.instanceMatrix, mesh.instanceColor, ...['yearly','outlineA','outlineB'].map(n => mesh.geometry.getAttribute(n))];
  return Array.from({ length: mesh.count }, (_, i) => attrs.flatMap(a => Array.from(a.array.subarray(i*a.itemSize,(i+1)*a.itemSize))));
}
try {
  const [p] = pool.add('first', data([0,145,180,300]));
  const original = rows(p.mesh);
  const fullRim = { ...p.mesh.geometry.drawRange };
  pool.street(true,0,0);
  const street = p.street, matrices = street.instanceMatrix;
  const simpleRim = p.mesh.geometry.userData.simpleShadowRange;
  assert(simpleRim.count < fullRim.count);
  assert.deepEqual(p.mesh.geometry.drawRange, simpleRim, 'distant crowns use the simpler rim');
  const camera = new THREE.PerspectiveCamera();
  p.mesh.onBeforeShadow(null, null, null, camera);
  p.mesh.onAfterShadow();
  assert.deepEqual(p.mesh.geometry.drawRange, simpleRim, 'the shadow pass restores the distant main draw');
  assert.deepEqual(rows(street),original.slice(0,2));
  assert.deepEqual(rows(p.mesh),original.slice(2));
  assert.equal(pool.stats().trees[0],4);
  const version = matrices.version;
  pool.street(true,0,0); pool.street(true,8,0);
  assert.equal(matrices.version,version,'no upload while the selection is the same');
  pool.street(true,40,0);
  assert.deepEqual(rows(street),original.slice(0,3));
  assert.deepEqual(rows(p.mesh),original.slice(3));
  STREET_TREES.individual = false;
  pool.street(true,40,0);
  assert.deepEqual(rows(street),original);
  assert.equal(p.mesh.visible,false);
  STREET_TREES.individual = true;
  pool.street(false);
  assert.deepEqual(p.mesh.geometry.drawRange, fullRim, 'normal overhead zoom restores the original crown');
  assert.deepEqual(rows(p.mesh),original,'overhead restores every original attribute and its order');
  assert.equal(street.visible,false);
  pool.remove('first');
  const [reused] = pool.add('other',data([800,55]));
  assert.equal(reused,p);
  pool.street(true,0,0);
  assert.equal(p.street.instanceMatrix,matrices,'reuse keeps the GPU buffer');
  assert.deepEqual(rows(p.street).map(r=>r[12]),[55]);
  assert.deepEqual(rows(p.mesh).map(r=>r[12]),[800]);
  console.log('Individual tree ranges, packing, stable uploads, overhead restoration and tile reuse passed');
} finally { STREET_TREES.individual=true; pool.dispose(); }
