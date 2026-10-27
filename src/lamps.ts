import { dataUrl } from './data.ts';
import * as THREE from 'three';
import { mirrored, mirroredGlow } from './mirror.ts';
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
// The first map's light again with nothing in its way, at a quarter of its size: the map
// is flat, so the shadow a car casts on the street would also darken whatever is above
// it (a tree's crown over a parked car). What stands well above the ground a light falls
// on takes its light from here instead. Drawn only when the cars cast shadows (LAMP_REF.w).
export const LAMP_MAP_OPEN: { value: THREE.Texture | null } = { value: null };
// (x, z of the map's centre, 1 / its half width, 1 / its half depth)
export const LAMP_BOX = { value: new THREE.Vector4(0, 0, 1, 1) };
// (the height the map's heights are measured from, 1 when the second map has lights in it,
// the softest a shadow's edge may be (m): a texel and a half, 1 when LAMP_MAP_OPEN is drawn)
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

// Over the ground a light falls on, from where the open map's light takes over (m): above
// a car's roof, below a tree's crown.
export const OPEN_ABOVE = [2.2, 3.4];
export const LAMP_GLSL = /* glsl */ `
#define OPEN_ABOVE vec2(${OPEN_ABOVE[0].toFixed(1)}, ${OPEN_ABOVE[1].toFixed(1)})
uniform sampler2D uLampMap; uniform sampler2D uLampOpen; uniform vec4 uLampBox; uniform vec4 uLampRef; uniform float uLampOn;
// The lamps' light at a point in the world (0 by day and off the map). With a surface
// (n): what faces up and is well above the lamp (a bridge deck over the street, whose
// cars' lights would otherwise show through it) gets none.
vec3 lampLightOn(vec3 w, vec3 n) {
  if (uLampOn < .005) return vec3(0.);
  vec2 uv = (w.xz - uLampBox.xy) * uLampBox.zw * .5 + .5;
  if (uv.x < 0. || uv.y < 0. || uv.x > 1. || uv.y > 1.) return vec3(0.);
  vec4 l = texture2D(uLampMap, uv);
  float dy = w.y - (l.a / max(dot(l.rgb, vec3(.3, .59, .11)), 1e-4) + uLampRef.x);
  if (uLampRef.w > .5) {
    // Above the cars, the light nothing stands in (LAMP_MAP_OPEN), which also knows the
    // ground under a car's shadow.
    vec4 o = texture2D(uLampOpen, uv);
    float oy = w.y - (o.a / max(dot(o.rgb, vec3(.3, .59, .11)), 1e-4) + uLampRef.x);
    l.rgb = mix(l.rgb, o.rgb, smoothstep(OPEN_ABOVE.x, OPEN_ABOVE.y, oy));
    dy = oy;
  }
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
  sh.uniforms.uLampOpen = LAMP_MAP_OPEN;
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

// A street lamp's pool falls off as the light of a point at the head's height would (the
// cube of the cosine over the distance squared), but as if the head were lower (`height`
// of it), since a lamp throws most of its light down beneath it, and so brighter there
// (`peak`): a hot spot under each lamp, darker between them. Lamps on arms and walls
// throw it further along their street than across it (`along`, `across`, times the reach),
// from the end of the arm (`arm`, m, for the two kinds).
export const POOL = { height: 0.6, peak: 1.8, along: 1.25, across: 0.75, arm: [1.68, 0.55] };
// How wide a lamp head's glow is (m): enough to show where the light comes from, from above.
const GLOW = 4;

// Kinds of lamp (pipeline/build_lamps.py): the height of the head, the pole under it,
// how far its light reaches and how bright it is. Floodlights on monuments light the
// walls higher up (`raise`: they count as standing that much higher).
const KINDS = [
  { head: 7.5, pole: true, r: 15, i: 1.0, raise: 0, glow: 0.55 }, // on a pole
  { head: 4.5, pole: false, r: 10, i: 0.8, raise: 0, glow: 0.4 }, // on a wall
  { head: 4.2, pole: true, r: 10, i: 0.8, raise: 0, glow: 0.45 }, // gas lamp
  { head: 5.5, pole: true, r: 11, i: 0.9, raise: 0, glow: 0.45 }, // festive, on a pole
  { head: 1.0, pole: false, r: 5.5, i: 1.6, raise: 14, glow: 0 }, // floodlight on a monument (lights its walls, not the square)
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
// Which streets: the lit ones of lit.bin.gz (pipeline/build_lamps.py and
// street_lighting.py): those OSM tags as lit, and untagged ones with a lamp near them,
// with buildings along them, or on the way from such a stretch to the next lit street.
// A street tagged dark gets none, nor does a road between fields.
// (A map built before that file: every street, as it was.)
// A lit street with none of the map's lamps near is a gap in the survey (a neighbourhood
// it missed, the villages past the city's border): it gets lamps on poles along one side.
// Over a street lit only by those rules a lamp is hung where the houses stand close
// (SPAN_INFERRED); between houses set back in their gardens it would look invented.
const SPACING = 30, REACH = 20, WALL = 18;
const HANG_REACH = 8; // m: how far from a street's centre line one of the map's hung lamps may be
const SPAN = 26, SPAN_INFERRED = 18; // m: the widest street a lamp is hung over, wall to wall
const UNSURVEYED = 40; // m: with none of the map's own lamps this near, the survey has a gap here
const LIT_CELL = 50, LIT_MATCH = 4, LIT_UNIT = 0.25; // m: the lit streets' grid, how near one must run, the file's unit
const ANCHOR = 7.4, SLACK = 0.3; // m: where a cable meets a wall above the street, how much it sags
const MAX_HUNG = 800, HALVES = 5; // (cable pieces from a wall to the lamp)
const UNLIT = new Set(['motorway', 'motorway_link', 'track', 'service']);
// The footpaths that get lamps of the game's own, and their kind (a globe on a short post).
const PATHS = new Set(['footway', 'path', 'pedestrian', 'steps', 'cycleway']), PATH_LAMP = 3;
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

// lit.bin.gz (pipeline/build_lamps.py) as a grid of its streets' segments.
export function litStreets(buf: ArrayBuffer) {
  const grid = new Map<number, number[]>(), view = new DataView(buf);
  let o = 4;
  for (let w = view.getUint32(0, true); w > 0; w--) {
    const lit = view.getUint8(o), n = view.getUint16(o + 1, true);
    let ax = view.getInt32(o + 3, true), ay = view.getInt32(o + 7, true);
    o += 11;
    for (let i = 1; i < n; i++, o += 4) {
      const bx = ax + view.getInt16(o, true), by = ay + view.getInt16(o + 2, true);
      const x0 = ax * LIT_UNIT, y0 = ay * LIT_UNIT, x1 = bx * LIT_UNIT, y1 = by * LIT_UNIT;
      for (let cx = Math.floor((Math.min(x0, x1) - LIT_MATCH) / LIT_CELL); cx <= Math.floor((Math.max(x0, x1) + LIT_MATCH) / LIT_CELL); cx++) {
        for (let cy = Math.floor((Math.min(y0, y1) - LIT_MATCH) / LIT_CELL); cy <= Math.floor((Math.max(y0, y1) + LIT_MATCH) / LIT_CELL); cy++) {
          const k = (cx + 4096) * 8192 + cy + 4096, list = grid.get(k);
          if (list) list.push(x0, y0, x1, y1, lit); else grid.set(k, [x0, y0, x1, y1, lit]);
        }
      }
      ax = bx; ay = by;
    }
  }
  return grid;
}

// The street through a point: 1 and more lit (1 by its tag in OSM, more by the rules of
// pipeline/street_lighting.py), 0 tagged dark, -1 not in the file (dark).
export function litAt(grid: Map<number, number[]>, x: number, y: number) {
  let best = LIT_MATCH, lit = -1;
  for (let cx = Math.floor((x - LIT_MATCH) / LIT_CELL); cx <= Math.floor((x + LIT_MATCH) / LIT_CELL); cx++) {
    for (let cy = Math.floor((y - LIT_MATCH) / LIT_CELL); cy <= Math.floor((y + LIT_MATCH) / LIT_CELL); cy++) {
      const list = grid.get((cx + 4096) * 8192 + cy + 4096);
      if (!list) continue;
      for (let j = 0; j < list.length; j += 5) {
        const ax = list[j], ay = list[j + 1], ex = list[j + 2] - ax, ey = list[j + 3] - ay;
        const t = Math.max(0, Math.min(1, ((x - ax) * ex + (y - ay) * ey) / (ex * ex + ey * ey || 1)));
        const d = Math.hypot(ax + ex * t - x, ay + ey * t - y);
        if (d < best) { best = d; lit = list[j + 4]; }
      }
    }
  }
  return lit;
}

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

interface Street { hw: string; pts: [number, number][]; width?: number; tunnel?: boolean; bridge?: boolean }
interface LampTile { cells: Set<number>; lamps: Set<number>; hung: Set<number> }
interface BridgeSpot { x: number; y: number; nx: number; ny: number; tile: LampTile }
interface LitTram { parts: { x: number; y: number; ang: number }[]; look: unknown; levels?: { gz?: number }[] }
// `broken`: which of its lamps are smashed (LAMP in car.ts: 1 and 2 the headlamps left and right, 4 and 8 the tail lamps).
export interface LitCar { x: number; y: number; h: number; spec: { L: number; W: number; H: number }; mode: string; two?: string; speed: number; broken?: number; braking?: boolean }

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
// A searchlight on something in the air (a police helicopter): where it is (x, y, height)
// and the spot on the ground it shines on.
export interface Spot { x: number; y: number; z: number; tx: number; ty: number }
const SEARCH = new THREE.Color('#fff3d6');
const SEARCH_R = 9; // m: how wide its pool of light is

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
  private surveyed = 0; // how many of the lamps came with the map (the first ones)
  // OSM's lit and dark streets, their segments in a grid (x0, y0, x1, y1, lit); null: the map has none.
  private lit: Map<number, number[]> | null = null;
  private waiting = new Map<string, [Street[], [number, number][][], Street[]]>();
  private tiles = new Map<string, LampTile>();
  private free: number[] = []; // generated lamps reuse retired slots; survey indices stay fixed
  private generatedOwners = new Map<number, Set<LampTile>>();
  private seeds: number[] = [];
  private hung = new Map<number, number[]>(); // a hung lamp → the two wall points its cables run to (x, y, x, y)
  // A survey lamp can have valid walls in several overlapping tiles. Keep their
  // anchors separately so forgetting one tile preserves the others' cables.
  private surveyCables = new Map<number, Map<LampTile, number[]>>();
  private cables: THREE.LineSegments;
  private grid = new Map<number, number[]>();
  private renderer: THREE.WebGLRenderer;
  private height: (x: number, y: number) => number;
  private deck: (x: number, y: number, within: number) => number | null;
  private target: THREE.WebGLRenderTarget;
  private targetHigh: THREE.WebGLRenderTarget;
  private targetOpen: THREE.WebGLRenderTarget;
  private highScene = new THREE.Scene();
  // Each lamp near the camera: how far over the ground its light falls (on a bridge's deck,
  // or a floodlight's up the walls), and whether it's on a bridge.
  private spots: BridgeSpot[] = [];
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
  private streets = new Map<number, Map<string, number[]>>();
  private facing = new Map<number, number>(); // a lamp → the way (radians) its arm points
  glows: THREE.InstancedMesh; // (read by the streaks, streaks.ts)
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
    const target = (n = size) => new THREE.WebGLRenderTarget(n, n, { type: THREE.HalfFloatType, depthBuffer: false, magFilter: THREE.LinearFilter, minFilter: THREE.LinearFilter });
    this.target = target();
    this.targetHigh = target();
    this.targetOpen = target(size / 4);
    LAMP_MAP.value = this.target.texture;
    LAMP_MAP_HIGH.value = this.targetHigh.texture;
    LAMP_MAP_OPEN.value = this.targetOpen.texture;
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
        varying vec2 vP; varying vec3 vLamp; varying vec4 vCa; varying vec4 vCb; varying float vU;
        void main() {
          vec2 dir = iShape.xy, side = vec2(-dir.y, dir.x), q = position.xy, off;
          // (4 added: a spot, a round pool whose light comes from the point dir away from its centre.)
          float spot = step(3.5, iAt.w), beam = mod(iAt.w - 4. * spot, 2.);
          if (spot > .5) { vL = q; off = q * iShape.z; }
          else if (beam > .5) { vL = vec2(q.x * .5 + .5, q.y); off = dir * vL.x * iShape.z + side * q.y * iShape.w; }
          else { vL = q; off = dir * q.x * iShape.z + side * q.y * iShape.w; }
          // A street lamp's pool (one up on a head, see POOL): its reach over the head's height.
          vU = spot + beam < .5 && iColour.a > 2.9 ? sqrt(iShape.z * iShape.w) / (iColour.a * ${POOL.height.toFixed(2)}) : 0.;
          vC = iColour.rgb; vH = iAt.z; vBeam = beam + 2. * spot;
          vP = iAt.xy + off; vLamp = vec3(iAt.x + spot * dir.x, iAt.z + iColour.a, iAt.y + spot * dir.y); vCa = iCarsA; vCb = iCarsB;
          gl_Position = vec4((iAt.xy + off - uView.xy) * uView.zw, 0., 1.);
        }`,
      fragmentShader: /* glsl */ `
        varying vec2 vL; varying vec3 vC; varying float vH; varying float vBeam;
        varying vec2 vP; varying vec3 vLamp; varying vec4 vCa; varying vec4 vCb; varying float vU;
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
          if (vBeam > 1.5) {
            f = 1. - smoothstep(.45, 1., length(vL));
            f *= f;
          } else if (vBeam > .5) {
            float t = vL.x, a = abs(vL.y) / (.25 + .75 * t);
            f = (1. - t) * (1. - t) * smoothstep(1., .35, a) * smoothstep(0., .1, t);
          } else {
            float d = dot(vL, vL);
            if (vU > 0.) {
              float e = 1. + d * vU * vU;
              f = ${POOL.peak.toFixed(2)} * inversesqrt(e) / e * (1. - smoothstep(.5, 1., d));
            } else f = d < 1. ? (1. - d) * (1. - d) : 0.;
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
      const mesh = mirrored(new THREE.InstancedMesh(m.make(), poleMaterial, MAX_POLES));
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
    mirroredGlow(this.glows);
    // The cables of the hung lamps near the camera: HALVES lines a side, two sides each.
    const cableGeometry = new THREE.BufferGeometry();
    cableGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_HUNG * 2 * HALVES * 2 * 3), 3));
    cableGeometry.setDrawRange(0, 0);
    this.cables = new THREE.LineSegments(cableGeometry, new THREE.LineBasicMaterial({ color: '#1d1f20', transparent: true, opacity: 0.85 }));
    this.cables.frustumCulled = false;
    scene.add(...this.models, this.glows, this.cables);

    const lamps = fetchBinary(dataUrl(area, 'lamps.bin.gz'), true).then((buf) => {
      if (!buf) return;
      const n = new DataView(buf).getUint32(0, true);
      const xy = new Float32Array(buf.slice(4, 4 + n * 8)), kind = new Uint8Array(buf, 4 + n * 8, n);
      for (let i = 0; i < n; i++) this.add(xy[i * 2], xy[i * 2 + 1], kind[i]);
      this.surveyed = n;
    }).catch(() => {});
    const lit = fetchBinary(dataUrl(area, 'lit.bin.gz'), true).then((buf) => { if (buf) this.lit = litStreets(buf); }).catch(() => {});
    void Promise.all([lamps, lit]).finally(() => {
      this.loaded = true;
      for (const [key, [edges, walls, paths]] of this.waiting) this.fill(key, edges, walls, paths);
      this.waiting.clear();
      this.nearAt.x = Infinity;
    });
  }

  // The maps cleared (and made on the GPU, at their size).
  private wipe() {
    const renderer = this.renderer, before = renderer.getRenderTarget(), clear = renderer.getClearColor(this.c).getHex(), alpha = renderer.getClearAlpha();
    renderer.setClearColor(0x000000, 0);
    for (const t of [this.target, this.targetHigh, this.targetOpen]) {
      renderer.setRenderTarget(t);
      renderer.clear(true, false, false);
    }
    renderer.setRenderTarget(before);
    renderer.setClearColor(clear, alpha);
  }

  // `z`: the height it stands at, where that's known and matters (on a bridge).
  private add(x: number, y: number, kind: number, z = NaN, tile?: LampTile) {
    const i = this.free.pop() ?? this.kind.length;
    const k = this.key(x, y);
    let list = this.grid.get(k);
    if (!list) this.grid.set(k, list = []);
    if (KINDS[kind].pole) {
      const post: Post = { x, y, z, r: 0.15, tough: 5, give: 0.2, down: null, knocked: () => { this.falling = performance.now() + 1300; this.nearAt.x = Infinity; } };
      this.posts[i] = post;
      posts.add(post);
    }
    list.push(i);
    this.xy[i * 2] = x; this.xy[i * 2 + 1] = y;
    this.kind[i] = kind;
    // Generated lamps have the same model/colour after a return, even if another
    // tile used their old slots. The survey retains its original index-based look.
    this.seeds[i] = tile ? x * 0.754877666 + y * 0.569840296 : i;
    tile?.lamps.add(i);
    if (tile) this.generatedOwners.set(i, new Set([tile]));
    return i;
  }

  // Retire the same tiles as the street graphs, including work waiting on lamp data.
  forget(keys: string[]) {
    const gone = new Set<LampTile>();
    for (const key of keys) {
      this.waiting.delete(key);
      const tile = this.tiles.get(key);
      if (!tile) continue;
      gone.add(tile);
      this.tiles.delete(key);
      for (const cell of tile.cells) {
        const list = this.streets.get(cell)!;
        list.delete(key);
        if (!list.size) this.streets.delete(cell);
      }
      for (const i of tile.hung) {
        const owners = this.surveyCables.get(i)!;
        owners.delete(tile);
        if (owners.size) this.hung.set(i, owners.values().next().value!);
        else { this.surveyCables.delete(i); this.hung.delete(i); }
      }
      for (const i of tile.lamps) {
        const owners = this.generatedOwners.get(i)!;
        owners.delete(tile);
        if (owners.size) continue;
        this.generatedOwners.delete(i);
        const key = this.key(this.xy[i * 2], this.xy[i * 2 + 1]);
        const list = this.grid.get(key)!;
        list.splice(list.indexOf(i), 1);
        if (!list.length) this.grid.delete(key);
        const post = this.posts[i];
        if (post) posts.remove(post);
        this.posts[i] = undefined;
        this.hung.delete(i);
        this.kind[i] = -1;
        this.xy[i * 2] = this.xy[i * 2 + 1] = NaN;
        this.rise[i] = 0; this.high[i] = false;
        this.free.push(i);
      }
    }
    this.spots = this.spots.filter((spot) => !gone.has(spot.tile));
    this.facing.clear();
    this.nearAt.x = Infinity;
  }

  // `below`: only the lamps before this one (the map's own: `surveyed`).
  private lampWithin(x: number, y: number, r: number, below = Infinity, tile?: LampTile) {
    for (let cx = Math.floor((x - r) / CELL); cx <= Math.floor((x + r) / CELL); cx++) {
      for (let cy = Math.floor((y - r) / CELL); cy <= Math.floor((y + r) / CELL); cy++) {
        const list = this.grid.get((cx + 2048) * 4096 + cy + 2048);
        if (list) for (const i of list) if (i < below && Math.hypot(this.xy[i * 2] - x, this.xy[i * 2 + 1] - y) < r) {
          // Overlapping street tiles may both rely on one generated lamp. Retain
          // it until the last such tile leaves, including its post and cables.
          if (tile && i >= this.surveyed) {
            this.generatedOwners.get(i)!.add(tile);
            tile.lamps.add(i);
          }
          return true;
        }
      }
    }
    return false;
  }

  // Streets as their tiles load: lamps hung over the unlit stretches, on cables to the
  // buildings either side (`buildings`: their outlines; a stretch with none is left dark).
  // `paths`: the footpaths that came with them.
  fill(key: string, edges: Street[], buildings: [number, number][][], paths: Street[] = []) {
    if (!this.loaded) { this.waiting.set(key, [edges, buildings, paths]); return; }
    if (this.tiles.has(key)) return;
    const tile: LampTile = { cells: new Set(), lamps: new Set(), hung: new Set() };
    this.tiles.set(key, tile);
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
            let owners = this.streets.get(k);
            if (!owners) this.streets.set(k, owners = new Map());
            const list = owners.get(key);
            if (list) list.push(ax, ay, bx, by); else owners.set(key, [ax, ay, bx, by]);
            tile.cells.add(k);
          }
        }
      }
    }
    // The map's hung lamps by these streets: cables across the street to the first wall each way.
    for (const e of edges) {
      for (let i = 1; i < e.pts.length; i++) {
        const [ax, ay] = e.pts[i - 1], [bx, by] = e.pts[i], ex = bx - ax, ey = by - ay, len = Math.hypot(ex, ey) || 1;
        for (let cx = Math.floor((Math.min(ax, bx) - HANG_REACH) / CELL); cx <= Math.floor((Math.max(ax, bx) + HANG_REACH) / CELL); cx++) {
          for (let cy = Math.floor((Math.min(ay, by) - HANG_REACH) / CELL); cy <= Math.floor((Math.max(ay, by) + HANG_REACH) / CELL); cy++) {
            for (const j of this.grid.get((cx + 2048) * 4096 + cy + 2048) ?? []) {
              if (j >= this.surveyed || this.kind[j] !== HUNG || tile.hung.has(j)) continue;
              const x = this.xy[j * 2], y = this.xy[j * 2 + 1], t = ((x - ax) * ex + (y - ay) * ey) / (len * len);
              if (t < 0 || t > 1 || Math.abs((x - ax) * ey - (y - ay) * ex) / len > HANG_REACH) continue;
              const nx = -ey / len, ny = ex / len, walls = near(x, y);
              const l = cast(walls, x, y, nx, ny, WALL), r = cast(walls, x, y, -nx, -ny, WALL);
              if (!Number.isFinite(l) || !Number.isFinite(r)) continue;
              const anchors = [x + nx * l, y + ny * l, x - nx * r, y - ny * r];
              let owners = this.surveyCables.get(j);
              if (!owners) this.surveyCables.set(j, owners = new Map());
              owners.set(tile, anchors);
              if (!this.hung.has(j)) this.hung.set(j, anchors);
              tile.hung.add(j);
            }
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
          if (this.lampWithin(x, y, REACH, Infinity, tile)) continue;
          const nx = -(by - ay) / len, ny = (bx - ax) / len;
          // On a bridge the utility map often has none either: lamps on posts along its
          // edges, one side then the other.
          // (Put up once the deck there has loaded: see gather.)
          if (e.bridge) {
            if (this.lit && litAt(this.lit, x, y) === 0) continue;
            this.spots.push({ x, y, nx: nx * side, ny: ny * side, tile });
            side = -side;
            continue;
          }
          // Across the street, to the first wall each way.
          const walls = near(x, y);
          const l = cast(walls, x, y, nx, ny, WALL), r = cast(walls, x, y, -nx, -ny, WALL);
          if (!this.lit) {
            if (!Number.isFinite(l) || !Number.isFinite(r)) continue;
          } else {
            const lit = litAt(this.lit, x, y); // (1: by its tag; more: by the rules)
            if (lit < 1) continue;
            if (!(l + r <= (lit > 1 ? SPAN_INFERRED : SPAN))) {
              // Too wide to hang one over, or open on a side: lamps on poles where the survey
              // has none, on the kerb of the side with more room.
              if (this.lampWithin(x, y, UNSURVEYED, this.surveyed)) continue;
              const out = Math.max(e.width ?? 0, 4) / 2 + 1, s = l < out + 1 && r >= out + 1 ? -1 : 1;
              if (Math.min(s > 0 ? l : r, WALL) < out + 1) continue;
              this.add(x + nx * out * s, y + ny * out * s, 0, NaN, tile);
              continue;
            }
          }
          const j = this.add(x, y, HUNG, NaN, tile);
          this.hung.set(j, [x + nx * l, y + ny * l, x - nx * r, y - ny * r]);
        }
        s += len;
      }
    }
    // Paths (an estate's, a park's): lit ones the survey has no lamps on get small lamps
    // on posts beside them.
    if (this.lit) for (const e of paths) {
      if (e.tunnel || e.bridge || !PATHS.has(e.hw)) continue;
      let next = SPACING / 2;
      for (let i = 1, s = 0; i < e.pts.length; i++) {
        const [ax, ay] = e.pts[i - 1], [bx, by] = e.pts[i], len = Math.hypot(bx - ax, by - ay);
        for (; next <= s + len; next += SPACING) {
          const t = (next - s) / len, x = ax + (bx - ax) * t, y = ay + (by - ay) * t;
          if (this.lampWithin(x, y, REACH, Infinity, tile) || this.lampWithin(x, y, UNSURVEYED, this.surveyed) || litAt(this.lit, x, y) < 1) continue;
          const nx = -(by - ay) / len, ny = (bx - ax) / len, out = Math.max(e.width ?? 0, 2) / 2 + 0.6;
          const walls = near(x, y);
          const side = cast(walls, x, y, nx, ny, WALL) >= out + 1 ? 1 : cast(walls, x, y, -nx, -ny, WALL) >= out + 1 ? -1 : 0;
          if (side) this.add(x + nx * out * side, y + ny * out * side, PATH_LAMP, NaN, tile);
        }
        s += len;
      }
    }
    this.facing.clear();
    this.nearAt.x = Infinity;
  }

  // The way from a lamp to the nearest street within reach (radians, the map's x and y),
  // once a street is known; until then whichever way.
  private face(i: number, x: number, y: number) {
    const known = this.facing.get(i);
    if (known !== undefined) return known;
    const list = this.streets.get((Math.floor(x / STREET_CELL) + 4096) * 8192 + Math.floor(y / STREET_CELL) + 4096);
    let best = REACH_ARM, ang: number | undefined;
    if (list) for (const segments of list.values()) {
      for (let j = 0; j < segments.length; j += 4) {
        const ax = segments[j], ay = segments[j + 1], ex = segments[j + 2] - ax, ey = segments[j + 3] - ay;
        const t = Math.max(0, Math.min(1, ((x - ax) * ex + (y - ay) * ey) / (ex * ex + ey * ey || 1)));
        const dx = ax + ex * t - x, dy = ay + ey * t - y, d = Math.hypot(dx, dy);
        if (d < best) { best = d; ang = Math.atan2(dy, dx); }
      }
    }
    if (ang === undefined) return hash(this.seeds[i]) * Math.PI * 2;
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
    for (let j = spots.length - 1; j >= 0; j--) {
      const { x: sx, y: sy, nx, ny, tile } = spots[j];
      if (Math.abs(sx - x) > R || Math.abs(sy - y) > R) continue;
      const h = this.deck(sx, sy, 0);
      if (h === null) continue;
      spots.splice(j, 1);
      if (this.lampWithin(sx, sy, REACH, Infinity, tile)) continue;
      let out = 0;
      while (out < 16 && this.deck(sx + nx * (out + 0.5), sy + ny * (out + 0.5), 0) !== null) out += 0.5;
      out = Math.max(0, out - 0.6);
      this.add(sx + nx * out, sy + ny * out, ON_BRIDGE, h, tile);
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
      const m = modelOf(this.kind[i], this.seeds[i]);
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
          d.scale.set(GLOW, 1, GLOW);
          d.updateMatrix();
          this.glows.setMatrixAt(g, d.matrix);
          this.glows.setColorAt(g++, this.c.copy(colourOf(this.kind[i], this.seeds[i])).multiplyScalar(k.glow * 2));
        }
      } else if (k.glow && g < this.glows.instanceMatrix.count) {
        d.position.set(lx, z + k.head, -ly);
        d.scale.set(GLOW, 1, GLOW);
        d.updateMatrix();
        this.glows.setMatrixAt(g, d.matrix);
        this.glows.setColorAt(g++, this.c.copy(colourOf(this.kind[i], this.seeds[i])).multiplyScalar(k.glow * 2));
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
    box?: [number, number]; flashing?: Flashing[]; spots?: Spot[]; time?: number; blocks?: (put: Block) => void; eye?: THREE.Vector3; wet?: number; murk?: number;
  } = {}) {
    LAMP_ON.value = on;
    if (this.target.width !== LAMP_SIZE.value) {
      this.target.setSize(LAMP_SIZE.value, LAMP_SIZE.value);
      this.targetHigh.setSize(LAMP_SIZE.value, LAMP_SIZE.value);
      this.targetOpen.setSize(LAMP_SIZE.value / 4, LAMP_SIZE.value / 4);
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
        if (beam === 1) this.pick(lx + dx * len / 2, ly + dy * len / 2, len / 2 + wid, own, most);
        else this.pick(lx, ly, Math.max(len, wid), own, most);
      } else ids.fill(-1);
      for (let k = 0; k < 4; k++) { ca[n * 4 + k] = ids[k]; cb[n * 4 + k] = ids[4 + k]; cc[n * 4 + k] = ids[8 + k]; }
      n++;
    };
    for (const i of this.near) {
      const k = KINDS[this.kind[i]], lx = this.xy[i * 2], ly = this.xy[i * 2 + 1];
      if (Math.abs(lx - x) > r + k.r || Math.abs(ly - y) > r + k.r || this.posts[i]?.down) continue;
      const colour = colourOf(this.kind[i], this.seeds[i]);
      // (Only the lamps up on poles and walls: not the floodlights or those in tunnels.)
      const post = this.posts[i];
      const z = this.height(lx, ly) + (this.rise[i] ?? 0);
      // Facing its street (once the street is known), a lamp on an arm or a wall lights the
      // street from the end of its arm, more of it along than across.
      const towards = (this.kind[i] === 0 || this.kind[i] === 1) && this.facing.has(i) ? this.facing.get(i)! : null;
      if (towards === null) add(lx, ly, z, 0, 1, 0, k.r, k.r, colour, k.i, k.raise || k.head < 3 ? 0 : k.head, (post && this.postIndex.get(post)) ?? -1, this.high[i]);
      else {
        const dx = Math.cos(towards), dy = Math.sin(towards), arm = POOL.arm[this.kind[i]];
        add(lx + dx * arm, ly + dy * arm, z, 0, dx, dy, k.r * POOL.across, k.r * POOL.along, colour, k.i, k.head, (post && this.postIndex.get(post)) ?? -1, this.high[i]);
      }
      if (fx && k.head >= 3) fx.lamp(lx, ly, z, k.head, colour, k.i, this.carGrid, this.blockAt, cars, this.carZ);
    }
    const d = this.dummy;
    cars.forEach((c, ci) => {
      if (c.mode === 'loose' && c.speed < 0.5) return; // parked: lights off
      const fx0 = Math.cos(c.h), fy = Math.sin(c.h), L = c.spec.L / 2, W = c.spec.W / 2;
      const z = this.carZ[ci], own = this.carIndex.get(c) ?? -1;
      // A smashed lamp is dark: with one headlamp left the beam is narrower and to its side.
      const broken = c.two ? 0 : c.broken ?? 0, heads = broken & 3, brake = c.braking ? 2.4 : 1;
      if (!heads) add(c.x + fx0 * L, c.y + fy * L, z, 1, fx0, fy, c.two ? 16 : 24, c.two ? 3 : 5, HEAD, c.two ? 1.2 : 2.2, 0.75, own);
      else if (heads < 3) {
        const across = (heads === 1 ? -1 : 1) * (W - 0.3);
        add(c.x + fx0 * L - fy * across, c.y + fy * L + fx0 * across, z, 1, fx0, fy, 22, 3.2, HEAD, 1.3, 0.75, own);
      }
      // The rear lights shine backwards onto the road from the bumper, a short beam from
      // each (not a round pool on the car, which would redden its roof and bonnet).
      for (const s of c.two ? [0] : [-1, 1]) {
        const across = s * (W - 0.3);
        if (!(broken & (s > 0 ? 4 : 8))) add(c.x - fx0 * L - fy * across, c.y - fy * L + fx0 * across, z, 1, -fx0, -fy, c.two ? 2 : 3.5, c.two ? 0.6 : 1.2, TAIL, (c.two ? 0.3 : 0.22) * brake, 0.75, own);
        if (fx && !(broken & (s > 0 ? 1 : 2))) fx.beam(c.x + fx0 * (L - 0.05) - fy * across, c.y + fy * (L - 0.05) + fx0 * across, z + 0.75, fx0, fy, c.two ? 11 : 16, c.two ? 1.3 : 1.9, HEAD, 1);
      }
      // Two headlights and two rear lights (one each on a bike).
      for (const [along, colour, size, left] of [[L - 0.05, HEAD, 0.9, 1], [-L - 0.05, TAIL, c.braking ? 0.8 : 0.5, 4]] as [number, THREE.Color, number, number][]) {
        for (const s of c.two ? [0] : [-1, 1]) {
          if (g >= this.glows.instanceMatrix.count) break;
          if (broken & (s > 0 ? left : left * 2)) continue;
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
    // Searchlights from the air: a pool on the ground whose shadows fall away from the light itself.
    for (const sp of opt.spots ?? []) {
      if (Math.abs(sp.tx - x) > r + SEARCH_R || Math.abs(sp.ty - y) > r + SEARCH_R) continue;
      const ground = this.height(sp.tx, sp.ty), up = Math.max(sp.z - ground, 1);
      add(sp.tx, sp.ty, ground, 4, sp.x - sp.tx, sp.y - sp.ty, SEARCH_R, SEARCH_R, SEARCH, 2.4, up, -1, false);
      if (fx) {
        const dx = sp.tx - sp.x, dy = sp.ty - sp.y, run = Math.hypot(dx, dy) || 1;
        fx.beam(sp.x, sp.y, sp.z, dx / run, dy / run, Math.hypot(run, up), SEARCH_R * 0.9, SEARCH, 1.2, Math.atan2(up, run));
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
    // The ground's lights once more with nothing in their way (LAMP_MAP_OPEN).
    const blocking = LAMP_SHADOWS.value;
    LAMP_REF.value.w = blocking > 0 ? 1 : 0;
    if (blocking > 0) {
      LAMP_SHADOWS.value = 0;
      renderer.setRenderTarget(this.targetOpen);
      renderer.clear(true, false, false);
      renderer.render(this.lightScene, this.lightCam);
      LAMP_SHADOWS.value = blocking;
    }
    renderer.setRenderTarget(before);
    renderer.setClearColor(clear, alpha);
    renderer.shadowMap.autoUpdate = shadows;
  }
}
