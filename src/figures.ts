import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { lampLit } from './lamps.ts';
import { send } from './gpu.ts';

// People and two-wheelers from public/figures.glb (built in Blender by
// assets/figures/build.py): a low-poly person with a skeleton and a few clips, a bike
// and a motorbike.
//
// Skinning hundreds of people every frame would be slow, so at load every clip is
// played through once and the posed vertices go into two float textures (positions and
// normals, one row per frame). A person is then just an instance: the vertex shader
// reads its row, blends to the next frame and, while one clip fades into another,
// with the other clip too. The whole crowd is one draw call.

export const SCALE = 1.35; // people (and what they ride) are drawn bigger than life, to read from above
const FPS = 24;
const PARTS = ['Skin', 'Shirt', 'Sleeve', 'Trousers', 'Shoes', 'Hair'];

interface ClipInfo { row: number; frames: number; duration: number; loop: boolean }
export interface Look { shirt: string; trousers: string; skin: string; hair: string; sleeves: boolean }
export interface FigureKit {
  geometry: THREE.BufferGeometry;
  clips: Record<string, ClipInfo>;
  N: number;
  pos: THREE.DataTexture;
  nrm: THREE.DataTexture;
  material: THREE.MeshLambertMaterial;
  depthMaterial: THREE.MeshDepthMaterial;
  vehicles: { bike: (paint: string) => THREE.BufferGeometry; moto: (paint: string) => THREE.BufferGeometry };
}

// Where the jump clip leaves the ground and lands again, in seconds.
export const JUMP = { up: 7 / 24, down: 16 / 24 };

export async function loadKit(url = 'figures.glb') {
  const gltf = await new GLTFLoader().loadAsync(url);
  const root = gltf.scene;
  const parts: THREE.SkinnedMesh[] = [];
  root.traverse((o) => { if (o instanceof THREE.SkinnedMesh) parts.push(o); });
  root.updateMatrixWorld(true);

  // One geometry for the person, with each vertex's part (skin, shirt, …) as an attribute.
  const geos = parts.map((m) => {
    const g = new THREE.BufferGeometry();
    g.setIndex(m.geometry.index);
    g.setAttribute('position', m.geometry.attributes.position);
    g.setAttribute('normal', m.geometry.attributes.normal);
    const part = PARTS.indexOf((Array.isArray(m.material) ? m.material[0] : m.material).name);
    g.setAttribute('aPart', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count).fill(part), 1));
    return g;
  });
  const geometry = mergeGeometries(geos);
  const N = geometry.attributes.position.count;

  // Play every clip through and keep where each vertex ends up.
  const mixer = new THREE.AnimationMixer(root);
  const clips: Record<string, ClipInfo> = {};
  let rows = 0;
  for (const clip of gltf.animations) {
    const frames = Math.round(clip.duration * FPS);
    clips[clip.name] = { row: rows, frames, duration: frames / FPS, loop: ['idle', 'walk', 'jog', 'run', 'bike', 'moto'].includes(clip.name) };
    rows += frames + 1;
  }
  const pos = new Float32Array(N * rows * 4), nrm = new Float32Array(N * rows * 4);
  const v = new THREE.Vector3(), n = new THREE.Vector3(), m = new THREE.Matrix4(), acc = new THREE.Matrix4(), nm = new THREE.Matrix3();
  const idx = new THREE.Vector4(), wt = new THREE.Vector4();
  for (const clip of gltf.animations) {
    const c = clips[clip.name];
    mixer.stopAllAction();
    const action = mixer.clipAction(clip);
    action.setLoop(THREE.LoopOnce, 1);
    action.clampWhenFinished = true;
    action.play();
    for (let f = 0; f <= c.frames; f++) {
      mixer.setTime(Math.min(f / FPS, clip.duration));
      root.updateMatrixWorld(true);
      let base = 0;
      for (const mesh of parts) {
        const g = mesh.geometry, bones = mesh.skeleton.bones, inv = mesh.skeleton.boneInverses;
        for (let i = 0; i < g.attributes.position.count; i++) {
          idx.fromBufferAttribute(g.attributes.skinIndex as THREE.BufferAttribute, i);
          wt.fromBufferAttribute(g.attributes.skinWeight as THREE.BufferAttribute, i);
          acc.set(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
          for (let k = 0; k < 4; k++) {
            const w = wt.getComponent(k);
            if (!w) continue;
            m.multiplyMatrices(bones[idx.getComponent(k)].matrixWorld, inv[idx.getComponent(k)]);
            for (let e = 0; e < 16; e++) acc.elements[e] += m.elements[e] * w;
          }
          acc.premultiply(mesh.bindMatrixInverse).multiply(mesh.bindMatrix);
          v.fromBufferAttribute(g.attributes.position, i).applyMatrix4(acc);
          n.fromBufferAttribute(g.attributes.normal, i).applyMatrix3(nm.getNormalMatrix(acc)).normalize();
          const o = ((c.row + f) * N + base + i) * 4;
          pos.set([v.x, v.y, v.z, 1], o);
          nrm.set([n.x, n.y, n.z, 0], o);
        }
        base += g.attributes.position.count;
      }
    }
  }
  mixer.stopAllAction();
  const tex = (data: Float32Array) => {
    const t = new THREE.DataTexture(data, N, rows, THREE.RGBAFormat, THREE.FloatType);
    t.needsUpdate = true;
    return t;
  };
  const base = { geometry, clips, N, pos: tex(pos), nrm: tex(nrm) };
  return {
    ...base,
    material: vatMaterial(new THREE.MeshLambertMaterial(), base, true),
    depthMaterial: vatMaterial(new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking }), base, false),
    vehicles: { bike: vehicle(root, 'Bike'), moto: vehicle(root, 'Moto') },
  } satisfies FigureKit;
}

// A two-wheeler as one geometry with its colours per vertex; `paint(hex)` gives a
// copy with the frame (the Paint parts) in that colour.
function vehicle(root: THREE.Object3D, name: string) {
  const node = root.getObjectByName(name);
  if (!node) throw new Error(`Missing ${name} in figures kit`);
  const meshes: THREE.Mesh[] = [];
  node.traverse((o) => { if (o instanceof THREE.Mesh) meshes.push(o); });
  const COLOUR: Record<string, string> = { Tyre: '#141414', Metal: '#9aa0a6', Seat: '#1c1a19', Engine: '#43464b', Lamp: '#fff1c9' };
  const cache = new Map<string, THREE.BufferGeometry>();
  return (paint: string): THREE.BufferGeometry => {
    const known = cache.get(paint);
    if (known) return known;
    const c = new THREE.Color(), red = new THREE.Color('#c0171d');
    const geos = meshes.map((m) => {
      const g = new THREE.BufferGeometry();
      g.setIndex(m.geometry.index);
      g.setAttribute('position', m.geometry.attributes.position.clone());
      g.setAttribute('normal', m.geometry.attributes.normal.clone());
      g.applyMatrix4(m.matrixWorld);
      g.scale(SCALE, SCALE, SCALE);
      const material = Array.isArray(m.material) ? m.material[0] : m.material;
      c.set(material.name === 'Paint' ? paint : COLOUR[material.name] || '#777777');
      const p = g.attributes.position, col = new Float32Array(p.count * 3);
      // Lamps at the back are rear lights.
      for (let i = 0; i < p.count; i++) col.set(material.name === 'Lamp' && p.getX(i) < 0 ? [red.r, red.g, red.b] : [c.r, c.g, c.b], i * 3);
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      return g;
    });
    const g = mergeGeometries(geos);
    cache.set(paint, g);
    return g;
  };
}

function vatMaterial<T extends THREE.MeshLambertMaterial | THREE.MeshDepthMaterial>(material: T, kit: Pick<FigureKit, 'pos' | 'nrm'>, colour: boolean): T {
  material.onBeforeCompile = (sh) => {
    sh.uniforms.uPos = { value: kit.pos };
    sh.uniforms.uNrm = { value: kit.nrm };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
uniform highp sampler2D uPos;
uniform highp sampler2D uNrm;
attribute vec4 aAnimA;
attribute vec4 aAnimB;
attribute float aPart;
attribute vec3 aShirt;
attribute vec3 aTrousers;
attribute vec3 aSkin;
attribute vec3 aHair;
varying vec3 vTint;
vec3 vat(highp sampler2D t) {
  int id = gl_VertexID;
  vec3 a = mix(texelFetch(t, ivec2(id, int(aAnimA.x)), 0).xyz, texelFetch(t, ivec2(id, int(aAnimA.y)), 0).xyz, aAnimA.z);
  vec3 b = mix(texelFetch(t, ivec2(id, int(aAnimB.x)), 0).xyz, texelFetch(t, ivec2(id, int(aAnimB.y)), 0).xyz, aAnimB.z);
  return mix(a, b, aAnimA.w);
}`)
      .replace('#include <beginnormal_vertex>', 'vec3 objectNormal = normalize(vat(uNrm));')
      .replace('#include <begin_vertex>', `vec3 transformed = vat(uPos);
vTint = aPart < 0.5 ? aSkin : aPart < 1.5 ? aShirt : aPart < 2.5 ? (aAnimB.w > 0.5 ? aShirt : aSkin)
  : aPart < 3.5 ? aTrousers : aPart < 4.5 ? vec3(0.02, 0.018, 0.016) : aHair;`);
    if (colour) {
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vTint;')
        .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb *= vTint;');
      lampLit(sh);
    }
  };
  material.customProgramCacheKey = () => `figures-${colour}`;
  material.userData.vat = kit;
  return material;
}

// What someone wears. Colours are hex strings; `sleeves` long or short.
const SHIRTS = ['#3b4a63', '#5c3a3a', '#2f2f33', '#6a6f5a', '#8a6d4e', '#a8a39a', '#264653', '#7b4b6a', '#c26a3d', '#4f6d7a', '#1f2a36', '#9c3b30', '#d8d2c4', '#b8893a', '#e0e0dc'];
const TROUSERS = ['#23272e', '#2f3a4f', '#3e3a33', '#5a5347', '#1b1b1d', '#44506a', '#6b6255', '#2b3b36'];
const SKIN = ['#e3b99a', '#d4a383', '#b9825f', '#8d5a3e', '#f0cdb3'];
const HAIR = ['#2a1d15', '#4a3222', '#8a6a44', '#1a1a1a', '#b9b1a6', '#6e4a2c', '#c9a063'];
export function randomLook(r: () => number): Look {
  const pick = (a: string[]) => a[Math.floor(r() * a.length)];
  return { shirt: pick(SHIRTS), trousers: pick(TROUSERS), skin: pick(SKIN), hair: pick(HAIR), sleeves: r() < 0.6 };
}

// A delivery courier: a jacket in the colour of their box.
export function courierLook(r: () => number, colour: string): Look {
  return { ...randomLook(r), shirt: colour, trousers: '#23272e', sleeves: true };
}

// A group of people drawn together. Each one is a slot: give it a look once, then a
// matrix and an Anim every frame.
export class Figures {
  kit: FigureKit;
  attr: Record<string, THREE.InstancedBufferAttribute>;
  looks: Record<string, THREE.InterleavedBufferAttribute>;
  mesh: THREE.InstancedMesh<THREE.BufferGeometry, THREE.MeshLambertMaterial>;
  capacity: number;
  sleeves: Uint8Array;

  constructor(kit: FigureKit, capacity: number) {
    this.kit = kit;
    const base = kit.geometry, g = new THREE.BufferGeometry();
    g.setIndex(base.index);
    for (const k of ['position', 'normal', 'aPart']) g.setAttribute(k, base.attributes[k]);
    this.attr = {};
    for (const k of ['aAnimA', 'aAnimB']) {
      // (No DynamicDrawUsage: three.js's WebGPU renderer sends such a buffer whole every frame, needed or not.)
      const a = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
      g.setAttribute(k, a);
      this.attr[k] = a;
    }
    // The four colours share one vertex buffer (WebGPU allows eight).
    const worn = new THREE.InstancedInterleavedBuffer(new Float32Array(capacity * 12), 12, 1);
    this.looks = {};
    ['aShirt', 'aTrousers', 'aSkin', 'aHair'].forEach((k, n) => {
      g.setAttribute(k, (this.looks[k] = new THREE.InterleavedBufferAttribute(worn, 3, n * 3)));
    });
    this.mesh = new THREE.InstancedMesh(g, kit.material, capacity);
    this.mesh.customDepthMaterial = kit.depthMaterial;
    this.mesh.castShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.capacity = capacity;
    this.sleeves = new Uint8Array(capacity);
  }

  look(i: number, look: Look) {
    const c = new THREE.Color();
    for (const [k, v] of ([['aShirt', look.shirt], ['aTrousers', look.trousers], ['aSkin', look.skin], ['aHair', look.hair]] as [string, string][])) {
      c.set(v);
      this.looks[k].setXYZ(i, c.r, c.g, c.b);
      this.looks[k].data.needsUpdate = true;
    }
    this.sleeves[i] = look.sleeves ? 1 : 0;
  }

  set(i: number, matrix: THREE.Matrix4, anim: Anim) {
    this.mesh.setMatrixAt(i, matrix);
    anim.write(this.attr.aAnimA, this.attr.aAnimB, i, this.sleeves[i]);
  }

  commit(count = this.mesh.count) {
    this.mesh.count = count;
    send(this.mesh.instanceMatrix, count);
    send(this.attr.aAnimA, count);
    send(this.attr.aAnimB, count);
  }
}

// Walking, jogging and running. `stride` is the metres one cycle (two steps) covers,
// so feet keep pace with the ground: the clip's own stride (GAITS in
// assets/figures/build.py) times SCALE. Each gait shows alone at speeds (m/s) from
// `from` to `to`; between one's `to` and the next one's `from` the two are blended.
const GAITS = [
  { clip: 'walk', stride: 1.6, from: 0, to: 1.9 },
  { clip: 'jog', stride: 2.6, from: 2.9, to: 4.4 },
  { clip: 'run', stride: 3.8, from: 6.2, to: Infinity },
];

// Where `speed` falls between the gaits: 0 walking, 1 jogging, 2 running.
function gaitAt(speed: number) {
  for (let i = 0; i < GAITS.length; i++) {
    const g = GAITS[i];
    if (speed <= g.to) return speed >= g.from ? i : i - 1 + (speed - GAITS[i - 1].to) / (g.from - GAITS[i - 1].to);
  }
  return GAITS.length - 1;
}

// One person's animation: the clip playing and, for a moment after a change, the one
// it's fading out of. On the move, the two are instead neighbouring gaits, mixed by
// speed.
export class Anim {
  clips: Record<string, ClipInfo>;
  name: string;
  t: number;
  from: string | null;
  ft: number;
  w: number;
  fade: number;
  // Mixing two gaits rather than fading: `w` is how much of `from` shows.
  blend = false;
  // How far through a cycle the feet are (0 to 1), and the gait shown (as from gaitAt).
  phase = 0;
  gait = 0;

  constructor(kit: FigureKit, clip = 'idle', t = 0) {
    this.clips = kit.clips;
    this.name = clip;
    this.t = t;
    this.from = null;
    this.ft = 0;
    this.w = 0;
    this.fade = 0.15;
    // Starting mid-stride (a crowd, out of step).
    const g = GAITS.findIndex((g) => g.clip === clip);
    if (g >= 0) Object.assign(this, { gait: g, phase: (t / this.duration) % 1 });
  }

  play(name: string, restart = false, fade = 0.15) {
    if (name === this.name && !restart && !this.blend) return;
    // Out of a mix of gaits: fade from whichever of the two shows more.
    if (this.blend && this.w > 0.5 && this.from) Object.assign(this, { name: this.from, t: this.ft });
    this.blend = false;
    Object.assign(this, { from: this.name, ft: this.t, w: fade > 0 ? 1 : 0, fade, name, t: 0 });
  }

  // On foot at `speed` (m/s, negative backwards).
  move(dt: number, speed: number) {
    const want = gaitAt(Math.abs(speed));
    if (!GAITS.some((g) => g.clip === this.name)) {
      // Setting off, or landing from a jump: fade into the nearest gait with a fresh step.
      this.gait = Math.round(want);
      this.phase = 0;
      this.play(GAITS[this.gait].clip, false, 0.2);
    }
    // Only one gait at a time until the fade is over.
    if (!this.blend && this.w > 0) this.gait = GAITS.findIndex((g) => g.clip === this.name);
    else {
      this.blend = true;
      this.gait += (want - this.gait) * Math.min(1, dt * 6);
    }
    const lo = Math.min(Math.floor(this.gait), GAITS.length - 2), mix = this.gait - lo;
    const stride = GAITS[lo].stride + (GAITS[lo + 1].stride - GAITS[lo].stride) * mix;
    this.phase = (((this.phase + (dt * speed) / stride) % 1) + 1) % 1;
    if (this.blend) {
      this.name = GAITS[lo].clip;
      this.from = GAITS[lo + 1].clip;
      this.w = mix;
      this.ft = this.phase * this.clips[this.from].duration;
    } else {
      this.ft += dt;
      this.w = Math.max(0, this.w - dt / this.fade);
    }
    this.t = this.phase * this.duration;
  }

  // `rate` 1 is the clip's own speed.
  step(dt: number, rate = 1) {
    this.t += dt * rate;
    if (this.w > 0) {
      this.ft += dt * rate;
      this.w = Math.max(0, this.w - dt / this.fade);
    }
  }

  get duration() { return this.clips[this.name].duration; }
  get done() { return !this.clips[this.name].loop && this.t >= this.duration; }

  rows(name: string, t: number): [number, number, number] {
    const c = this.clips[name];
    let f = t * FPS;
    if (c.loop) f = ((f % c.frames) + c.frames) % c.frames;
    else f = Math.min(Math.max(f, 0), c.frames);
    const i = Math.min(Math.floor(f), c.frames);
    return [c.row + i, c.row + Math.min(i + 1, c.frames), f - i];
  }

  write(A: THREE.InstancedBufferAttribute, B: THREE.InstancedBufferAttribute, i: number, sleeves: number) {
    const [a0, a1, af] = this.rows(this.name, this.t);
    const [b0, b1, bf] = this.w > 0 ? this.rows(this.from ?? this.name, this.ft) : [a0, a1, af];
    A.setXYZW(i, a0, a1, af, this.w);
    B.setXYZW(i, b0, b1, bf, sleeves);
  }
}

// Height off the ground partway through the jump clip.
export function jumpHeight(t: number, h = 1) {
  if (t <= JUMP.up || t >= JUMP.down) return 0;
  const u = (t - JUMP.up) / (JUMP.down - JUMP.up);
  return 4 * h * u * (1 - u);
}
