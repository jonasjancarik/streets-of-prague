// Fit the game's authored actions to the shared avatar rig. Run from any directory.
import fs from 'node:fs';
import * as T from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { glbSkeleton, writeClips } from './format.mjs';
import { fittedRidingClips } from './riding.mjs';

const asset = (name) => new URL('../../public/' + name, import.meta.url);
const bytes = fs.readFileSync(asset('figures.glb'));
const source = await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
const { root } = glbSkeleton(asset('rocketbox/female-adult-01.glb'));
root.rotation.y = Math.PI / 2; // work in the figure's coordinate system (+x forward)
const rotation = (bone) => bone.getWorldQuaternion(new T.Quaternion());
const position = (bone) => bone.getWorldPosition(new T.Vector3());
const joint = (name) => root.getObjectByName(name);
const hips = source.scene.getObjectByName('hips');
const origin = position(hips), targetHips = joint('Bip01');
const scale = targetHips.position.y / origin.y;
const start = targetHips.position.clone();
const bones = [];

// Keep the avatar's roll about each limb, but align its rest direction with the
// figure's (especially the arms, which the avatar holds out to the sides).
function map(from, to, tip) {
  const src = source.scene.getObjectByName(from), dst = joint(to);
  if (tip) {
    const current = position(joint(tip)).sub(position(dst)).normalize();
    const wanted = new T.Vector3(0, 1, 0).applyQuaternion(rotation(src));
    const swing = new T.Quaternion().setFromUnitVectors(current, wanted);
    dst.quaternion.copy(rotation(dst.parent).invert().multiply(swing).multiply(rotation(dst)));
  }
  bones.push({ src, dst, offset: rotation(src).invert().multiply(rotation(dst)) });
}

map('hips', 'Bip01');
map('spine', 'Bip01_Spine1');
map('neck', 'Bip01_Neck');
map('head', 'Bip01_Head');
for (const s of ['L', 'R']) {
  const prefix = 'Bip01_' + s + '_';
  for (const [from, to, tip] of [
    ['upper_arm', 'UpperArm', 'Forearm'], ['forearm', 'Forearm', 'Hand'],
    ['thigh', 'Thigh', 'Calf'], ['shin', 'Calf', 'Foot'], ['foot', 'Foot', 'Toe0'],
  ]) map(from + s, prefix + to, prefix + tip); // GLTFLoader strips periods from bone names
}

const mixer = new T.AnimationMixer(source.scene);
const clips = [], data = [], fps = 24;
for (const clip of source.animations) {
  if (['idle', 'walk', 'jog', 'run'].includes(clip.name)) continue;
  mixer.stopAllAction();
  const action = mixer.clipAction(clip).setLoop(T.LoopOnce, 1);
  action.clampWhenFinished = true;
  action.play();
  const frames = Math.round(clip.duration * fps) + 1;
  const pos = [], turns = bones.map(() => []);
  for (let i = 0; i < frames; i++) {
    mixer.setTime(Math.min(i / fps, clip.duration));
    const displacement = position(hips).sub(origin).applyQuaternion(root.quaternion.clone().invert());
    pos.push(...displacement.multiplyScalar(scale).add(start).divideScalar(start.y).toArray());
    // Parent first. Intermediate unmapped bones keep their own local bind pose.
    for (const [n, { src, dst, offset }] of bones.entries()) {
      const q = rotation(dst.parent).invert().multiply(rotation(src)).multiply(offset).normalize();
      if (q.dot(dst.quaternion) < 0) q.set(-q.x, -q.y, -q.z, -q.w);
      dst.quaternion.copy(q);
      turns[n].push(...q.toArray());
    }
  }
  if (clip.name === 'bike' || clip.name === 'moto') {
    const fitted = fittedRidingClips(clip.name,fps,pos,bones.map(({dst})=>dst.name),turns,asset);
    clips.push(...fitted.clips); data.push(...fitted.data);
    continue;
  }
  clips.push({ name: clip.name, fps, frames, joints: bones.map(({ dst }) => dst.name), still: [] });
  data.push(Int16Array.from(pos, (v) => Math.round(v * 1000)));
  for (const track of turns) data.push(Int16Array.from(track, (v) => Math.round(v * 32767)));
}
writeClips(asset('rocketbox/actions.bin'), clips, data);
