// Bake the fourteen Rocketbox models used at walking distance into inexpensive
// animated instances for people farther down the street. Run from any directory
// with node assets/rocketbox/crowd.mjs. The atlas step uses Pillow and basisu.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder, MeshoptSimplifier } from 'meshoptimizer';
import { AVATARS, CLIPS, inPlace, readClips } from '../../src/rocketboxClips.ts';

const folder = new URL('../../public/rocketbox/', import.meta.url);
const materials = ['body', 'head', 'opacity', 'glasses'];
const triangleBudget = [385, 150, 85, 30];
const motions = { idle: 'idle_neutral_01', ...CLIPS };
const atlasWidth = 1024, cell = 128, gutter = 4, cellsAcross = atlasWidth / cell;
const atlasHeight = cell * THREE.MathUtils.ceilPowerOfTwo(Math.ceil(AVATARS.length * materials.length / cellsAcross));

// GLTFLoader needs the real skin, bind matrices and geometry. Its browser image
// decoders and unused facial morphs are unnecessary for an offline pose bake.
async function readRig(name) {
  const raw = readFileSync(new URL(name + '.glb', folder));
  const length = raw.readUInt32LE(12);
  const doc = JSON.parse(raw.subarray(20, 20 + length));
  const binary = raw.subarray(28 + length);
  doc.materials = doc.materials.map(m => ({ name: m.name }));
  for (const mesh of doc.meshes) {
    delete mesh.weights;
    for (const primitive of mesh.primitives) delete primitive.targets;
  }
  delete doc.images; delete doc.textures; delete doc.samplers;
  for (const key of ['extensionsRequired', 'extensionsUsed']) doc[key] = doc[key].filter(e => e !== 'KHR_texture_basisu');
  const json = Buffer.from(JSON.stringify(doc)), padded = (json.length + 3) & ~3;
  const glb = Buffer.alloc(padded + 28 + binary.length, 0x20);
  glb.write('glTF'); glb.writeUInt32LE(2, 4); glb.writeUInt32LE(glb.length, 8);
  glb.writeUInt32LE(padded, 12); glb.write('JSON', 16); json.copy(glb, 20);
  glb.writeUInt32LE(binary.length, 20 + padded); glb.write('BIN\0', 24 + padded); binary.copy(glb, 28 + padded);
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  return (await loader.parseAsync(glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength), '')).scene;
}

const vertex = new THREE.Vector3();
function simplify(mesh) {
  const part = materials.indexOf(mesh.material.name.split('_').at(-1));
  if (part < 0) throw new Error('Unknown Rocketbox material ' + mesh.material.name);
  const geometry = mesh.geometry, { position, normal, uv } = geometry.attributes;
  const coordinates = new Float32Array(position.count * 3), attributes = new Float32Array(position.count * 5);
  for (let i = 0; i < position.count; i++) {
    vertex.fromBufferAttribute(position, i).toArray(coordinates, i * 3);
    vertex.fromBufferAttribute(normal, i).toArray(attributes, i * 5);
    attributes[i * 5 + 3] = uv.getX(i);
    attributes[i * 5 + 4] = uv.getY(i);
  }
  const count = Math.min(geometry.index.count, triangleBudget[part] * 3);
  const [triangles] = MeshoptSimplifier.simplifyWithAttributes(Uint32Array.from(geometry.index.array),
    coordinates, 3, attributes, 5, [.15, .15, .15, .35, .35], null, count, .14, ['Prune', 'Permissive']);
  const vertices = [...new Set(triangles)];
  const remap = new Map(vertices.map((original, i) => [original, i]));
  return { mesh, part, vertices, indices: Array.from(triangles, i => remap.get(i)) };
}

// A unit normal fits in ten bits on an octahedron. Half floats represent every
// integer up to 2048 exactly, leaving the fourth channel of each position free
// to carry the normal in the same texture read.
function packNormal(x, y, z) {
  const length = Math.abs(x) + Math.abs(y) + Math.abs(z);
  if (!length) return 512;
  x /= length; y /= length;
  if (z < 0) {
    const oldX = x;
    x = (1 - Math.abs(y)) * Math.sign(oldX || 1);
    y = (1 - Math.abs(oldX)) * Math.sign(y || 1);
  }
  return Math.round((x * .5 + .5) * 31) + 32 * Math.round((y * .5 + .5) * 31);
}

const ab = new THREE.Vector3(), ac = new THREE.Vector3(), normal = new THREE.Vector3();
function pose(parts, vertexCount, indices) {
  const positions = new Float32Array(vertexCount * 3), normals = new Float32Array(vertexCount * 3);
  const texels = new Uint16Array(vertexCount * 4);
  let at = 0;
  for (const { mesh, vertices } of parts) for (const id of vertices) {
    vertex.fromBufferAttribute(mesh.geometry.attributes.position, id);
    mesh.applyBoneTransform(id, vertex).applyMatrix4(mesh.matrixWorld);
    // Rocketbox faces +Z. The game figures face +X.
    positions[at++] = vertex.z; positions[at++] = vertex.y; positions[at++] = -vertex.x;
  }
  for (let j = 0; j < indices.length; j += 3) {
    const a = indices[j] * 3, b = indices[j + 1] * 3, c = indices[j + 2] * 3;
    vertex.fromArray(positions, a);
    ab.fromArray(positions, b).sub(vertex); ac.fromArray(positions, c).sub(vertex);
    normal.crossVectors(ab, ac);
    for (const n of [a, b, c]) {
      normals[n] += normal.x; normals[n + 1] += normal.y; normals[n + 2] += normal.z;
    }
  }
  for (let i = 0; i < vertexCount; i++) {
    for (let k = 0; k < 3; k++) texels[i * 4 + k] = THREE.DataUtils.toHalfFloat(positions[i * 3 + k]);
    texels[i * 4 + 3] = THREE.DataUtils.toHalfFloat(packNormal(normals[i * 3], normals[i * 3 + 1], normals[i * 3 + 2]));
  }
  return texels;
}

await Promise.all([MeshoptSimplifier.ready, MeshoptDecoder.ready]);
const packedClips = readFileSync(new URL('clips.bin', folder));
const library = readClips(packedClips.buffer.slice(packedClips.byteOffset, packedClips.byteOffset + packedClips.byteLength));
const staticWords = [], rows = [], models = [];
let width = 0;
for (const [catalogue, [name, sex]] of AVATARS.entries()) {
  const root = await readRig(name), parts = [];
  root.updateMatrixWorld(true);
  root.traverse(mesh => { if (mesh.isSkinnedMesh) parts.push(simplify(mesh)); });
  const vertexCount = parts.reduce((n, part) => n + part.vertices.length, 0);
  const indices = [], uvOffset = staticWords.length;
  let base = 0;
  for (const { mesh, vertices, indices: local, part } of parts) {
    const slot = materials.length * catalogue + part, uv = mesh.geometry.attributes.uv;
    const x = slot % cellsAcross * cell + gutter, y = Math.floor(slot / cellsAcross) * cell + gutter;
    for (const id of vertices) {
      const u = THREE.MathUtils.clamp(uv.getX(id), 0, 1), v = THREE.MathUtils.clamp(uv.getY(id), 0, 1);
      staticWords.push(Math.round(65535 * (x + u * (cell - 2 * gutter)) / atlasWidth),
        Math.round(65535 * (y + v * (cell - 2 * gutter)) / atlasHeight));
    }
    indices.push(...local.map(i => i + base));
    base += vertices.length;
  }
  const indexOffset = staticWords.length;
  staticWords.push(...indices);
  const clips = {}, hips = root.getObjectByName('Bip01')?.position.y;
  if (!(hips > 0)) throw new Error(name + ' has no hip reference');
  const mixer = new THREE.AnimationMixer(root);
  for (const [motion, source] of Object.entries(motions)) {
    const [clip] = inPlace(library[sex + '_' + source], hips), action = mixer.clipAction(clip).play();
    const frames = motion === 'idle' ? 16 : THREE.MathUtils.clamp(Math.round(clip.duration * 15), 10, 20);
    const duration = motion === 'idle' ? Math.min(3.5, clip.duration) : clip.duration;
    // Rock back through the short idle excerpt so its two ends meet.
    clips[motion] = { row: rows.length, frames, duration: motion === 'idle' ? duration * 2 : duration };
    for (let k = 0; k < frames; k++) {
      const phase = k / frames;
      action.time = duration * (motion === 'idle' ? 1 - Math.abs(2 * phase - 1) : phase);
      mixer.update(0); root.updateMatrixWorld(true);
      rows.push(pose(parts, vertexCount, indices));
    }
    action.stop();
  }
  width = Math.max(width, vertexCount);
  models.push({ name, vertices: vertexCount, uv: uvOffset, index: indexOffset, indices: indices.length, clips });
  console.log(name, vertexCount, 'vertices,', indices.length / 3, 'triangles');
}

// Padded JSON, then UInt16 UVs, indices, and rows of RGBA16F pose texels.
// Neighbouring frames differ little. Store word differences for gzip; the
// browser restores the exact half floats before passing them to the GPU.
const meta = { version: 1, width, height: rows.length, poses: staticWords.length, models };
const words = new Uint16Array(staticWords.length + width * rows.length * 4);
words.set(staticWords);
rows.forEach((row, i) => words.set(row, staticWords.length + i * width * 4));
const stride = width * 4;
for (let i = words.length - 1; i >= staticWords.length + stride; i--) words[i] -= words[i - stride];
const json = Buffer.from(JSON.stringify(meta)), padded = (json.length + 3) & ~3;
const prefix = Buffer.alloc(4 + padded, 0x20);
prefix.writeUInt32LE(padded); json.copy(prefix, 4);
const packed = gzipSync(Buffer.concat([prefix, Buffer.from(words.buffer)]), { level: 9 });
const python = fileURLToPath(new URL('../../pipeline/.venv/bin/python', import.meta.url));
execFileSync(process.env.PYTHON || (existsSync(python) ? python : 'python3'),
  [fileURLToPath(new URL('crowd_atlas.py', import.meta.url)), ...AVATARS.map(a => a[0])], { stdio: 'inherit' });
writeFileSync(new URL('crowd.bin.gz', folder), packed);
console.log('Pose texture', width, '×', rows.length, 'compressed to', packed.length, 'bytes');
