import { dataUrl } from './data.ts';
import * as THREE from 'three';
import { fetchBinary } from './terrain.ts';
import { CLOUD, CLOUD_MAP, CLOUD_GLSL } from './clouds.ts';
import { posts, fall, type Post } from './posts.ts';
import { armLamp, gasPair, gasSingle, wallLantern, globeLamp, hungLamp } from './lampmodels.ts';
import { send, sendInstances } from './gpu.ts';
import { LightFx } from './lightfx.ts';

// Street lighting at night. The lamps come from IPR's utility map
// (pipeline/build_lamps.py, data/<area>_now/lamps.bin.gz); round the camera they get
// a pole and a glowing head. What they light is drawn into a light map: a square
// texture over the view, seen from above, into which every lamp, and every car's
// headlights, adds a pool of light. Materials read it by their position (LAMP_GLSL,
// lampLit), so lighting costs one texture read a pixel however many lamps there are.
// Its alpha holds the height of the ground the light falls on (each light's, weighted by
// its brightness: divide by the brightness to get the height), so the light stays on the
// ground and the lower walls and doesn't reach the roofs above. Everything is added up,
// so both the light and the height blend smoothly from texel to texel.
// There are two such maps: the second takes the lights up on a bridge, well above the
// ground under it, so a deck and the street or the island below each keep their own.

export const LAMP_MAP: { value: THREE.Texture | null } = { value: null };
export const LAMP_MAP_HIGH: { value: THREE.Texture | null } = { value: null };
// (x, z of the map's centre, 1 / its half width, 1 / its half depth)
export const LAMP_BOX = { value: new THREE.Vector4(0, 0, 1, 1) };
// (the height the map's heights are measured from, 1 when the second map has lights in it,
// the softest a shadow's edge may be (m): a texel and a half, 0)
export const LAMP_REF = { value: new THREE.Vector4(0, 0, 0.3, 0) };
// How much the lamps are on: 0 by day, 1 at night.
export const LAMP_ON = { value: 0 };
// What gets in the way of the lamps' light: 0 nothing, 1 a soft darkening round each car
// (cheap), 2 the cars block it, casting shadows away from every lamp and headlight,
// 3 people, trams and posts do too.
export const LAMP_SHADOWS = { value: 0 };
// Texels across the light map (graphics.ts).
export const LAMP_SIZE = { value: 1024 };
// The lights' beams in the air and their glints on cars and wet ground (lightfx.ts): 0 or 1.
export const LIGHT_FX = { value: 0 };

export const LAMP_GLSL = /* glsl */ `
uniform sampler2D uLampMap; uniform vec4 uLampBox; uniform vec4 uLampRef; uniform float uLampOn;
// The lamps' light at a point in the world (0 by day and off the map). With a surface
// (n): what faces up and is well above the lamp (a bridge deck over the street, whose
// cars' lights would otherwise show through it) gets none.
vec3 lampLightOn(vec3 w, vec3 n) {
  if (uLampOn < .005) return vec3(0.);
  vec2 uv = (w.xz - uLampBox.xy) * uLampBox.zw * .5 + .5;
  if (uv.x < 0. || uv.y < 0. || uv.x > 1. || uv.y > 1.) return vec3(0.);
  vec4 l = texture2D(uLampMap, uv);
  float dy = w.y - (l.a / max(dot(l.rgb, vec3(.3, .59, .11)), 1e-4) + uLampRef.x);
  float up = smoothstep(.5, .8, dot(n, viewMatrix[1].xyz));
  // Not far below the lamp either: the street under a bridge isn't lit from the deck.
  return l.rgb * uLampOn * (1. - smoothstep(3., 11., dy)) * smoothstep(-5., -2.5, dy) * (1. - up * smoothstep(3.5, 5.5, dy));
}
vec3 lampLight(vec3 w) { return lampLightOn(w, vec3(0.)); }
`;

type Shader = THREE.WebGLProgramParametersWithUniforms;

// The WebGPU trial's own version of the pools (webgpu/lamps.ts), set before the lamps are made.
let poolsBy: ((view: { value: THREE.Vector4 }, cars: THREE.Texture, layer: number) => THREE.Material) | null = null;
export const setPools = (f: typeof poolsBy) => { poolsBy = f; };
// And of the heads' glows (webgpu/glows.ts).
let glowsBy: (() => THREE.Material) | null = null;
export const setGlows = (f: typeof glowsBy) => { glowsBy = f; };

// Lamp light on a Lambert material, inside its onBeforeCompile (after the other
// replacements). `world`: a varying with the world position the shader already has.
const CLOUDS = !location.search.includes('nocloud');

export function lampLit(sh: Shader, world?: string) {
  sh.uniforms.uLampMap = LAMP_MAP;
  sh.uniforms.uLampBox = LAMP_BOX;
  sh.uniforms.uLampRef = LAMP_REF;
  sh.uniforms.uLampOn = LAMP_ON;
  sh.uniforms.uCloudMap = CLOUD_MAP;
  sh.uniforms.uCloud = CLOUD;
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
    .replace('#include <common>', `#include <common>\n${LAMP_GLSL}\n${CLOUD_GLSL}`)
    // Only the sun is in directDiffuse at this point: the clouds dim it before the lamps' light is added.
    .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>\n${CLOUDS ? `  reflectedLight.directDiffuse *= cloudLit(${w});\n` : ''}  reflectedLight.directDiffuse += diffuseColor.rgb * lampLightOn(${w}, normal);`);
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
const HUNG = 7, ON_BRIDGE = 3;
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
const BEACON = new THREE.Color(0.12, 0.38, 1);
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

interface Street { hw: string; pts: [number, number][]; tunnel?: boolean; bridge?: boolean }
interface LitTram { parts: { x: number; y: number; ang: number }[]; look: unknown; levels?: { gz?: number }[] }
export interface LitCar { x: number; y: number; h: number; spec: { L: number; W: number; H: number }; mode: string; two?: string; speed: number }

// What gets in the lamps' way, as boxes: the cars, and with LAMP_SHADOWS at 3 the people,
// the trams' sections and the posts. A texel each, two rows in a float
// texture (x, z, forward x, forward z / half length, half width, top, ground), and for
// every light the few nearest ones (never the car the light is on).
const MAX_CARS = 1024;
const CAR_CELL = 12;
const NEAR_CARS = 12; // (8 of them used below LAMP_SHADOWS 3)
// Above this over the ground under it, a light is on a bridge: it goes in the second map.
const DECK = 4;
const LUMA = [0.3, 0.59, 0.11];

// Something standing in the light: where, which way it faces (radians), half its length
// and width, the ground under it and how tall it is.
export type Block = (x: number, y: number, h: number, halfL: number, halfW: number, ground: number, tall: number) => void;
// The flashing lights on the roof of an emergency vehicle: their light reaches `reach` m, `rate` cycles a second.
export interface Flashing { car: LitCar; reach: number; rate: number }
// How lit each side of a light bar is at `time` (0..1 each), `rate` cycles a second: two
// short flashes on the left, then two on the right.
export function strobe(time: number, rate: number): [number, number] {
  const p = (time * rate) % 1;
  const flash = (q: number) => (q >= 0 && q < 0.5 && (q % 0.25) < 0.13 ? 1 : 0);
  return [flash(p), flash(p - 0.5)];
}

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
  private deck: (x: number, y: number, within: number) => number | null;
  private target: THREE.WebGLRenderTarget;
  private targetHigh: THREE.WebGLRenderTarget;
  private highScene = new THREE.Scene();
  // Each lamp near the camera: how far over the ground its light falls (on a bridge's deck,
  // or a floodlight's up the walls), and whether it's on a bridge.
  private spots: number[] = []; // where a bridge is to get a lamp: x, y, and the way to its edge
  private rise: number[] = [];
  private high: boolean[] = [];
  readonly fx: LightFx;
  private lightScene = new THREE.Scene();
  private lightCam = new THREE.Camera();
  private lights: THREE.InstancedBufferGeometry;
  private carData = new Float32Array(MAX_CARS * 8);
  private carMap = new THREE.DataTexture(this.carData, MAX_CARS, 2, THREE.RGBAFormat, THREE.FloatType);
  private carGrid = new Map<number, number[]>();
  private carZ: number[] = [];
  private carIndex = new Map<LitCar, number>();
  private postIndex = new Map<Post, number>();
  // The boxes in the way (cars first, in their order): x, y, and how far one reaches from its middle.
  private blocks = 0;
  private blockAt = new Float32Array(MAX_CARS * 3);
  private pickIds = new Float32Array(NEAR_CARS);
  private pickD = new Float32Array(NEAR_CARS);
  private carsA: THREE.InstancedBufferAttribute; // the boxes near it (indices, -1 for none)
  private carsB: THREE.InstancedBufferAttribute;
  private carsC: THREE.InstancedBufferAttribute;
  private at: THREE.InstancedBufferAttribute; // x, z, ground height, 0 round / 1 beam (+ 2 in the second map)
  private shape: THREE.InstancedBufferAttribute; // direction x, z, length (or radius), width
  private colour: THREE.InstancedBufferAttribute; // (and the height of the light over the ground)
  private view = { value: new THREE.Vector4() };
  private models: THREE.InstancedMesh[] = [];
  private streets = new Map<number, number[]>();
  private facing = new Map<number, number>(); // a lamp → the way (radians) its arm points
  private glows: THREE.InstancedMesh;
  private near: number[] = []; // the lamps round the camera
  private nearAt = { x: Infinity, y: Infinity, r: 0, asked: 0, t: 0 }; // r: the radius gathered, asked: the one asked for
  private dummy = new THREE.Object3D();
  private c = new THREE.Color();
  // The lamps on poles are posts a car can knock over (posts.ts): each one's, and until
  // when one is falling (performance.now), which has it drawn afresh every frame.
  private posts: (Post | undefined)[] = [];
  private falling = 0;
  private tilt = new THREE.Quaternion();
  private axis = new THREE.Vector3();

  // `deck(x, y, within)`: the height of a bridge's deck at a point or within so many metres of it, null where there's none.
  constructor(scene: THREE.Scene, renderer: THREE.WebGLRenderer, area: string, height: (x: number, y: number) => number, deck: (x: number, y: number, within: number) => number | null = () => null) {
    this.renderer = renderer;
    this.height = height;
    this.deck = deck;
    this.fx = new LightFx(scene);
    const size = LAMP_SIZE.value;
    const target = () => new THREE.WebGLRenderTarget(size, size, { type: THREE.HalfFloatType, depthBuffer: false, magFilter: THREE.LinearFilter, minFilter: THREE.LinearFilter });
    this.target = target();
    this.targetHigh = target();
    LAMP_MAP.value = this.target.texture;
    LAMP_MAP_HIGH.value = this.targetHigh.texture;
    // By day nothing draws into the maps, so the materials would bind them as plain textures.
    // When the lamps first come on, WebGPU sets the target up and replaces that texture,
    // the materials keep pointing at the destroyed one, and every frame after fails.
    // Setting the targets up now, before anything binds them, avoids that.
    this.wipe();

    // The pools of light, one instanced quad each.
    const quad = new THREE.InstancedBufferGeometry();
    quad.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
    quad.setIndex([0, 1, 2, 0, 2, 3]);
    // (No DynamicDrawUsage: three.js's WebGPU renderer sends such a buffer whole every frame, needed or not.)
    this.at = new THREE.InstancedBufferAttribute(new Float32Array(MAX_LIGHTS * 4), 4);
    this.shape = new THREE.InstancedBufferAttribute(new Float32Array(MAX_LIGHTS * 4), 4);
    this.colour = new THREE.InstancedBufferAttribute(new Float32Array(MAX_LIGHTS * 4), 4);
    this.carsA = new THREE.InstancedBufferAttribute(new Float32Array(MAX_LIGHTS * 4), 4);
    this.carsB = new THREE.InstancedBufferAttribute(new Float32Array(MAX_LIGHTS * 4), 4);
    this.carsC = new THREE.InstancedBufferAttribute(new Float32Array(MAX_LIGHTS * 4), 4);
    this.carMap.minFilter = this.carMap.magFilter = THREE.NearestFilter;
    quad.setAttribute('iCarsA', this.carsA);
    quad.setAttribute('iCarsB', this.carsB);
    quad.setAttribute('iCarsC', this.carsC);
    quad.setAttribute('iAt', this.at);
    quad.setAttribute('iShape', this.shape);
    quad.setAttribute('iColour', this.colour);
    quad.instanceCount = 0;
    this.lights = quad;
    // (The legacy renderer's pools: one map for every light, and the first eight boxes.)
    const pools = new THREE.Mesh(quad, poolsBy ? poolsBy(this.view, this.carMap, 0) : new THREE.ShaderMaterial({
      uniforms: { uView: this.view, uCars: { value: this.carMap }, uShadow: LAMP_SHADOWS, uRef: LAMP_REF },
      vertexShader: /* glsl */ `
        attribute vec4 iAt; attribute vec4 iShape; attribute vec4 iColour;
        attribute vec4 iCarsA; attribute vec4 iCarsB;
        uniform vec4 uView;
        varying vec2 vL; varying vec3 vC; varying float vH; varying float vBeam;
        varying vec2 vP; varying vec3 vLamp; varying vec4 vCa; varying vec4 vCb;
        void main() {
          vec2 dir = iShape.xy, side = vec2(-dir.y, dir.x), q = position.xy, off;
          float beam = mod(iAt.w, 2.);
          if (beam > .5) { vL = vec2(q.x * .5 + .5, q.y); off = dir * vL.x * iShape.z + side * q.y * iShape.w; }
          else { vL = q; off = (dir * q.x + side * q.y) * iShape.z; }
          vC = iColour.rgb; vH = iAt.z; vBeam = beam;
          vP = iAt.xy + off; vLamp = vec3(iAt.x, iAt.z + iColour.a, iAt.y); vCa = iCarsA; vCb = iCarsB;
          gl_Position = vec4((iAt.xy + off - uView.xy) * uView.zw, 0., 1.);
        }`,
      fragmentShader: /* glsl */ `
        varying vec2 vL; varying vec3 vC; varying float vH; varying float vBeam;
        varying vec2 vP; varying vec3 vLamp; varying vec4 vCa; varying vec4 vCb;
        uniform sampler2D uCars; uniform float uShadow; uniform vec4 uRef;
        // How much box i keeps the light from the ground point p (0..1): the ray from the
        // lamp to the point through the box, the edge softer the further the shadow falls
        // behind it; or, for the cheap version, closeness to the box's outline.
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
          float len = length(D);
          return .92 * smoothstep(0., max(uRef.z, .2 + .06 * (1. - t3) * len), (t3 - t0) * len);
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
          gl_FragColor = vec4(vC * f, (vH - uRef.x) * dot(vC, vec3(.3, .59, .11)) * f);
        }`,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
      depthTest: false, depthWrite: false,
    }));
    pools.frustumCulled = false;
    this.lightScene.add(pools);
    // The same lights again for the second map (a material of its own: which map a light
    // belongs in is decided in its shader).
    if (poolsBy) {
      const high = new THREE.Mesh(quad, poolsBy(this.view, this.carMap, 1));
      high.frustumCulled = false;
      this.highScene.add(high);
    }

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

    void fetchBinary(dataUrl(area, 'lamps.bin.gz'), true).then((buf) => {
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

  // Both maps cleared (and made on the GPU, at their size).
  private wipe() {
    const renderer = this.renderer, before = renderer.getRenderTarget(), clear = renderer.getClearColor(this.c).getHex(), alpha = renderer.getClearAlpha();
    renderer.setClearColor(0x000000, 0);
    for (const t of [this.target, this.targetHigh]) {
      renderer.setRenderTarget(t);
      renderer.clear(true, false, false);
    }
    renderer.setRenderTarget(before);
    renderer.setClearColor(clear, alpha);
  }

  // `z`: the height it stands at, where that's known and matters (on a bridge).
  private add(x: number, y: number, kind: number, z = NaN) {
    const k = this.key(x, y);
    let list = this.grid.get(k);
    if (!list) this.grid.set(k, list = []);
    if (KINDS[kind].pole) {
      const post: Post = { x, y, z, r: 0.15, tough: 5, give: 0.2, down: null, knocked: () => { this.falling = performance.now() + 1300; this.nearAt.x = Infinity; } };
      this.posts[this.kind.length] = post;
      posts.add(post);
    }
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
      for (let i = 1, s = 0, side = 1; i < e.pts.length; i++) {
        const [ax, ay] = e.pts[i - 1], [bx, by] = e.pts[i], len = Math.hypot(bx - ax, by - ay);
        for (; next <= s + len; next += SPACING) {
          const t = (next - s) / len, x = ax + (bx - ax) * t, y = ay + (by - ay) * t;
          if (this.lampWithin(x, y, REACH)) continue;
          const nx = -(by - ay) / len, ny = (bx - ax) / len;
          // On a bridge the utility map often has none either: lamps on posts along its
          // edges, one side then the other.
          // (Put up once the deck there has loaded: see gather.)
          if (e.bridge) {
            this.spots.push(x, y, nx * side, ny * side);
            side = -side;
            continue;
          }
          // Across the street, to the first wall each way.
          const walls = near(x, y);
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
    if (Math.hypot(x - a.x, y - a.y) < 25 && r + 25 <= a.r && r > a.asked * 0.6 && now - a.t < 3000 && performance.now() > this.falling) return;
    const R = r * 1.25 + 40;
    Object.assign(a, { x, y, r: R, asked: r, t: now });
    // The bridges' lamps whose deck is there now: at its edge, on the side chosen.
    const spots = this.spots;
    for (let j = spots.length - 4; j >= 0; j -= 4) {
      const sx = spots[j], sy = spots[j + 1], nx = spots[j + 2], ny = spots[j + 3];
      if (Math.abs(sx - x) > R || Math.abs(sy - y) > R) continue;
      const h = this.deck(sx, sy, 0);
      if (h === null) continue;
      spots.splice(j, 4);
      if (this.lampWithin(sx, sy, REACH)) continue;
      let out = 0;
      while (out < 16 && this.deck(sx + nx * (out + 0.5), sy + ny * (out + 0.5), 0) !== null) out += 0.5;
      out = Math.max(0, out - 0.6);
      this.add(sx + nx * out, sy + ny * out, ON_BRIDGE, h);
    }
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
      // A lamp with a head where a bridge is stands on its deck, not on the ground below.
      // (A floodlight under or beside one lights what's down there, not the walls higher up.)
      const below = this.height(lx, ly), deck = k.raise ? this.deck(lx, ly, 8) : k.head >= 3 ? this.deck(lx, ly, 2) : null;
      const z = k.raise || deck === null ? below : deck;
      this.rise[i] = k.raise ? (deck === null ? k.raise : 0) : z - below;
      this.high[i] = z - below > DECK;
      if (!k.head) continue;
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
        // Knocked over: tipped the way it was hit, about its foot.
        const post = this.posts[i], over = post ? fall(post, performance.now()) : 0;
        if (post?.down) {
          const fa = post.down.ang;
          d.quaternion.premultiply(this.tilt.setFromAxisAngle(this.axis.set(-Math.sin(fa), 0, -Math.cos(fa)), over));
        }
        d.updateMatrix();
        this.models[m].setMatrixAt(used[m]++, d.matrix);
        d.rotation.set(0, 0, 0);
        if (post?.down) continue; // (and its light is out)
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
    this.models.forEach((mesh, m) => { mesh.count = used[m]; sendInstances(mesh); });
    send(cable, c * 2);
    this.cables.geometry.setDrawRange(0, c * 2);
    this.heads = g;
    this.glows.count = g;
    sendInstances(this.glows);
  }
  private heads = 0;

  // The cars into the texture the pools read, and a grid to find the near ones by; then,
  // with LAMP_SHADOWS at 3, whatever else stands in the light (`more`, the trams, the posts).
  private stand(cars: LitCar[], carHeight: (x: number, y: number, car: never) => number, on: boolean, x: number, y: number, r: number, trams: LitTram[], more?: (put: Block) => void) {
    this.carGrid.clear();
    this.carIndex.clear();
    this.postIndex.clear();
    this.blocks = 0;
    const data = this.carData, at = this.blockAt;
    const put = (bx: number, by: number, h: number, halfL: number, halfW: number, ground: number, tall: number) => {
      const i = this.blocks;
      if (i >= MAX_CARS) return -1;
      this.blocks++;
      data[i * 4] = bx; data[i * 4 + 1] = -by; data[i * 4 + 2] = Math.cos(h); data[i * 4 + 3] = -Math.sin(h);
      const o = MAX_CARS * 4 + i * 4;
      data[o] = halfL; data[o + 1] = halfW; data[o + 2] = ground + tall; data[o + 3] = ground;
      at[i * 3] = bx; at[i * 3 + 1] = by; at[i * 3 + 2] = Math.max(halfL, halfW);
      const k = Math.floor(bx / CAR_CELL) * 4096 + Math.floor(by / CAR_CELL);
      const list = this.carGrid.get(k);
      if (list) list.push(i); else this.carGrid.set(k, [i]);
      return i;
    };
    for (let i = 0; i < cars.length; i++) {
      const c = cars[i], z = carHeight(c.x, c.y, c as never);
      this.carZ[i] = z;
      if (on) this.carIndex.set(c, put(c.x, c.y, c.h, c.spec.L / 2, c.spec.W / 2, z, c.spec.H));
    }
    if (on && LAMP_SHADOWS.value > 2.5) {
      more?.(put);
      for (const v of trams) {
        if (!v.look) continue;
        v.parts.forEach((p, i) => {
          if (Math.abs(p.x - x) < r + 30 && Math.abs(p.y - y) < r + 30) put(p.x, p.y, p.ang, TRAM_SECTION / 2, 1.2, v.levels?.[i]?.gz ?? this.height(p.x, p.y), 3.2);
        });
      }
      for (const p of posts.near(x, y, r)) this.postIndex.set(p, put(p.x, p.y, 0, p.r, p.r, Number.isNaN(p.z) ? this.height(p.x, p.y) : p.z, 6));
    }
    if (on) {
      this.carMap.needsUpdate = true;
    }
  }

  // The nearest boxes within reach of a spot, closest first, into pickIds (`most` of them).
  private pick(x: number, y: number, reach: number, skip: number, most: number) {
    const ids = this.pickIds, ds = this.pickD, at = this.blockAt;
    ids.fill(-1);
    const R = reach + 3;
    for (let cx = Math.floor((x - R) / CAR_CELL); cx <= Math.floor((x + R) / CAR_CELL); cx++) {
      for (let cy = Math.floor((y - R) / CAR_CELL); cy <= Math.floor((y + R) / CAR_CELL); cy++) {
        const list = this.carGrid.get(cx * 4096 + cy);
        if (!list) continue;
        for (const i of list) {
          if (i === skip) continue;
          const d = Math.hypot(at[i * 3] - x, at[i * 3 + 1] - y);
          if (d > reach + at[i * 3 + 2]) continue;
          let k = most - 1;
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
  // `opt.box`: half the width and depth of what the camera sees on the ground, when it
  // looks straight down (the map then covers just that, not the whole circle of radius r);
  // `opt.flashing`: the emergency vehicles with their lights going, `opt.time` the game's
  // clock for them (s); `opt.blocks`: the people in view, as boxes; `opt.eye`: where the
  // camera is (three.js's coordinates), `opt.wet` and `opt.murk` how wet the ground is and
  // how hazy the air (0..1), for the beams and glints.
  update<C extends LitCar>(x: number, y: number, r: number, on: number, cars: C[], carHeight: (x: number, y: number, car: C) => number, now: number, trams: LitTram[] = [], opt: {
    box?: [number, number]; flashing?: Flashing[]; time?: number; blocks?: (put: Block) => void; eye?: THREE.Vector3; wet?: number; murk?: number;
  } = {}) {
    LAMP_ON.value = on;
    if (this.target.width !== LAMP_SIZE.value) {
      this.target.setSize(LAMP_SIZE.value, LAMP_SIZE.value);
      this.targetHigh.setSize(LAMP_SIZE.value, LAMP_SIZE.value);
      this.wipe();
    }
    this.gather(x, y, r, now);
    const fx = LIGHT_FX.value > 0 && on > 0.005 && opt.eye ? this.fx : null;
    this.fx.begin(fx ? opt.eye! : null, on, opt.wet ?? 0, opt.murk ?? 0);
    // By day nothing glows or lights the street: only the poles (gathered above) show.
    if (on <= 0.005) {
      this.glows.count = 0;
      this.lights.instanceCount = 0;
      return;
    }
    // The map: a box over the view, its centre on a texel so the pools don't shimmer.
    const size = this.target.width;
    const halfX = (opt.box ? opt.box[0] : r) + 20, halfZ = (opt.box ? opt.box[1] : r) + 20;
    const texelX = (2 * halfX) / size, texelZ = (2 * halfZ) / size;
    const cx = Math.round(x / texelX) * texelX, cz = Math.round(-y / texelZ) * texelZ;
    this.view.value.set(cx, cz, 1 / halfX, 1 / halfZ);
    LAMP_BOX.value.copy(this.view.value);
    const ref = this.height(x, y);
    LAMP_REF.value.set(ref, 0, 1.5 * Math.max(texelX, texelZ), 0);

    // The cars' own lights glow too (after the lamps' heads in the same instances).
    let g = this.heads, n = 0, raised = 0;
    const at = this.at.array as Float32Array, sh = this.shape.array as Float32Array, col = this.colour.array as Float32Array;
    const shading = LAMP_SHADOWS.value > 0, most = LAMP_SHADOWS.value > 2.5 ? NEAR_CARS : 8;
    this.stand(cars, carHeight, shading, x, y, r, trams, opt.blocks);
    const ca = this.carsA.array as Float32Array, cb = this.carsB.array as Float32Array, cc = this.carsC.array as Float32Array;
    // `up`: how high the light is over the ground (0: nothing gets in its way); `own`: the
    // car it is on, which it doesn't shine through; `high`: on a bridge (unknown: by its height).
    const add = (lx: number, ly: number, z: number, beam: number, dx: number, dy: number, len: number, wid: number, c: THREE.Color, i: number, up = 0, own = -1, high?: boolean) => {
      if (n >= MAX_LIGHTS) return;
      const layer = high ?? z - this.height(lx, ly) > DECK;
      if (layer) raised++;
      at.set([lx, -ly, z, beam + (layer ? 2 : 0)], n * 4);
      sh.set([dx, -dy, len, wid], n * 4);
      col.set([c.r * i, c.g * i, c.b * i, up], n * 4);
      const ids = this.pickIds;
      if (shading && up > 0) {
        if (beam) this.pick(lx + dx * len / 2, ly + dy * len / 2, len / 2 + wid, own, most);
        else this.pick(lx, ly, len, own, most);
      } else ids.fill(-1);
      for (let k = 0; k < 4; k++) { ca[n * 4 + k] = ids[k]; cb[n * 4 + k] = ids[4 + k]; cc[n * 4 + k] = ids[8 + k]; }
      n++;
    };
    for (const i of this.near) {
      const k = KINDS[this.kind[i]], lx = this.xy[i * 2], ly = this.xy[i * 2 + 1];
      if (Math.abs(lx - x) > r + k.r || Math.abs(ly - y) > r + k.r || this.posts[i]?.down) continue;
      const colour = colourOf(this.kind[i], i);
      // (Only the lamps up on poles and walls: not the floodlights or those in tunnels.)
      const post = this.posts[i];
      const z = this.height(lx, ly) + (this.rise[i] ?? 0);
      add(lx, ly, z, 0, 1, 0, k.r, k.r, colour, k.i, k.raise || k.head < 3 ? 0 : k.head, (post && this.postIndex.get(post)) ?? -1, this.high[i]);
      if (fx && k.head >= 3) fx.lamp(lx, ly, z, k.head, colour, k.i, this.carGrid, this.blockAt, cars, this.carZ);
    }
    const d = this.dummy;
    cars.forEach((c, ci) => {
      if (c.mode === 'loose' && c.speed < 0.5) return; // parked: lights off
      const fx0 = Math.cos(c.h), fy = Math.sin(c.h), L = c.spec.L / 2, W = c.spec.W / 2;
      const z = this.carZ[ci], own = this.carIndex.get(c) ?? -1;
      add(c.x + fx0 * L, c.y + fy * L, z, 1, fx0, fy, c.two ? 16 : 24, c.two ? 3 : 5, HEAD, c.two ? 1.2 : 2.2, 0.75, own);
      // The rear lights shine backwards onto the road from the bumper, a short beam from
      // each (not a round pool on the car, which would redden its roof and bonnet).
      for (const s of c.two ? [0] : [-1, 1]) {
        const across = s * (W - 0.3);
        add(c.x - fx0 * L - fy * across, c.y - fy * L + fx0 * across, z, 1, -fx0, -fy, c.two ? 2 : 3.5, c.two ? 0.6 : 1.2, TAIL, c.two ? 0.3 : 0.22, 0.75, own);
        if (fx) fx.beam(c.x + fx0 * (L - 0.05) - fy * across, c.y + fy * (L - 0.05) + fx0 * across, z + 0.75, fx0, fy, c.two ? 11 : 16, c.two ? 1.3 : 1.9, HEAD, 1);
      }
      // Two headlights and two rear lights (one each on a bike).
      for (const [along, colour, size] of [[L - 0.05, HEAD, 0.9], [-L - 0.05, TAIL, 0.5]] as [number, THREE.Color, number][]) {
        for (const s of c.two ? [0] : [-1, 1]) {
          if (g >= this.glows.instanceMatrix.count) break;
          const across = s * (W - 0.3);
          d.position.set(c.x + fx0 * along - fy * across, z + 0.75, -(c.y + fy * along + fx0 * across));
          d.scale.set(size, 1, size);
          d.updateMatrix();
          this.glows.setMatrixAt(g, d.matrix);
          this.glows.setColorAt(g++, this.c.copy(colour).multiplyScalar(0.8));
        }
      }
    });
    // Emergency vehicles: the light bar flashes one side, then the other, a double flash
    // each. Each side's light falls round the car from its own end of the bar, so the
    // shadows of what stands near jump from side to side with it.
    for (const f of opt.flashing ?? []) {
      const c = f.car, ci = cars.indexOf(c as C);
      if (ci < 0) continue;
      const z = this.carZ[ci], own = this.carIndex.get(c) ?? -1, up = c.spec.H + 0.25;
      const [left, right] = strobe(opt.time ?? 0, f.rate);
      const sx = -Math.sin(c.h), sy = Math.cos(c.h), half = c.spec.W / 2;
      for (const [side, lit] of [[1, left], [-1, right]] as [number, number][]) {
        // (A little always shows between the flashes: the bar's glow.)
        add(c.x + sx * side * half, c.y + sy * side * half, z, 0, 1, 0, f.reach, f.reach, BEACON, 0.12 + 1.9 * lit, up, own);
      }
    }
    for (const v of trams) {
      if (!v.look || !v.parts.length) continue;
      v.parts.forEach((p, i) => {
        if (Math.abs(p.x - x) > r + 30 || Math.abs(p.y - y) > r + 30) return;
        add(p.x, p.y, v.levels?.[i]?.gz ?? this.height(p.x, p.y), 0, 1, 0, 6, 6, CABIN, 0.3);
      });
      const f = v.parts[v.parts.length - 1], b = v.parts[0], half = TRAM_SECTION / 2;
      const fx0 = Math.cos(f.ang), fy = Math.sin(f.ang), bx = Math.cos(b.ang), by = Math.sin(b.ang);
      const z = v.levels?.[v.parts.length - 1]?.gz ?? this.height(f.x, f.y);
      add(f.x + fx0 * half, f.y + fy * half, z, 1, fx0, fy, 28, 5, HEAD, 1.8, LAMP_SHADOWS.value > 2.5 ? 0.9 : 0);
      add(b.x - bx * half, b.y - by * half, v.levels?.[0]?.gz ?? this.height(b.x, b.y), 0, 1, 0, 2.6, 2.6, TAIL, 0.5);
      for (const s of [-1, 1]) {
        if (fx) fx.beam(f.x + fx0 * (half + 0.1) - fy * s * 0.9, f.y + fy * (half + 0.1) + fx0 * s * 0.9, z + 0.9, fx0, fy, 18, 2, HEAD, 1);
        if (g >= this.glows.instanceMatrix.count) break;
        d.position.set(f.x + fx0 * (half + 0.1) - fy * s * 0.9, z + 0.9, -(f.y + fy * (half + 0.1) + fx0 * s * 0.9));
        d.scale.set(1, 1, 1);
        d.updateMatrix();
        this.glows.setMatrixAt(g, d.matrix);
        this.glows.setColorAt(g++, this.c.copy(HEAD).multiplyScalar(0.8));
      }
    }
    this.fx.commit();
    this.glows.count = g;
    sendInstances(this.glows);
    this.lights.instanceCount = n;
    if (!n) return;
    for (const a of [this.at, this.shape, this.colour, this.carsA, this.carsB, this.carsC]) send(a, n);
    // The second map only where something is up on a bridge (the legacy renderer draws every light into the first).
    const layers = poolsBy && raised ? 2 : 1;
    LAMP_REF.value.y = layers - 1;

    const renderer = this.renderer, before = renderer.getRenderTarget(), clear = renderer.getClearColor(this.c).getHex(), alpha = renderer.getClearAlpha();
    const shadows = renderer.shadowMap.autoUpdate;
    renderer.shadowMap.autoUpdate = false;
    renderer.setClearColor(0x000000, 0);
    for (let l = 0; l < layers; l++) {
      renderer.setRenderTarget(l ? this.targetHigh : this.target);
      renderer.clear(true, false, false);
      renderer.render(l ? this.highScene : this.lightScene, this.lightCam);
    }
    renderer.setRenderTarget(before);
    renderer.setClearColor(clear, alpha);
    renderer.shadowMap.autoUpdate = shadows;
  }
}
