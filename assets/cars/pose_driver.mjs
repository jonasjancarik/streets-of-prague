// Freeze a shipped Rocketbox avatar at the end of the game's entry animation.
// Called by build.py. The colour maps are sampled by Blender at build time;
// cars.glb needs neither a live skeleton nor external textures for its drivers.
import fs from 'node:fs';
import path from 'node:path';
import * as T from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

const [source, actionFile, output, uniform] = process.argv.slice(2);
const file = fs.readFileSync(source);
const jsonBytes = file.readUInt32LE(12);
const doc = JSON.parse(file.subarray(20, 20 + jsonBytes));
const bin = file.subarray(28 + jsonBytes);
for (const mat of doc.materials) {
  const tex = doc.textures[mat.pbrMetallicRoughness.baseColorTexture.index];
  const image = doc.images[tex.extensions.KHR_texture_basisu.source];
  const view = doc.bufferViews[image.bufferView], start = view.byteOffset || 0;
  const pixels = uniform && mat.name.endsWith('_body') ? fs.readFileSync(uniform) : bin.subarray(start,start+view.byteLength);
  fs.writeFileSync(path.join(output,mat.name+'.ktx2'),pixels);
  delete mat.pbrMetallicRoughness.baseColorTexture;
  delete mat.normalTexture;
}
delete doc.textures; delete doc.images;
for (const names of [doc.extensionsRequired, doc.extensionsUsed]) {
  const i = names.indexOf('KHR_texture_basisu');
  if (i >= 0) names.splice(i, 1);
}
// No face animation is used. Avoid expanding the unused morph targets.
for (const mesh of doc.meshes) {
  delete mesh.weights;
  for (const primitive of mesh.primitives) delete primitive.targets;
  if (mesh.extras) delete mesh.extras.targetNames;
}
const encoded = Buffer.from(JSON.stringify(doc));
const json = Buffer.alloc(Math.ceil(encoded.length / 4) * 4, 32); encoded.copy(json);
const clean = Buffer.alloc(28 + json.length + bin.length);
file.copy(clean, 0, 0, 20); clean.writeUInt32LE(clean.length, 8); clean.writeUInt32LE(json.length, 12);
json.copy(clean, 20);
file.copy(clean, 20 + json.length, 20 + jsonBytes, 28 + jsonBytes);
bin.copy(clean, 28 + json.length);
const { scene } = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder)
  .parseAsync(clean.buffer.slice(clean.byteOffset, clean.byteOffset + clean.byteLength), '');
const bytes = fs.readFileSync(actionFile), length = bytes.readUInt32LE();
const { clips } = JSON.parse(bytes.subarray(4, 4 + length));
const samples = new Int16Array(bytes.buffer, bytes.byteOffset + 4 + length, (bytes.length - 4 - length)/2);
const hips = scene.getObjectByName('Bip01'), hipHeight = hips.position.y;
let at = 0, fitted = false;
for (const clip of clips) {
  const frame = clip.frames - 1, moving = clip.joints.length, still = clip.still.length;
  if (clip.name === 'getin') {
    for (let k = 0; k < 3; k++) hips.position.setComponent(k, samples[at + frame*3+k] * hipHeight/1000);
    let q = at + clip.frames*3;
    for (const name of [...clip.joints, ...clip.still]) {
      const animated = clip.joints.includes(name), start = q + (animated ? frame*4 : 0);
      const bone = scene.getObjectByName(name);
      if (bone) bone.quaternion.fromArray(samples, start).normalize();
      q += animated ? clip.frames*4 : 4;
    }
    fitted = true; break;
  }
  at += clip.frames*(3 + moving*4) + still*4;
}
if (!fitted) throw Error('Missing seated entry pose');
scene.rotation.y = Math.PI / 2;
scene.updateMatrixWorld(true);
const pelvis = hips.getWorldPosition(new T.Vector3()), p = new T.Vector3(), parts = [];
scene.traverse(o => {
  if (!o.isSkinnedMesh) return;
  const g = o.geometry, positions = [], uv = [], tex = g.getAttribute('uv');
  for (let i=0;i<g.attributes.position.count;i++) {
    o.getVertexPosition(i,p);
    o.localToWorld(p).sub(pelvis);
    positions.push(p.toArray()); uv.push([tex.getX(i),tex.getY(i)]);
  }
  parts.push({ name:o.material.name, positions, uv, indices:Array.from(g.index.array) });
});
fs.writeFileSync(path.join(output,'driver.json'),JSON.stringify(parts));
