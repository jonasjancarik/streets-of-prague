import * as THREE from 'three';
import { fetchBinary } from './terrain.ts';
import { armLamp, gasPair, gasSingle, wallLantern, globeLamp, hungLamp } from './lampmodels.ts';

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
// How the cars treat the lamps' light: 0 not at all, 1 a soft darkening round each car
// (cheap), 2 they block it, casting shadows away from every lamp and headlight.
export const LAMP_SHADOWS = { value: 0 };

export const LAMP_GLSL = /* glsl */ `
uniform sampler2D uLampMap; uniform vec4 uLampBox; uniform float uLampOn;
// The lamps' light at a point in the world (0 by day and off the map).
vec3 lampLight(vec3 w) {
  if (uLampOn < .005) return vec3(0.);
  vec2 uv = (w.xz - uLampBox.xy) * uLampBox.z * .5 + .5;
  if (uv.x < 0. || uv.y < 0. || uv.x > 1. || uv.y > 1.) return vec3(0.);
  vec4 l = texture2D(uLampMap, uv);
  float dy = w.y - (l.a - 500.);
  // Not far below the lamp either: the street under a bridge isn't lit from the deck.
  return l.rgb * uLampOn * (1. - smoothstep(3., 11., dy)) * smoothstep(-5., -2.5, dy);
}
// The same for something with a surface: what faces up and is well above the lamp
// (a bridge deck over the street, whose cars' lights would otherwise show through it)
// gets none.
vec3 lampLightOn(vec3 w, vec3 n) {
  float up = smoothstep(.5, .8, dot(n, viewMatrix[1].xyz));
  vec3 l = lampLight(w);
  if (up < .01 || l.r + l.g + l.b <= 0.) return l;
  vec4 m = texture2D(uLampMap, (w.xz - uLampBox.xy) * uLampBox.z * .5 + .5);
  return l * (1. - up * smoothstep(3.5, 5.5, w.y - (m.a - 500.)));
}
`;

type Shader = THREE.WebGLProgramParametersWithUniforms;

// The WebGPU trial's own version of the pools (webgpu/lamps.ts), set before the lamps are made.
let poolsBy: ((view: { value: THREE.Vector4 }, cars: THREE.Texture) => THREE.Material) | null = null;
export const setPools = (f: typeof poolsBy) => { poolsBy = f; };
// And of the heads' glows (webgpu/glows.ts).
let glowsBy: (() => THREE.Material) | null = null;
export const setGlows = (f: typeof glowsBy) => { glowsBy = f; };

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
    .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>\n  reflectedLight.directDiffuse += diffuseColor.rgb * lampLightOn(${w}, normal);`);
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
  { head: 6.3, pole: false, r: 14, i: 0.9, raise: 0, glow: 0.5 }, // added: hung over a street on cables (see fill)
];
const HUNG = 7;
// The models (lampmodels.ts) and where their lights are (x along the arm, y, z across it).
// A kind's lamps take one by hash: the Old Town has big two-lantern gas posts and small
// single lanterns both.
const MODELS = [
  { make: () => armLamp(7.5), glows: [[1.68, 7.62, 0]] },
  { make: gasPair, glows: [[0, 3.7, 0.6], [0, 3.7, -0.6]] },
  { make: gasSingle, glows: [[0, 3.5, 0]] },
  { make: wallLantern, glows: [[0.55, 4.7, 0]] },
  { make: () => globeLamp(5.5), glows: [[0, 5.5, 0]] },
  { make: () => hungLamp(6.3), glows: [[0, 6.25, 0]] },
];
const modelOf = (kind: number, i: number) => kind === 0 ? 0 : kind === 2 ? (hash(i + 7) < 0.5 ? 1 : 2) : kind === 1 ? 3 : kind === 3 ? 4 : kind === HUNG ? 5 : -1;
// Streets to turn lamps towards: their segments in a grid (x0, y0, x1, y1 each).
const STREET_CELL = 50, REACH_ARM = 30;
// Many side streets' lamps hang on cables between the houses or sit on their walls,
// and the utility map has few of those: a street with no lamp within REACH gets one
// hung over it every SPACING metres, but only where a building stands on each side
// within WALL of it to take the cables (elsewhere a lamp would hang from nothing).
const SPACING = 30, REACH = 20, WALL = 18;
const ANCHOR = 7.4, SLACK = 0.3; // m: where a cable meets a wall above the street, how much it sags
const MAX_HUNG = 800, HALVES = 5; // (cable pieces from a wall to the lamp)
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

interface Seg { ax: number; ay: number; bx: number; by: number }
// Where the ray from (px, py) along (dx, dy) first crosses one of the segments, as the
// distance along it (Infinity if none within max).
function cast(segs: Seg[], px: number, py: number, dx: number, dy: number, max: number) {
  let best = Infinity;
  for (const s of segs) {
    const ex = s.bx - s.ax, ey = s.by - s.ay, den = dx * ey - dy * ex;
    if (Math.abs(den) < 1e-9) continue;
    const qx = s.ax - px, qy = s.ay - py;
    const t = (qx * ey - qy * ex) / den, u = (qx * dy - qy * dx) / den;
    if (t > 0 && t < max && t < best && u >= 0 && u <= 1) best = t;
  }
  return best;
}

interface Street { hw: string; pts: [number, number][]; tunnel?: boolean }
interface LitTram { parts: { x: number; y: number; ang: number }[]; look: unknown; levels?: { gz?: number }[] }
interface LitCar { x: number; y: number; h: number; spec: { L: number; W: number; H: number }; mode: string; two?: string; speed: number }

// The cars that get in the lamps' way: a texel each, two rows in a float texture
// (x, z, forward x, forward z / half length, half width, top, ground), and for every
// light the few nearest ones (never the car the light is on).
const MAX_CARS = 256;
const CAR_CELL = 12;
const NEAR_CARS = 8;

export class Lamps {
  private xy: number[] = [];
  private kind: number[] = [];
  private loaded = false;
  private waiting: [Street[], [number, number][][]][] = [];
  private hung = new Map<number, number[]>(); // a hung lamp → the two wall points its cables run to (x, y, x, y)
  private cables: THREE.LineSegments;
  private grid = new Map<number, number[]>();
  private renderer: THREE.WebGLRenderer;
  private height: (x: number, y: number) => number;
  private target: THREE.WebGLRenderTarget;
  private lightScene = new THREE.Scene();
  private lightCam = new THREE.Camera();
  private lights: THREE.InstancedBufferGeometry;
  private carData = new Float32Array(MAX_CARS * 8);
  private carMap = new THREE.DataTexture(this.carData, MAX_CARS, 2, THREE.RGBAFormat, THREE.FloatType);
  private carGrid = new Map<number, number[]>();
  private carZ: number[] = [];
  private cars: LitCar[] = [];
  private pickIds = new Float32Array(NEAR_CARS);
  private pickD = new Float32Array(NEAR_CARS);
  private lift: THREE.InstancedBufferAttribute; // height of the light over the ground
  private carsA: THREE.InstancedBufferAttribute; // the cars near it (indices, -1 for none)
  private carsB: THREE.InstancedBufferAttribute;
  private at: THREE.InstancedBufferAttribute; // x, z, ground height, 0 round / 1 beam
  private shape: THREE.InstancedBufferAttribute; // direction x, z, length (or radius), width
  private colour: THREE.InstancedBufferAttribute;
  private view = { value: new THREE.Vector4() };
  private models: THREE.InstancedMesh[] = [];
  private streets = new Map<number, number[]>();
  private facing = new Map<number, number>(); // a lamp → the way (radians) its arm points
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
    this.lift = new THREE.InstancedBufferAttribute(new Float32Array(MAX_LIGHTS), 1).setUsage(THREE.DynamicDrawUsage);
    this.carsA = new THREE.InstancedBufferAttribute(new Float32Array(MAX_LIGHTS * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.carsB = new THREE.InstancedBufferAttribute(new Float32Array(MAX_LIGHTS * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.carMap.minFilter = this.carMap.magFilter = THREE.NearestFilter;
    quad.setAttribute('iLift', this.lift);
    quad.setAttribute('iCarsA', this.carsA);
    quad.setAttribute('iCarsB', this.carsB);
    quad.setAttribute('iAt', this.at);
    quad.setAttribute('iShape', this.shape);
    quad.setAttribute('iColour', this.colour);
    quad.instanceCount = 0;
    this.lights = quad;
    const pools = new THREE.Mesh(quad, poolsBy ? poolsBy(this.view, this.carMap) : new THREE.ShaderMaterial({
      uniforms: { uView: this.view, uCars: { value: this.carMap }, uShadow: LAMP_SHADOWS },
      vertexShader: /* glsl */ `
        attribute vec4 iAt; attribute vec4 iShape; attribute vec3 iColour;
        attribute float iLift; attribute vec4 iCarsA; attribute vec4 iCarsB;
        uniform vec4 uView;
        varying vec2 vL; varying vec3 vC; varying float vH; varying float vBeam;
        varying vec2 vP; varying vec3 vLamp; varying vec4 vCa; varying vec4 vCb;
        void main() {
          vec2 dir = iShape.xy, side = vec2(-dir.y, dir.x), q = position.xy, off;
          if (iAt.w > .5) { vL = vec2(q.x * .5 + .5, q.y); off = dir * vL.x * iShape.z + side * q.y * iShape.w; }
          else { vL = q; off = (dir * q.x + side * q.y) * iShape.z; }
          vC = iColour; vH = iAt.z; vBeam = iAt.w;
          vP = iAt.xy + off; vLamp = vec3(iAt.x, iAt.z + iLift, iAt.y); vCa = iCarsA; vCb = iCarsB;
          gl_Position = vec4((iAt.xy + off - uView.xy) * uView.z, 0., 1.);
        }`,
      fragmentShader: /* glsl */ `
        varying vec2 vL; varying vec3 vC; varying float vH; varying float vBeam;
        varying vec2 vP; varying vec3 vLamp; varying vec4 vCa; varying vec4 vCb;
        uniform sampler2D uCars; uniform float uShadow;
        // How much car i keeps the light from the ground point p (0..1): the ray from the
        // lamp to the point through the car's box, its depth softening the edge; or, for the
        // cheap version, closeness to the car's outline.
        float cover(float id, vec2 p) {
          if (id < -.5) return 0.;
          int i = int(id + .5);
          vec4 a = texelFetch(uCars, ivec2(i, 0), 0), b = texelFetch(uCars, ivec2(i, 1), 0);
          vec2 sd = vec2(-a.w, a.z);
          if (uShadow < 1.5) {
            vec2 o = p - a.xy, l = vec2(dot(o, a.zw), dot(o, sd));
            float d = length(max(abs(l) - b.xy, 0.));
            return .55 * (1. - smoothstep(0., 1.2, d)) * (1. - smoothstep(1.5, 3., abs(vH - b.w)));
          }
          vec2 o = vLamp.xz - a.xy, e = p - a.xy;
          vec3 O = vec3(dot(o, a.zw), vLamp.y - b.w, dot(o, sd));
          vec3 D = vec3(dot(e, a.zw), vH - b.w, dot(e, sd)) - O;
          D += vec3(1e-4) * (step(0., D) * 2. - 1.);
          vec3 t1 = (vec3(-b.x, .12, -b.y) - O) / D, t2 = (vec3(b.x, b.z - b.w, b.y) - O) / D;
          vec3 tn = min(t1, t2), tf = max(t1, t2);
          float t0 = max(max(max(tn.x, tn.y), tn.z), 0.), t3 = min(min(min(tf.x, tf.y), tf.z), 1.);
          return .92 * smoothstep(0., .35, (t3 - t0) * length(D));
        }
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
          if (uShadow > .5 && vCa.x > -.5) {
            float c = 0.;
            for (int k = 0; k < 4; k++) c = max(c, max(cover(vCa[k], vP), cover(vCb[k], vP)));
            f *= 1. - c;
          }
          gl_FragColor = vec4(vC * f, vH + 500.);
        }`,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
      blendEquationAlpha: THREE.MaxEquation, depthTest: false, depthWrite: false,
    }));
    pools.frustumCulled = false;
    this.lightScene.add(pools);

    // Poles with a head, and the heads' glow at night.
    const poleMaterial = new THREE.MeshLambertMaterial({ vertexColors: true });
    poleMaterial.onBeforeCompile = (sh) => lampLit(sh);
    poleMaterial.customProgramCacheKey = () => 'lamp-pole';
    this.models = MODELS.map((m) => {
      const mesh = new THREE.InstancedMesh(m.make(), poleMaterial, MAX_POLES);
      mesh.count = 0;
      mesh.frustumCulled = false;
      return mesh;
    });
    const glow = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    this.glows = new THREE.InstancedMesh(glow, glowsBy ? glowsBy() : new THREE.ShaderMaterial({
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
    // The cables of the hung lamps near the camera: HALVES lines a side, two sides each.
    const cableGeometry = new THREE.BufferGeometry();
    cableGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_HUNG * 2 * HALVES * 2 * 3), 3));
    cableGeometry.setDrawRange(0, 0);
    this.cables = new THREE.LineSegments(cableGeometry, new THREE.LineBasicMaterial({ color: '#1d1f20', transparent: true, opacity: 0.85 }));
    this.cables.frustumCulled = false;
    scene.add(...this.models, this.glows, this.cables);

    void fetchBinary(`data/${area}_now/lamps.bin.gz`, true).then((buf) => {
      if (!buf) return;
      const n = new DataView(buf).getUint32(0, true);
      const xy = new Float32Array(buf.slice(4, 4 + n * 8)), kind = new Uint8Array(buf, 4 + n * 8, n);
      for (let i = 0; i < n; i++) this.add(xy[i * 2], xy[i * 2 + 1], kind[i]);
    }).catch(() => {}).finally(() => {
      this.loaded = true;
      for (const [edges, walls] of this.waiting) this.fill(edges, walls);
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

  // Streets as their tiles load: lamps hung over the unlit stretches, on cables to the
  // buildings either side (`buildings`: their outlines; a stretch with none is left dark).
  fill(edges: Street[], buildings: [number, number][][]) {
    if (!this.loaded) { this.waiting.push([edges, buildings]); return; }
    const cells = new Map<number, Seg[]>();
    for (const ring of buildings) {
      for (let i = 0; i < ring.length; i++) {
        const [ax, ay] = ring[i], [bx, by] = ring[(i + 1) % ring.length];
        const s = { ax, ay, bx, by };
        for (let cx = Math.floor(Math.min(ax, bx) / CELL); cx <= Math.floor(Math.max(ax, bx) / CELL); cx++) {
          for (let cy = Math.floor(Math.min(ay, by) / CELL); cy <= Math.floor(Math.max(ay, by) / CELL); cy++) {
            const k = this.key(cx * CELL, cy * CELL);
            const list = cells.get(k);
            if (list) list.push(s); else cells.set(k, [s]);
          }
        }
      }
    }
    const near = (x: number, y: number) => {
      const out = new Set<Seg>();
      for (let cx = Math.floor((x - WALL) / CELL); cx <= Math.floor((x + WALL) / CELL); cx++) {
        for (let cy = Math.floor((y - WALL) / CELL); cy <= Math.floor((y + WALL) / CELL); cy++) {
          for (const s of cells.get(this.key(cx * CELL, cy * CELL)) ?? []) out.add(s);
        }
      }
      return [...out];
    };
    for (const e of edges) {
      if (e.tunnel) continue;
      for (let i = 1; i < e.pts.length; i++) {
        const [ax, ay] = e.pts[i - 1], [bx, by] = e.pts[i];
        for (let cx = Math.floor((Math.min(ax, bx) - REACH_ARM) / STREET_CELL); cx <= Math.floor((Math.max(ax, bx) + REACH_ARM) / STREET_CELL); cx++) {
          for (let cy = Math.floor((Math.min(ay, by) - REACH_ARM) / STREET_CELL); cy <= Math.floor((Math.max(ay, by) + REACH_ARM) / STREET_CELL); cy++) {
            const k = (cx + 4096) * 8192 + cy + 4096;
            const list = this.streets.get(k);
            if (list) list.push(ax, ay, bx, by); else this.streets.set(k, [ax, ay, bx, by]);
          }
        }
      }
    }
    for (const e of edges) {
      if (e.tunnel || UNLIT.has(e.hw)) continue;
      let next = SPACING / 2;
      for (let i = 1, s = 0; i < e.pts.length; i++) {
        const [ax, ay] = e.pts[i - 1], [bx, by] = e.pts[i], len = Math.hypot(bx - ax, by - ay);
        for (; next <= s + len; next += SPACING) {
          const t = (next - s) / len, x = ax + (bx - ax) * t, y = ay + (by - ay) * t;
          if (this.lampWithin(x, y, REACH)) continue;
          // Across the street, to the first wall each way.
          const nx = -(by - ay) / len, ny = (bx - ax) / len, walls = near(x, y);
          const l = cast(walls, x, y, nx, ny, WALL), r = cast(walls, x, y, -nx, -ny, WALL);
          if (!Number.isFinite(l) || !Number.isFinite(r)) continue;
          this.hung.set(this.kind.length, [x + nx * l, y + ny * l, x - nx * r, y - ny * r]);
          this.add(x, y, HUNG);
        }
        s += len;
      }
    }
    this.nearAt.x = Infinity;
  }

  // The way from a lamp to the nearest street within reach (radians, the map's x and y),
  // once a street is known; until then whichever way.
  private face(i: number, x: number, y: number) {
    const known = this.facing.get(i);
    if (known !== undefined) return known;
    const list = this.streets.get((Math.floor(x / STREET_CELL) + 4096) * 8192 + Math.floor(y / STREET_CELL) + 4096);
    let best = REACH_ARM, ang: number | undefined;
    if (list) {
      for (let j = 0; j < list.length; j += 4) {
        const ax = list[j], ay = list[j + 1], ex = list[j + 2] - ax, ey = list[j + 3] - ay;
        const t = Math.max(0, Math.min(1, ((x - ax) * ex + (y - ay) * ey) / (ex * ex + ey * ey || 1)));
        const dx = ax + ex * t - x, dy = ay + ey * t - y, d = Math.hypot(dx, dy);
        if (d < best) { best = d; ang = Math.atan2(dy, dx); }
      }
    }
    if (ang === undefined) return hash(i) * Math.PI * 2;
    this.facing.set(i, ang);
    return ang;
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
    const used = this.models.map(() => 0);
    let g = 0, c = 0;
    const cable = this.cables.geometry.getAttribute('position') as THREE.BufferAttribute;
    for (const i of this.near) {
      const k = KINDS[this.kind[i]], lx = this.xy[i * 2], ly = this.xy[i * 2 + 1];
      if (!k.head) continue;
      const z = this.height(lx, ly);
      const walls = this.hung.get(i);
      if (walls && c < MAX_HUNG * 2 * HALVES) {
        // From each wall down to the lamp, sagging a little between.
        for (let w = 0; w < 2; w++) {
          const wx = walls[w * 2], wy = walls[w * 2 + 1];
          const at = (u: number): [number, number, number] => [wx + (lx - wx) * u, z + ANCHOR + (k.head + 0.1 - ANCHOR) * u - SLACK * 4 * u * (1 - u), -(wy + (ly - wy) * u)];
          for (let h = 0; h < HALVES; h++) {
            const a = at(h / HALVES), b = at((h + 1) / HALVES);
            cable.setXYZ(c * 2, a[0], a[1], a[2]);
            cable.setXYZ(c * 2 + 1, b[0], b[1], b[2]);
            c++;
          }
        }
      }
      const m = modelOf(this.kind[i], i);
      if (m >= 0 && used[m] < MAX_POLES) {
        const ang = this.face(i, lx, ly), co = Math.cos(ang), si = Math.sin(ang);
        d.position.set(lx, z, -ly);
        d.rotation.set(0, ang, 0);
        d.scale.set(1, 1, 1);
        d.updateMatrix();
        this.models[m].setMatrixAt(used[m]++, d.matrix);
        d.rotation.set(0, 0, 0);
        for (const [gx, gy, gz] of MODELS[m].glows) {
          if (g >= this.glows.instanceMatrix.count) break;
          // (a local x along the arm is (cos, -sin) in world x, z; z across it, (sin, cos).)
          d.position.set(lx + gx * co + gz * si, z + gy, -ly - gx * si + gz * co);
          d.scale.set(1.6, 1, 1.6);
          d.updateMatrix();
          this.glows.setMatrixAt(g, d.matrix);
          this.glows.setColorAt(g++, this.c.copy(colourOf(this.kind[i], i)).multiplyScalar(k.glow * 2));
        }
      } else if (k.glow && g < this.glows.instanceMatrix.count) {
        d.position.set(lx, z + k.head, -ly);
        d.scale.set(1.6, 1, 1.6);
        d.updateMatrix();
        this.glows.setMatrixAt(g, d.matrix);
        this.glows.setColorAt(g++, this.c.copy(colourOf(this.kind[i], i)).multiplyScalar(k.glow * 2));
      }
    }
    this.models.forEach((mesh, m) => { mesh.count = used[m]; mesh.instanceMatrix.needsUpdate = true; });
    cable.needsUpdate = true;
    this.cables.geometry.setDrawRange(0, c * 2);
    this.heads = g;
    this.glows.instanceMatrix.needsUpdate = true;
    if (this.glows.instanceColor) this.glows.instanceColor.needsUpdate = true;
  }
  private heads = 0;

  // The cars into the texture the pools read, and a grid to find the near ones by.
  private stand(cars: LitCar[], carHeight: (x: number, y: number, car: never) => number, on: boolean) {
    this.cars = cars;
    this.carGrid.clear();
    const data = this.carData;
    for (let i = 0; i < cars.length; i++) {
      const c = cars[i], z = carHeight(c.x, c.y, c as never);
      this.carZ[i] = z;
      if (!on || i >= MAX_CARS) continue;
      data.set([c.x, -c.y, Math.cos(c.h), -Math.sin(c.h)], i * 4);
      data.set([c.spec.L / 2, c.spec.W / 2, z + c.spec.H, z], MAX_CARS * 4 + i * 4);
      const k = Math.floor(c.x / CAR_CELL) * 4096 + Math.floor(c.y / CAR_CELL);
      const list = this.carGrid.get(k);
      if (list) list.push(i); else this.carGrid.set(k, [i]);
    }
    if (on) this.carMap.needsUpdate = true;
  }

  // The NEAR_CARS nearest cars within reach of a spot, closest first, into pickIds.
  private pick(x: number, y: number, reach: number, skip: number) {
    const ids = this.pickIds, ds = this.pickD;
    ids.fill(-1);
    const R = reach + 3;
    for (let cx = Math.floor((x - R) / CAR_CELL); cx <= Math.floor((x + R) / CAR_CELL); cx++) {
      for (let cy = Math.floor((y - R) / CAR_CELL); cy <= Math.floor((y + R) / CAR_CELL); cy++) {
        const list = this.carGrid.get(cx * 4096 + cy);
        if (!list) continue;
        for (const i of list) {
          if (i === skip) continue;
          const c = this.cars[i], d = Math.hypot(c.x - x, c.y - y);
          if (d > reach + c.spec.L / 2) continue;
          let k = NEAR_CARS - 1;
          if (ids[k] >= 0 && ds[k] <= d) continue;
          for (; k > 0 && (ids[k - 1] < 0 || ds[k - 1] > d); k--) { ids[k] = ids[k - 1]; ds[k] = ds[k - 1]; }
          ids[k] = i;
          ds[k] = d;
        }
      }
    }
  }

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
    const shading = LAMP_SHADOWS.value > 0;
    this.stand(cars, carHeight, shading);
    const ca = this.carsA.array as Float32Array, cb = this.carsB.array as Float32Array, lift = this.lift.array as Float32Array;
    // `up`: how high the light is over the ground; `own`: the car it is on, which it doesn't
    // shine through; `lit` false for the lights the cars don't get in the way of.
    const add = (lx: number, ly: number, z: number, beam: number, dx: number, dy: number, len: number, wid: number, c: THREE.Color, i: number, up = 0, own = -1) => {
      if (n >= MAX_LIGHTS) return;
      at.set([lx, -ly, z, beam], n * 4);
      sh.set([dx, -dy, len, wid], n * 4);
      col.set([c.r * i, c.g * i, c.b * i], n * 3);
      lift[n] = up;
      const ids = this.pickIds;
      if (shading && up > 0) {
        if (beam) this.pick(lx + dx * len / 2, ly + dy * len / 2, len / 2 + wid, own);
        else this.pick(lx, ly, len, own);
      } else ids.fill(-1);
      for (let k = 0; k < 4; k++) { ca[n * 4 + k] = ids[k]; cb[n * 4 + k] = ids[4 + k]; }
      n++;
    };
    for (const i of this.near) {
      const k = KINDS[this.kind[i]], lx = this.xy[i * 2], ly = this.xy[i * 2 + 1];
      if (Math.abs(lx - x) > r + k.r || Math.abs(ly - y) > r + k.r) continue;
      // (Only the lamps up on poles and walls: not the floodlights or those in tunnels.)
      add(lx, ly, this.height(lx, ly) + k.raise, 0, 1, 0, k.r, k.r, colourOf(this.kind[i], i), k.i, k.raise || k.head < 3 ? 0 : k.head);
    }
    const d = this.dummy;
    cars.forEach((c, ci) => {
      if (c.mode === 'loose' && c.speed < 0.5) return; // parked: lights off
      const fx = Math.cos(c.h), fy = Math.sin(c.h), L = c.spec.L / 2, W = c.spec.W / 2;
      const z = this.carZ[ci];
      add(c.x + fx * L, c.y + fy * L, z, 1, fx, fy, c.two ? 16 : 24, c.two ? 3 : 5, HEAD, c.two ? 1.2 : 2.2, 0.75, ci);
      add(c.x - fx * L, c.y - fy * L, z, 0, 1, 0, 2.4, 2.4, TAIL, 0.5, 0.75, ci);
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
    });
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
    this.lift.needsUpdate = this.carsA.needsUpdate = this.carsB.needsUpdate = true;

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
