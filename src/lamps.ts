import * as THREE from 'three';
import { fetchBinary } from './terrain.ts';

// Street lighting at night. The lamps come from IPR's utility map
// (pipeline/build_lamps.py, data/<area>_now/lamps.bin.gz); round the camera they get
// a pole and a glowing head. What they light is drawn into a light map: a square
// texture over the view, seen from above, into which every lamp, and every car's
// headlights, adds a pool of light. Materials read it by their position (LAMP_GLSL,
// lampLit), so lighting costs one texture read a pixel however many lamps there are.
// Its alpha holds the height of the ground under the brightest lamp, so the light
// stays on the ground and the lower walls and doesn't reach the roofs above.

export const LAMP_MAP: { value: THREE.Texture | null } = { value: null };
// (x, z of the map's centre, 1 / its half width, 0)
export const LAMP_BOX = { value: new THREE.Vector4(0, 0, 1, 0) };
// How much the lamps are on: 0 by day, 1 at night.
export const LAMP_ON = { value: 0 };

export const LAMP_GLSL = /* glsl */ `
uniform sampler2D uLampMap; uniform vec4 uLampBox; uniform float uLampOn;
// The lamps' light at a point in the world (0 by day and off the map).
vec3 lampLight(vec3 w) {
  if (uLampOn < .005) return vec3(0.);
  vec2 uv = (w.xz - uLampBox.xy) * uLampBox.z * .5 + .5;
  if (uv.x < 0. || uv.y < 0. || uv.x > 1. || uv.y > 1.) return vec3(0.);
  vec4 l = texture2D(uLampMap, uv);
  return l.rgb * uLampOn * (1. - smoothstep(3., 11., w.y - (l.a - 500.)));
}
`;

type Shader = THREE.WebGLProgramParametersWithUniforms;

// Lamp light on a Lambert material, inside its onBeforeCompile (after the other
// replacements). `world`: a varying with the world position the shader already has.
export function lampLit(sh: Shader, world?: string) {
  sh.uniforms.uLampMap = LAMP_MAP;
  sh.uniforms.uLampBox = LAMP_BOX;
  sh.uniforms.uLampOn = LAMP_ON;
  let w = world;
  if (!w) {
    w = 'vLampW';
    // The world position from the view position (the view matrix is a rotation and a move).
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vLampW;')
      .replace('#include <project_vertex>', '#include <project_vertex>\n  vLampW = transpose(mat3(viewMatrix)) * (mvPosition.xyz - viewMatrix[3].xyz);');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vLampW;');
  }
  sh.fragmentShader = sh.fragmentShader
    .replace('#include <common>', `#include <common>\n${LAMP_GLSL}`)
    .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>\n  reflectedLight.directDiffuse += diffuseColor.rgb * lampLight(${w});`);
}

// Kinds of lamp (pipeline/build_lamps.py): the height of the head, the pole under it,
// how far its light reaches and how bright it is. Floodlights on monuments light the
// walls higher up (`raise`: they count as standing that much higher).
const KINDS = [
  { head: 7.5, pole: true, r: 15, i: 1.0, raise: 0, glow: 0.55 }, // on a pole
  { head: 4.5, pole: false, r: 10, i: 0.8, raise: 0, glow: 0.4 }, // on a wall
  { head: 4.2, pole: true, r: 10, i: 0.8, raise: 0, glow: 0.45 }, // gas lamp
  { head: 5.5, pole: true, r: 11, i: 0.9, raise: 0, glow: 0.45 }, // festive, on a pole
  { head: 1.0, pole: false, r: 9, i: 1.3, raise: 14, glow: 0 }, // floodlight on a monument
  { head: 0, pole: false, r: 7, i: 0.8, raise: 0, glow: 0 }, // in a tunnel or underpass
  { head: 0, pole: false, r: 3, i: 0.4, raise: 0, glow: 0 }, // set into the ground
  { head: 6.5, pole: false, r: 14, i: 0.9, raise: 0, glow: 0.5 }, // added: hung over a street (see fill)
];
const HUNG = 7;
// Many side streets' lamps hang on cables between the houses or sit on their walls,
// and the utility map has few of those: a street with no lamp within REACH gets one
// hung over it every SPACING metres.
const SPACING = 30, REACH = 20;
const UNLIT = new Set(['motorway', 'motorway_link', 'track', 'service']);
// Warm LED, old sodium, neutral LED; gas; floodlights.
const WARM = new THREE.Color('#ffcf8f'), SODIUM = new THREE.Color('#ffa850'), NEUTRAL = new THREE.Color('#f1ece0');
const GAS = new THREE.Color('#ffbb6e'), FLOOD = new THREE.Color('#ffe0b0');
const HEAD = new THREE.Color('#fff4df'), TAIL = new THREE.Color('#ff2a1a'), CABIN = new THREE.Color('#fff0d8');
const TRAM_SECTION = 10.2; // m (trams.ts)

const hash = (i: number) => { const s = Math.sin(i * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); };
function colourOf(kind: number, i: number) {
  if (kind === 2) return GAS;
  if (kind === 4) return FLOOD;
  if (kind === HUNG) return hash(i) < 0.7 ? WARM : SODIUM;
  const r = hash(i);
  return r < 0.55 ? WARM : r < 0.85 ? SODIUM : NEUTRAL;
}

const CELL = 100; // m, the lamps' grid
const MAP_SIZE = 1024; // texels across the light map
const MAX_LIGHTS = 6000;
const MAX_POLES = 4000;

interface Street { hw: string; pts: [number, number][]; tunnel?: boolean }
interface LitTram { parts: { x: number; y: number; ang: number }[]; look: unknown; levels?: { gz?: number }[] }
interface LitCar { x: number; y: number; h: number; spec: { L: number; W: number }; mode: string; two?: string; speed: number }

export class Lamps {
  private xy: number[] = [];
  private kind: number[] = [];
  private loaded = false;
  private waiting: Street[][] = [];
  private grid = new Map<number, number[]>();
  private renderer: THREE.WebGLRenderer;
  private height: (x: number, y: number) => number;
  private target: THREE.WebGLRenderTarget;
  private lightScene = new THREE.Scene();
  private lightCam = new THREE.Camera();
  private lights: THREE.InstancedBufferGeometry;
  private at: THREE.InstancedBufferAttribute; // x, z, ground height, 0 round / 1 beam
  private shape: THREE.InstancedBufferAttribute; // direction x, z, length (or radius), width
  private colour: THREE.InstancedBufferAttribute;
  private view = { value: new THREE.Vector4() };
  private poles: THREE.InstancedMesh;
  private glows: THREE.InstancedMesh;
  private near: number[] = []; // the lamps round the camera
  private nearAt = { x: Infinity, y: Infinity, r: 0, t: 0 };
  private dummy = new THREE.Object3D();
  private c = new THREE.Color();

  constructor(scene: THREE.Scene, renderer: THREE.WebGLRenderer, area: string, height: (x: number, y: number) => number) {
    this.renderer = renderer;
    this.height = height;
    this.target = new THREE.WebGLRenderTarget(MAP_SIZE, MAP_SIZE, { type: THREE.HalfFloatType, depthBuffer: false, magFilter: THREE.LinearFilter, minFilter: THREE.LinearFilter });
    LAMP_MAP.value = this.target.texture;

    // The pools of light, one instanced quad each.
    const quad = new THREE.InstancedBufferGeometry();
    quad.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
    quad.setIndex([0, 1, 2, 0, 2, 3]);
    this.at = new THREE.InstancedBufferAttribute(new Float32Array(MAX_LIGHTS * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.shape = new THREE.InstancedBufferAttribute(new Float32Array(MAX_LIGHTS * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.colour = new THREE.InstancedBufferAttribute(new Float32Array(MAX_LIGHTS * 3), 3).setUsage(THREE.DynamicDrawUsage);
    quad.setAttribute('iAt', this.at);
    quad.setAttribute('iShape', this.shape);
    quad.setAttribute('iColour', this.colour);
    quad.instanceCount = 0;
    this.lights = quad;
    const pools = new THREE.Mesh(quad, new THREE.ShaderMaterial({
      uniforms: { uView: this.view },
      vertexShader: /* glsl */ `
        attribute vec4 iAt; attribute vec4 iShape; attribute vec3 iColour;
        uniform vec4 uView;
        varying vec2 vL; varying vec3 vC; varying float vH; varying float vBeam;
        void main() {
          vec2 dir = iShape.xy, side = vec2(-dir.y, dir.x), q = position.xy, off;
          if (iAt.w > .5) { vL = vec2(q.x * .5 + .5, q.y); off = dir * vL.x * iShape.z + side * q.y * iShape.w; }
          else { vL = q; off = (dir * q.x + side * q.y) * iShape.z; }
          vC = iColour; vH = iAt.z; vBeam = iAt.w;
          gl_Position = vec4((iAt.xy + off - uView.xy) * uView.z, 0., 1.);
        }`,
      fragmentShader: /* glsl */ `
        varying vec2 vL; varying vec3 vC; varying float vH; varying float vBeam;
        void main() {
          float f;
          if (vBeam > .5) {
            float t = vL.x, a = abs(vL.y) / (.25 + .75 * t);
            f = (1. - t) * (1. - t) * smoothstep(1., .35, a) * smoothstep(0., .1, t);
          } else {
            float d = dot(vL, vL);
            f = d < 1. ? (1. - d) * (1. - d) : 0.;
          }
          if (f < .002) discard;
          gl_FragColor = vec4(vC * f, vH + 500.);
        }`,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
      blendEquationAlpha: THREE.MaxEquation, depthTest: false, depthWrite: false,
    }));
    pools.frustumCulled = false;
    this.lightScene.add(pools);

    // Poles with a head, and the heads' glow at night.
    const pole = new THREE.CylinderGeometry(0.07, 0.1, 1, 6).translate(0, 0.5, 0);
    const poleMaterial = new THREE.MeshLambertMaterial({ color: '#3b3d3f' });
    poleMaterial.onBeforeCompile = (sh) => lampLit(sh);
    poleMaterial.customProgramCacheKey = () => 'lamp-pole';
    this.poles = new THREE.InstancedMesh(pole, poleMaterial, MAX_POLES);
    this.poles.count = 0;
    this.poles.frustumCulled = false;
    const glow = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    this.glows = new THREE.InstancedMesh(glow, new THREE.ShaderMaterial({
      uniforms: { uOn: LAMP_ON },
      vertexShader: /* glsl */ `
        varying vec2 vUv; varying vec3 vC;
        void main() { vUv = uv * 2. - 1.; vC = instanceColor; gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.); }`,
      fragmentShader: /* glsl */ `
        uniform float uOn; varying vec2 vUv; varying vec3 vC;
        void main() {
          float d = length(vUv);
          float f = smoothstep(1., .0, d); f = f * f * .5 + smoothstep(.16, .08, d);
          gl_FragColor = vec4(vC * f * uOn, 1.);
        }`,
      blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
    }), MAX_POLES * 2);
    this.glows.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_POLES * 2 * 3), 3);
    this.glows.count = 0;
    this.glows.frustumCulled = false;
    this.glows.renderOrder = 5;
    scene.add(this.poles, this.glows);

    void fetchBinary(`data/${area}_now/lamps.bin.gz`, true).then((buf) => {
      if (!buf) return;
      const n = new DataView(buf).getUint32(0, true);
      const xy = new Float32Array(buf.slice(4, 4 + n * 8)), kind = new Uint8Array(buf, 4 + n * 8, n);
      for (let i = 0; i < n; i++) this.add(xy[i * 2], xy[i * 2 + 1], kind[i]);
    }).catch(() => {}).finally(() => {
      this.loaded = true;
      for (const edges of this.waiting) this.fill(edges);
      this.waiting.length = 0;
      this.nearAt.x = Infinity;
    });
  }

  private add(x: number, y: number, kind: number) {
    const k = this.key(x, y);
    let list = this.grid.get(k);
    if (!list) this.grid.set(k, list = []);
    list.push(this.kind.length);
    this.xy.push(x, y);
    this.kind.push(kind);
  }

  private lampWithin(x: number, y: number, r: number) {
    for (let cx = Math.floor((x - r) / CELL); cx <= Math.floor((x + r) / CELL); cx++) {
      for (let cy = Math.floor((y - r) / CELL); cy <= Math.floor((y + r) / CELL); cy++) {
        const list = this.grid.get((cx + 2048) * 4096 + cy + 2048);
        if (list) for (const i of list) if (Math.hypot(this.xy[i * 2] - x, this.xy[i * 2 + 1] - y) < r) return true;
      }
    }
    return false;
  }

  // Streets as their tiles load: lamps hung over the unlit stretches.
  fill(edges: Street[]) {
    if (!this.loaded) { this.waiting.push(edges); return; }
    for (const e of edges) {
      if (e.tunnel || UNLIT.has(e.hw)) continue;
      let next = SPACING / 2;
      for (let i = 1, s = 0; i < e.pts.length; i++) {
        const [ax, ay] = e.pts[i - 1], [bx, by] = e.pts[i], len = Math.hypot(bx - ax, by - ay);
        for (; next <= s + len; next += SPACING) {
          const t = (next - s) / len, x = ax + (bx - ax) * t, y = ay + (by - ay) * t;
          if (!this.lampWithin(x, y, REACH)) this.add(x, y, HUNG);
        }
        s += len;
      }
    }
    this.nearAt.x = Infinity;
  }

  private key(x: number, y: number) { return (Math.floor(x / CELL) + 2048) * 4096 + Math.floor(y / CELL) + 2048; }

  // The lamps within r of (x, y), again once the camera has moved on, and every few
  // seconds for the heights of tiles that have loaded since.
  private gather(x: number, y: number, r: number, now: number) {
    const a = this.nearAt;
    if (Math.hypot(x - a.x, y - a.y) < 25 && r <= a.r && r > a.r * 0.6 && now - a.t < 3000) return;
    const R = r * 1.25 + 40;
    Object.assign(a, { x, y, r: R, t: now });
    this.near.length = 0;
    for (let cx = Math.floor((x - R) / CELL); cx <= Math.floor((x + R) / CELL); cx++) {
      for (let cy = Math.floor((y - R) / CELL); cy <= Math.floor((y + R) / CELL); cy++) {
        const list = this.grid.get((cx + 2048) * 4096 + cy + 2048);
        if (list) for (const i of list) if (Math.abs(this.xy[i * 2] - x) < R && Math.abs(this.xy[i * 2 + 1] - y) < R) this.near.push(i);
      }
    }
    if (this.near.length > MAX_LIGHTS - 400) this.near.length = MAX_LIGHTS - 400;
    // Poles and heads: they stay put until the next gathering.
    const d = this.dummy;
    let p = 0, g = 0;
    for (const i of this.near) {
      const k = KINDS[this.kind[i]], lx = this.xy[i * 2], ly = this.xy[i * 2 + 1];
      if (!k.head) continue;
      const z = this.height(lx, ly);
      if (k.pole && p < MAX_POLES) {
        d.position.set(lx, z, -ly);
        d.scale.set(1, k.head, 1);
        d.updateMatrix();
        this.poles.setMatrixAt(p++, d.matrix);
      }
      if (k.glow && g < this.glows.instanceMatrix.count) {
        d.position.set(lx, z + k.head, -ly);
        d.scale.set(1.6, 1, 1.6);
        d.updateMatrix();
        this.glows.setMatrixAt(g, d.matrix);
        this.glows.setColorAt(g++, this.c.copy(colourOf(this.kind[i], i)).multiplyScalar(k.glow * 2));
      }
    }
    this.poles.count = p;
    this.poles.instanceMatrix.needsUpdate = true;
    this.heads = g;
    this.glows.instanceMatrix.needsUpdate = true;
    if (this.glows.instanceColor) this.glows.instanceColor.needsUpdate = true;
  }
  private heads = 0;

  // Once a frame before the scene is drawn. `on`: how dark it is (Sky.dark); `cars`:
  // the cars in view, lit when they're driving; `carHeight(x, y, car)` the ground
  // under them; `trams`, the ones drawn (with a look) light the street round them.
  update<C extends LitCar>(x: number, y: number, r: number, on: number, cars: C[], carHeight: (x: number, y: number, car: C) => number, now: number, trams: LitTram[] = []) {
    LAMP_ON.value = on;
    this.gather(x, y, r, now);
    // By day nothing glows or lights the street: only the poles (gathered above) show.
    if (on <= 0.005) {
      this.glows.count = 0;
      this.lights.instanceCount = 0;
      return;
    }
    // The cars' own lights glow too (after the lamps' heads in the same instances).
    let g = this.heads, n = 0;
    const at = this.at.array as Float32Array, sh = this.shape.array as Float32Array, col = this.colour.array as Float32Array;
    const add = (lx: number, ly: number, z: number, beam: number, dx: number, dy: number, len: number, wid: number, c: THREE.Color, i: number) => {
      if (n >= MAX_LIGHTS) return;
      at.set([lx, -ly, z, beam], n * 4);
      sh.set([dx, -dy, len, wid], n * 4);
      col.set([c.r * i, c.g * i, c.b * i], n * 3);
      n++;
    };
    for (const i of this.near) {
      const k = KINDS[this.kind[i]], lx = this.xy[i * 2], ly = this.xy[i * 2 + 1];
      if (Math.abs(lx - x) > r + k.r || Math.abs(ly - y) > r + k.r) continue;
      add(lx, ly, this.height(lx, ly) + k.raise, 0, 1, 0, k.r, k.r, colourOf(this.kind[i], i), k.i);
    }
    const d = this.dummy;
    for (const c of cars) {
      if (c.mode === 'loose' && c.speed < 0.5) continue; // parked: lights off
      const fx = Math.cos(c.h), fy = Math.sin(c.h), L = c.spec.L / 2, W = c.spec.W / 2;
      const z = carHeight(c.x, c.y, c);
      add(c.x + fx * L, c.y + fy * L, z, 1, fx, fy, c.two ? 16 : 24, c.two ? 3 : 5, HEAD, c.two ? 1.2 : 2.2);
      add(c.x - fx * L, c.y - fy * L, z, 0, 1, 0, 2.4, 2.4, TAIL, 0.5);
      // Two headlights and two rear lights (one each on a bike).
      for (const [along, colour, size] of [[L - 0.05, HEAD, 0.9], [-L + 0.05, TAIL, 0.6]] as [number, THREE.Color, number][]) {
        for (const s of c.two ? [0] : [-1, 1]) {
          if (g >= this.glows.instanceMatrix.count) break;
          const across = s * (W - 0.3);
          d.position.set(c.x + fx * along - fy * across, z + 0.75, -(c.y + fy * along + fx * across));
          d.scale.set(size, 1, size);
          d.updateMatrix();
          this.glows.setMatrixAt(g, d.matrix);
          this.glows.setColorAt(g++, this.c.copy(colour).multiplyScalar(0.8));
        }
      }
    }
    for (const v of trams) {
      if (!v.look || !v.parts.length) continue;
      v.parts.forEach((p, i) => {
        if (Math.abs(p.x - x) > r + 30 || Math.abs(p.y - y) > r + 30) return;
        add(p.x, p.y, v.levels?.[i]?.gz ?? this.height(p.x, p.y), 0, 1, 0, 6, 6, CABIN, 0.3);
      });
      const f = v.parts[v.parts.length - 1], b = v.parts[0], half = TRAM_SECTION / 2;
      const fx = Math.cos(f.ang), fy = Math.sin(f.ang), bx = Math.cos(b.ang), by = Math.sin(b.ang);
      const z = v.levels?.[v.parts.length - 1]?.gz ?? this.height(f.x, f.y);
      add(f.x + fx * half, f.y + fy * half, z, 1, fx, fy, 28, 5, HEAD, 1.8);
      add(b.x - bx * half, b.y - by * half, v.levels?.[0]?.gz ?? this.height(b.x, b.y), 0, 1, 0, 2.6, 2.6, TAIL, 0.5);
      for (const s of [-1, 1]) {
        if (g >= this.glows.instanceMatrix.count) break;
        d.position.set(f.x + fx * (half + 0.1) - fy * s * 0.9, z + 0.9, -(f.y + fy * (half + 0.1) + fx * s * 0.9));
        d.scale.set(1, 1, 1);
        d.updateMatrix();
        this.glows.setMatrixAt(g, d.matrix);
        this.glows.setColorAt(g++, this.c.copy(HEAD).multiplyScalar(0.8));
      }
    }
    this.glows.count = g;
    this.glows.instanceMatrix.needsUpdate = true;
    if (this.glows.instanceColor) this.glows.instanceColor.needsUpdate = true;
    this.lights.instanceCount = n;
    if (!n) return;
    this.at.needsUpdate = this.shape.needsUpdate = this.colour.needsUpdate = true;

    // The light map: a square over the view, its centre on a texel so the pools don't shimmer.
    const half = r + 20, texel = (2 * half) / MAP_SIZE;
    const cx = Math.round(x / texel) * texel, cz = Math.round(-y / texel) * texel;
    this.view.value.set(cx, cz, 1 / half, 0);
    LAMP_BOX.value.set(cx, cz, 1 / half, 0);
    const renderer = this.renderer, before = renderer.getRenderTarget(), clear = renderer.getClearColor(this.c).getHex(), alpha = renderer.getClearAlpha();
    const shadows = renderer.shadowMap.autoUpdate;
    renderer.shadowMap.autoUpdate = false;
    renderer.setRenderTarget(this.target);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, false, false);
    renderer.render(this.lightScene, this.lightCam);
    renderer.setRenderTarget(before);
    renderer.setClearColor(clear, alpha);
    renderer.shadowMap.autoUpdate = shadows;
  }
}
