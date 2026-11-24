import assert from 'node:assert/strict';
import * as THREE from 'three';
import { PlayerGaze } from '../src/avatarGaze.ts';

const root = new THREE.Group(), hips = new THREE.Bone(), foot = new THREE.Bone();
root.add(hips); hips.add(foot); foot.position.set(.12,.08,.05);
let parent = hips;
for (const name of ['Bip01_Spine2','Bip01_Neck','Bip01_Head']) {
  const bone = new THREE.Bone(); bone.name = name; bone.position.y = .2;
  bone.rotation.x = .03;
  parent.add(bone); parent = bone;
}
const head = parent, camera = new THREE.PerspectiveCamera();
camera.lookAt(10,2,0);
const rig = new PlayerGaze(root), forward = new THREE.Vector3(0,0,1);
const initial = head.getWorldQuaternion(new THREE.Quaternion());
const sole = foot.getWorldPosition(new THREE.Vector3());
const actual = () => head.getWorldQuaternion(new THREE.Quaternion());
for (let n = 0; n < 60; n++) { rig.restore(); rig.apply(1/60,camera,root,1); }
const turned = actual();
const corrected = forward.clone().applyQuaternion(turned.clone().multiply(initial.clone().invert()));
assert(corrected.x > .70 && corrected.y > .04, 'the upper body can look across and up during a sidestep');
assert(sole.distanceTo(foot.getWorldPosition(new THREE.Vector3())) < 1e-9, 'the feet keep their animated pose');
for (let n = 0; n < 30; n++) { rig.restore(); rig.apply(0,camera,root,1); }
assert(turned.angleTo(actual()) < 1e-6, 'a frozen mixer pose does not accumulate head rotation');
rig.restore(); rig.apply(.05,camera,root,0);
assert(initial.angleTo(actual()) < 1e-6, 'an action with its own head pose keeps it');
rig.release(); root.rotation.y = Math.PI; rig.apply(0,camera,root,1);
assert(root.quaternion.clone().multiply(initial).angleTo(actual()) < 1e-6, 'a pooled character carries no previous gaze');
console.log('Player gaze follows the camera, preserves feet and action poses, and restores pooled rigs');
