// A nearby walker offered after the crowd pool filled should get a place.
import assert from 'node:assert/strict';
import * as THREE from 'three';
import './offline-city.mjs';

const { LifeSize } = await import('../src/rocketbox.ts');
const { STREET_QUALITY } = await import('../src/streetQuality.ts');
const saved = { ...STREET_QUALITY };
const avatars = new LifeSize(new THREE.Scene(), null);
try {
  Object.assign(STREET_QUALITY, { avatars: 2, avatarReach: 24 });
  const clips = Object.fromEntries(['idle', 'umbrella', 'arm'].map(name => [name, new THREE.AnimationClip(name, 30, [])]));
  avatars.state = 'ready';
  avatars.baseKinds = Array(14).fill(0);
  avatars.kinds = [{ clips, stride: {}, standing: ['idle'], template: new THREE.Group() }];
  avatars.spare = [[]];
  const group = { self: false, lifeSize: true }, camera = new THREE.PerspectiveCamera();
  const transform = new THREE.Matrix4();
  avatars.frame(1/60, true, camera);
  const offer = distances => {
    distances.forEach((x, id) => avatars.claim(group, id, transform.makeTranslation(x, 0, 0), { name: 'idle', phase: 0 }, -1));
    avatars.frame(1/60, true, camera);
    assert(avatars.live.size <= 2);
  };
  for (let i = 0; i < 8; i++) offer([12, 14, 4]);
  const person = id => avatars.live.get(avatars.ids.get(group) + ':' + id);
  const nearest = person(2);
  assert(nearest && nearest.pos.x === 4, 'the late, nearby walker replaces the farthest civilian');
  assert(person(0) && !person(1));
  for (let i = 0; i < 8; i++) offer([12, 11.1, 4]);
  assert(person(0) && person(2) === nearest, 'a small distance change keeps the existing avatars');
  // The waiting walker disappears before the slot becomes free. Another
  // nearby person must still be able to take it.
  offer([12, 3, 4]);
  for (let i = 0; i < 8; i++) offer([12, 50, 4, 3]);
  assert(person(3) && person(2), 'a vanished request releases its reservation');
  console.log('Crowd slot promotion, stable ties, abandoned reservation and actor cap passed');
} finally {
  Object.assign(STREET_QUALITY, saved);
  avatars.dispose();
}
