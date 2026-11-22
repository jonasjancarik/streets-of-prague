// Street budgets, deterministic sliced grass, tree LOD and headset frame targets.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import './offline-city.mjs';
import * as THREE from 'three';
const { STREET_QUALITY, STREET_TIERS } = await import('../src/streetQuality.ts');
const { StreetGrass, setGrassMaterial } = await import('../src/streetGrass.ts');
const { streetTreeGeometry } = await import('../src/map/streetTree.ts');
const { AutoTier } = await import('../src/graphics.ts');
const { LifeSize } = await import('../src/rocketbox.ts');
const { VR } = await import('../src/vr.ts');

const hash = createHash('sha256'), lawn = new StreetGrass();
lawn.ground = { grass: (x, y) => Math.sin(x * .7) + Math.cos(y * .4) > .2, height: (x, y) => Math.sin(x * .1) * .3 + y * .02 };
lawn.made = new THREE.MeshLambertMaterial();
for (const [i, j] of [[0, 0], [-2, 3], [4, -5]]) {
  const job = lawn.build(i, j);
  let step, slices = 0;
  do { step = job.next(); slices++; } while (!step.done);
  assert(slices > 40, 'grass placement yields throughout each cell');
  const mesh = step.value;
  if (mesh) {
    for (const a of [mesh.geometry.index, ...Object.values(mesh.geometry.attributes)]) hash.update(new Uint8Array(a.array.buffer));
    mesh.geometry.dispose();
  } else hash.update('empty');
}
// Recorded from the original, synchronous builder: slicing must preserve every blade.
assert.equal(hash.digest('hex'), 'fe50fd5deb432c9dc0ff11c60fcf9103a0b68f106709bc83bb41eef42bf03a90');
lawn.made.dispose();

setGrassMaterial(() => new THREE.MeshLambertMaterial(), { value: true });
const sliced = new StreetGrass(), realPerformance = globalThis.performance;
let now = 0, queries = 0;
Object.defineProperty(globalThis, 'performance', { configurable: true, value: { now: () => now } });
try {
  const ground = { grass: () => { now += .2; queries++; return false; }, height: () => 0 };
  sliced.street(true, 0, 0, ground, 1);
  assert(queries <= 32 && sliced.pending, 'a costly empty cell does not monopolise a frame');
  const old = sliced.pending;
  sliced.street(true, 0, 0, ground, 2);
  assert.notEqual(sliced.pending, old, 'new terrain cancels unfinished placement');
  sliced.street(false);
  assert.equal(sliced.pending, null, 'leaving street view cancels placement');
  sliced.made.dispose();
} finally { Object.defineProperty(globalThis, 'performance', { configurable: true, value: realPerformance }); }

function leaves(g) {
  const out = [], part = g.attributes.part;
  for (let i = 0; i < part.count; i++) if (part.getX(i) === 0) {
    for (const name of ['position', 'normal', 'uv', 'part']) {
      const a = g.attributes[name];
      out.push(...a.array.subarray(i * a.itemSize, (i + 1) * a.itemSize));
    }
  }
  return out;
}
for (const [seed, boughs] of [[5, 9], [9, 13]]) {
  const full = streetTreeGeometry(seed, boughs, 3), originalLeaves = leaves(full);
  for (const detail of [.5, .75]) {
    const reduced = streetTreeGeometry(seed, boughs, 3, detail);
    assert(reduced.index.count < full.index.count, 'lower tiers reduce wood triangles');
    assert.deepEqual(leaves(reduced), originalLeaves, 'leaf placement and crown silhouette stay intact');
    reduced.dispose();
  }
  full.dispose();
}

let previous = { avatars: 0, avatarReach: 0, carReach: 0, treeWood: 0, vrScale: 0 };
for (const tier of ['lowest', 'low', 'medium', 'high', 'ultra']) {
  const budget = STREET_TIERS[tier];
  for (const key of Object.keys(previous)) assert(budget[key] >= previous[key], `${tier}: ${key} scales in order`);
  previous = budget;
}
assert.deepEqual(STREET_QUALITY, STREET_TIERS.high, 'startup budget retains High detail');
for (const tier of ['lowest', 'medium', 'ultra']) {
  Object.assign(STREET_QUALITY, STREET_TIERS[tier]);
  const avatars = new LifeSize(new THREE.Scene(), null);
  avatars.on = true; avatars.reach = STREET_QUALITY.avatarReach;
  avatars.baseKinds = Array(14).fill(0);
  avatars.kinds = [{ standing: ['idle'], clips: { idle: { duration: 1 }, umbrella: { duration: 1 } } }];
  avatars.pose = () => {};
  avatars.take = kind => ({ kind, pos: new THREE.Vector3(), last: new THREE.Vector3(), turn: new THREE.Quaternion(), t: {}, w: {}, want: {} });
  const group = { self: false, lifeSize: true };
  for (let id = 0; id < 40; id++) avatars.claim(group, id, new THREE.Matrix4().makeTranslation(3 + id / 100, 0, 0), { name: 'idle', phase: 0 }, -1);
  assert.equal(avatars.live.size, STREET_QUALITY.avatars, `${tier}: actual avatar claims obey the cap`);
  assert(avatars.claim({ ...group, self: true }, 0, new THREE.Matrix4(), { name: 'idle', phase: 0 }, -1), 'the player keeps a detailed avatar even at the cap');
}
Object.assign(STREET_QUALITY, STREET_TIERS.high);

// Exercise session entry/re-entry without granting permissions or claiming to
// emulate stereo rendering. In-session canvas DPR is tested in check-graphics.
const savedGlobals = Object.fromEntries(['window', 'document', 'navigator'].map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
try {
  const events = [], xr = { isPresenting: false,
    setFramebufferScaleFactor: scale => { assert(!xr.isPresenting, 'never resize an active XR framebuffer'); events.push(scale); },
    setSession: async () => { xr.isPresenting = true; },
  };
  const session = new EventTarget(); session.end = async () => { xr.isPresenting = false; session.dispatchEvent(new Event('end')); };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { requestAnimationFrame: () => 1 } });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { body: { classList: { add() {}, remove() {} } } } });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { xr: { requestSession: async () => session } } });
  const vr = Object.assign(Object.create(VR.prototype), { renderer: { xr }, active: false, scale: null, queue: [], nativeRAF: () => 1 });
  await vr.enter();
  assert.equal(events.at(-1), .75, 'High allocates the existing VR scale');
  Object.assign(STREET_QUALITY, STREET_TIERS.low);
  await session.end(); await vr.enter();
  assert.equal(events.at(-1), .55, 're-entry picks up the tier reached in the previous session');
  await session.end(); vr.scale = .6; await vr.enter();
  assert.equal(events.at(-1), .6, 'vrscale overrides the tier');
  await session.end();
} finally {
  Object.assign(STREET_QUALITY, STREET_TIERS.high);
  for (const [key, descriptor] of Object.entries(savedGlobals)) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
  }
}
const auto = new AutoTier('high', () => false);
for (let i = 0; i < 60; i++) assert.equal(auto.record(22, 1000 + i * 22), null, 'desktop holds 45 FPS');
auto.target(1000 / 60, 3000);
let next;
for (let i = 0; i < 60; i++) next = auto.record(22, 7000 + i * 22);
assert.equal(next, 'medium', 'a headset steps down below its refresh budget');
auto.target(25, 10000);
for (let i = 0; i < 60; i++) assert.equal(auto.record(22, 14000 + i * 22), null, 'leaving XR restores desktop target');
console.log('Street quality: exact grass geometry, frame slices/cancellation, tree leaves, avatar caps, XR re-entry/override and refresh target passed.');
