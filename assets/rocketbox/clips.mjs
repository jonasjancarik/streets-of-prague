// Rocketbox's clips (3ds Max FBX, the Bip01 skeleton) for the avatars in public/rocketbox,
// written as public/rocketbox/clips.bin (read by src/rocketbox.ts).
//
//   node assets/rocketbox/clips.mjs <dir of clip .fbx> <an avatar's .fbx> <the same avatar's .glb> <out.bin>
//
// The avatars' GLBs were converted in Blender, which gives every bone its own axes, worked
// out from the pose the file was saved in. A clip converted the same way gets different
// axes (it's saved mid-stride), so its rotations bend the avatars' joints the wrong way (the
// knees backwards). Here the clips are read as 3ds Max wrote them (three.js's FBXLoader keeps
// Max's axes, the same in every Rocketbox file) and played on one avatar's FBX; each bone's
// turn in the world then goes onto the GLB's axes through a fixed offset per bone, measured
// with both copies of that avatar standing in its rest pose.
//
// The file: a uint32 header length, the header (JSON: per clip its name, frame count, fps,
// the joints that move and those that keep still), then int16s, per clip: Bip01's position
// (millimetres, 3 a frame), each moving joint's local rotation (4 a frame, in 32767ths),
// then each still joint's (4, once). Walks and runs are sampled 30 times a second, the
// slower standing clips 15.
import fs from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

// (FBXLoader asks for the avatar's textures; nothing is drawn here.)
globalThis.document ??= { createElementNS: () => ({ addEventListener() {}, removeEventListener() {}, setAttribute() {}, style: {} }) };

const [clipDir, avatarFbx, avatarGlb, out] = process.argv.slice(2);
const buffer = (p) => { const b = fs.readFileSync(p); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const fbx = (p) => new FBXLoader().parse(buffer(p), '');

// The GLB avatar as a bare skeleton (its textures aren't needed, and Node can't read them).
function glbSkeleton(p) {
  const b = fs.readFileSync(p), j = JSON.parse(b.subarray(20, 20 + b.readUInt32LE(12)).toString());
  const objs = j.nodes.map((n) => {
    const o = new THREE.Object3D();
    o.name = THREE.PropertyBinding.sanitizeNodeName(n.name);
    if (n.translation) o.position.fromArray(n.translation);
    if (n.rotation) o.quaternion.fromArray(n.rotation);
    if (n.scale) o.scale.fromArray(n.scale);
    return o;
  });
  j.nodes.forEach((n, i) => (n.children || []).forEach((c) => objs[i].add(objs[c])));
  const root = new THREE.Object3D();
  for (const i of j.scenes[0].nodes) root.add(objs[i]);
  const joints = j.skins[0].joints.map((i) => objs[i].name);
  root.updateMatrixWorld(true);
  return { root, joints };
}

const glb = glbSkeleton(avatarGlb);
const max = fbx(avatarFbx);
max.updateMatrixWorld(true);
const _prev = new THREE.Quaternion();
const q = (o) => o.getWorldQuaternion(new THREE.Quaternion());
const p = (o) => o.getWorldPosition(new THREE.Vector3());

// Each joint's offset from Max's axes to the GLB's, at rest.
const offset = {};
for (const name of glb.joints) {
  const m = max.getObjectByName(name);
  if (!m) throw new Error(`${name} is missing from ${avatarFbx}`);
  offset[name] = q(m).invert().multiply(q(glb.root.getObjectByName(name)));
}
// Max's file is in centimetres: Bip01's height in each gives the scale.
const scale = p(glb.root.getObjectByName('Bip01')).y / p(max.getObjectByName('Bip01')).y;

const clips = [], data = [];
for (const file of fs.readdirSync(clipDir).filter((f) => f.endsWith('.fbx')).sort()) {
  const src = fbx(path.join(clipDir, file));
  const clip = src.animations[0];
  const mixer = new THREE.AnimationMixer(src);
  // (Played once and held: looping, the last frame would wrap round to the first.)
  const action = mixer.clipAction(clip).setLoop(THREE.LoopOnce, 1);
  action.clampWhenFinished = true;
  action.play();
  const FPS = /walk|run/.test(file) ? 30 : 15;
  const frames = Math.round(clip.duration * FPS) + 1;
  const pos = new Float32Array(frames * 3), rot = Object.fromEntries(glb.joints.map((n) => [n, new Float32Array(frames * 4)]));
  const world = {}, parent = new THREE.Quaternion(), local = new THREE.Quaternion();
  for (let f = 0; f < frames; f++) {
    mixer.setTime(Math.min(f / FPS, clip.duration));
    src.updateMatrixWorld(true);
    for (const name of glb.joints) world[name] = q(src.getObjectByName(name)).multiply(offset[name]);
    for (const name of glb.joints) {
      const g = glb.root.getObjectByName(name), up = g.parent;
      // The GLB's parent's turn: a joint's (from this frame), or the fixed one above Bip01.
      if (world[up.name]) parent.copy(world[up.name]); else parent.copy(q(up));
      local.copy(parent).invert().multiply(world[name]);
      // (The same way round each frame, so the frames between blend the short way.)
      if (f > 0 && local.dot(_prev.fromArray(rot[name], (f - 1) * 4)) < 0) local.set(-local.x, -local.y, -local.z, -local.w);
      rot[name].set(local.toArray(), f * 4);
    }
    const b = p(src.getObjectByName('Bip01')).multiplyScalar(scale);
    pos.set([b.x, b.y, b.z], f * 3);
  }
  // Joints that hardly turn (most fingers, mostly) are kept as one pose.
  const still = glb.joints.filter((n) => { const r = rot[n]; for (let i = 4; i < r.length; i++) if (Math.abs(r[i] - r[i % 4]) > 0.002) return false; return true; });
  const moving = glb.joints.filter((n) => !still.includes(n));
  clips.push({ name: path.basename(file, '.fbx'), frames, fps: FPS, joints: moving, still });
  data.push(Int16Array.from(pos, (v) => Math.round(v * 1000)));
  for (const n of moving) data.push(Int16Array.from(rot[n], (v) => Math.round(v * 32767)));
  for (const n of still) data.push(Int16Array.from(rot[n].subarray(0, 4), (v) => Math.round(v * 32767)));
  console.log(`${file}: ${frames} frames, ${moving.length} joints moving`);
}

const header = Buffer.from(JSON.stringify({ clips }));
const head = Buffer.alloc(4);
head.writeUInt32LE(header.length);
// (Padded so the numbers start on an even byte.)
const pad = Buffer.alloc(header.length % 2, 0x20);
const floats = Buffer.concat(data.map((a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength)));
head.writeUInt32LE(header.length + pad.length);
fs.writeFileSync(out, Buffer.concat([head, header, pad, floats]));
console.log(`${out}: ${(fs.statSync(out).size / 1e6).toFixed(2)} MB`);
