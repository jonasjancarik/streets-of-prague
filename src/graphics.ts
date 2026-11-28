import { STREET_DETAIL } from './streetHedges.ts';
import { CLOSE_RELIEF } from './streetSurface.ts';
import { wantStrips } from './reflections.ts';
import { PROBE_ON } from './probe.ts';
import { POST } from './post.ts';
import { CANOPY_LEAVES } from './trees.ts';
import { SOFT_SHADOWS, SHADOW_FILTER } from './softshadow.ts';
import { CAR_SHADE } from './car.ts';
import { PEOPLE_SHADOWS, type PeopleShadows } from './figures.ts';
import * as THREE from 'three';
import { DIRT, LEAVES, ROOF_DETAIL, ROOF_CLUTTER, WATER, WEATHER_DETAIL } from './shading.ts';
import { LAMP_SHADOWS, LAMP_SIZE, LIGHT_FX } from './lamps.ts';
import { MIRROR_ON } from './mirror.ts';
import { STREAKS_ON } from './streaks.ts';
import type { Sky } from './sky.ts';
import { t } from './i18n.ts';
import { slowHint } from './graphicswarning.ts';
import * as telemetry from './telemetry.ts';
import { startRetry } from './renderer.ts';
import { STREET_QUALITY, STREET_TIERS } from './streetQuality.ts';
import { setAnisotropy } from './textureQuality.ts';

// Graphics tiers keep the street surfaces and facade pictures at every level. High,
// Medium and Low keep the dirt, grime, leaves, tone curve and detailed roofs too.
// Pixel ratio scales shading; streetQuality.ts also scales close avatars, cars and
// tree branches, so lower tiers reduce geometry and CPU work at street level and in VR.
// Low also halves the sun shadow map.
// High and Ultra add relief and sheen up close to kerbs, stone steps, tram rails and
// rendered walls (CLOSE_RELIEF); Medium and below keep them flat.
// Ultra is High with a sun shadow map twice as sharp and softer shadow edges, and
// shadows in lamplight from people, trams and posts as well as cars.
// Auto goes up to Ultra only on a desktop or laptop with WebGPU, from a steady High whose
// frames' work (main thread or GPU, whichever is longer) takes under ULTRA_ROOM of the
// target, and only once a visit: Ultra's shadow filter rebuilds every lit shader, half a
// second's freeze each way, so a computer that can't hold it doesn't go back and forth.
// On Low and Lowest a person's shadow from the sun is a plain shape, not their own
// (PEOPLE_SHADOWS in figures.ts: about 1 ms of 25 a frame on a Pixel 5 on a full square).
// Lowest drops MSAA on WebGPU, roof detail and those looks, and halves the crowd (beyond
// the first 150 round you) and the cars driving about (Low has three quarters of the cars);
// it also leaves out the drifting mist, the mist over the river and the raindrops' rings
// in the puddles (the thin haze over the view, the rain and the wet ground stay).
// The water's waves and reflections (webgpu/water.ts) are a setting of their own: on with
// Ultra and off below it until the player chooses (at the river on an M5 at 2× they measured
// no cost: 8.6 against 8.5 ms a frame), and never drawn on Lowest; ?water=on|off
// overrides it for one visit.
// What the wet streets reflect is one too: nothing but the sky, the lights' streaks
// (streaks.ts, the default) or the whole scene in a mirror (mirror.ts, costly: a second
// render of it); ?reflections=none|lights|mirror overrides it for one visit. Never on Lowest.
// Roof clutter (shading.ts, ROOF_CLUTTER) is on at High and Ultra; ?clutter=on|off overrides
// that for one visit, to compare.
// Car shadows in lamplight go from full to soft to none (2 / 1 / 0); their light map is 2048
// texels across on High and Ultra (at 1024 a car's shadow stepped along the texels), 1024 below.
// Auto keeps the light map at the size it began with: a new size rebuilds every shader.
//
// Auto starts where telemetry says this kind of graphics chip ends up (autoStart), or else
// high (medium on touch devices), targets 40 FPS on a screen or the
// headset's refresh rate in XR, and judges windows of 60 frame times
// by their mean without the quickest and slowest tenth. That mean doesn't see hitches,
// so it also adds up the time spent in frames over 50 ms: two windows in a row that
// spend a quarter of their time in them step down too, and a choppy window never steps
// up. It ignores pauses, tile builds and the seconds after loading, returning to the
// tab or changing a tier.
// A tier that proved too slow is tried again after 2 minutes, then 4, 8…
// A slow window whose frames were mostly waiting is held, not stepped down: the browser
// or the screen is holding the frame rate down (Chrome's Energy Saver caps it at 30, some
// screens run at 30 Hz), and less detail wouldn't bring it up. On WebGPU a frame's work is
// the longer of the main thread's part (the whole frame up to handing it to the GPU) and
// the GPU's (from then to the GPU saying it has finished, onSubmittedWorkDone): the two
// overlap, and the slower one sets the pace. When that takes under half the time between
// frames, the frame could have come twice as often: it was waiting. Telemetry showed fast
// GPUs dropped to Lowest at a steady 33 ms. WebGL has no such timing and steps down as
// before. The GPU's answer comes late (on an M5 at pixel ratio 2 it took 10 ms at Low and
// 13 at High, far closer together than their pixel counts), and a GPU still busy with the
// last frame makes it later still, so the timing errs towards busy. Timed from the start
// of drawing instead, the drawing counted twice: under a 30 cap there even Low read as
// busy, and Auto still went down to Low.
// Still too slow on Lowest for STUCK windows in a row, it tells the player once
// (graphicswarning.ts: the game needs a better computer, and what may help).
// The choice is remembered; ?graphics=auto|ultra|high|medium|low|lowest overrides it for
// one visit. ?dpr fixes only the pixel ratio, leaving the other tier settings intact.
// WebGL keeps its startup MSAA: it cannot change that without a new renderer.
//
// Custom puts every one of these switches in the player's hands (the settings' Display
// tab), starting from the level they were on, and lets some go past Ultra: the screen's
// full pixel ratio (up to 3), a sun shadow map 8192 texels across and detailed models
// reaching half as far again (STREET_TIERS.max). It is kept as 'graphicsCustom'. Code
// elsewhere that asks for `tier` sees Ultra, so nothing else is held back.
export const REFLECTIONS = ['none', 'lights', 'mirror'] as const;
export type Reflections = typeof REFLECTIONS[number];
export type Tier = 'lowest' | 'low' | 'medium' | 'high' | 'ultra';
export type Choice = Tier | 'auto' | 'custom';
const ORDER: Tier[] = ['lowest', 'low', 'medium', 'high', 'ultra']; // (Auto's)
export const CHOICES: Choice[] = ['auto', 'ultra', 'high', 'medium', 'low', 'lowest', 'custom'];
// `cars`: what gets in the way of the lamps' light at night: 3 cars, people, trams and
// posts cast shadows from every lamp and headlight, 2 only the cars do, 1 a soft darkening
// round each car, 0 nothing. `lights`: the cones and glints.
// `shadowBlur`: how far the sun shadow's edge is softened, in shadow-map texels.
// `crowd`: how many people are about beyond the first 150 round you, times the usual
// (half on Lowest; Custom from a quarter to double; main.ts, peopleWanted). `traffic`: how many cars drive about, times the usual (three quarters
// on Low, half on Lowest; Custom from a quarter to double). Buses, parked cars and the
// police aren't counted. Standing in third person on the Old Town Square, each car cost
// about 45 µs of the main thread a frame and each person about 3.5 µs, nearly all of it
// their simulation.
// `sunEveryFrame`: the sun's shadow map drawn every frame. Off on every tier: it's drawn
// once SHADOW_MS have passed since the last (main.ts), every other frame at 60 fps, which
// saved 7–9% of the main thread in the street view. Custom can draw it every frame.
// `view`: how far you see along the street in first and third person (m; the haze on
// the far streets moves with it, and only the tiles that far are drawn). Overhead the
// screen decides. `aniso`: anisotropic filtering, times what each texture was made with
// (textureQuality.ts; 0 off). `textures`: the pictures at full size or half
// (textureQuality.ts, from the next start). Auto keeps the filtering it began with: a
// change uploads the textures again.
type Settings = { look: boolean; maxRatio: number; samples: 0 | 4; shadowSize: number; shadowBlur: number; sunEveryFrame: boolean; roofs: boolean; clutter: boolean; crowd: number; traffic: number; cars: 0 | 1 | 2 | 3; lights: boolean; lampMap: 1024 | 2048; people: PeopleShadows; view: number; aniso: number; textures: 'full' | 'half' };
const TIERS: Record<Tier, Settings> = {
  ultra: { look: true, maxRatio: 2, samples: 4, shadowSize: 4096, shadowBlur: 2, sunEveryFrame: false, roofs: true, clutter: true, crowd: 1, traffic: 1, cars: 3, lights: true, lampMap: 2048, people: 'full', view: 500, aniso: 2, textures: 'full' },
  high: { look: true, maxRatio: 2, samples: 4, shadowSize: 2048, shadowBlur: 1, sunEveryFrame: false, roofs: true, clutter: true, crowd: 1, traffic: 1, cars: 2, lights: true, lampMap: 2048, people: 'full', view: 400, aniso: 1, textures: 'full' },
  medium: { look: true, maxRatio: 1.5, samples: 4, shadowSize: 2048, shadowBlur: 1, sunEveryFrame: false, roofs: true, clutter: false, crowd: 1, traffic: 1, cars: 1, lights: false, lampMap: 1024, people: 'full', view: 400, aniso: 1, textures: 'full' },
  low: { look: true, maxRatio: 1, samples: 4, shadowSize: 1024, shadowBlur: 1, sunEveryFrame: false, roofs: true, clutter: false, crowd: 1, traffic: 0.75, cars: 1, lights: false, lampMap: 1024, people: 'simple', view: 300, aniso: 0.5, textures: 'full' },
  lowest: { look: false, maxRatio: 1, samples: 0, shadowSize: 1024, shadowBlur: 1, sunEveryFrame: false, roofs: false, clutter: false, crowd: 0.5, traffic: 0.5, cars: 0, lights: false, lampMap: 1024, people: 'simple', view: 250, aniso: 0, textures: 'half' },
};

// The switches a tier sets on its own (apply), which Custom lets the player set one by one.
type Extras = { post: boolean; ao: number; probe: boolean; canopy: boolean; streetDetail: boolean; closeRelief: boolean; softShadows: boolean };
const extras = (t: Tier): Extras => {
  const top = t === 'ultra', high = top || t === 'high';
  return { post: high, ao: 0, probe: top, canopy: high, streetDetail: high || t === 'medium', closeRelief: high, softShadows: top };
};
// `street`: whose close-up budgets (streetQuality.ts) to use, 'max' going past Ultra's;
// `ground`: the longest edge of the ground's triangles (m) in tiles built from then on.
// `above`: Custom only, the street models in the overhead view as well (main.ts), while
// zoomed in to ABOVE_HEIGHT.
export type StreetLevel = keyof typeof STREET_TIERS;
export type Custom = Settings & Extras & { street: StreetLevel; ground: number; above: boolean };
export const customFrom = (t: Tier): Custom => ({ ...TIERS[t], ...extras(t), street: t, ground: STREET_TIERS[t].groundFine, above: false });
// How high the overhead camera may be for `above` (m: 100 is the usual zoom on foot), and
// how far round the middle of the view the street models reach there at most.
export const ABOVE_HEIGHT = 180, ABOVE_REACH = 140;
// The most Custom's crowd and traffic factors may be, typed in (settings.ts).
export const MOST_FACTOR = 10;
function loadCustom(): Custom | null {
  try {
    const saved = JSON.parse(localStorage.getItem('graphicsCustom') ?? 'null');
    // (Anything missing, or added since it was saved, comes from Ultra.)
    if (saved && typeof saved === 'object') return { ...customFrom('ultra'), ...saved, street: (saved.street ?? '') in STREET_TIERS ? saved.street : 'ultra' };
  } catch {}
  return null;
}

// three r186 has no public sample setter. Its tone-mapping pass caches a target
// with the startup samples, so _samples alone changes nothing on screen. Update
// just the canvas target; three resizes its MSAA attachments on the next render.
// Disposing it here would invalidate depth textures still used by compileAsync.
type GPURenderer = THREE.WebGLRenderer & {
  backend?: { isWebGPUBackend?: boolean; device?: { queue: { onSubmittedWorkDone(): Promise<void> } } };
  _samples: number;
  _canvasTarget: unknown;
  _frameBufferTargets: Map<unknown, THREE.RenderTarget>;
};
function setSamples(renderer: THREE.WebGLRenderer, samples: number) {
  const r = renderer as GPURenderer;
  if (!r.backend?.isWebGPUBackend) return;
  r._samples = samples;
  const target = r._frameBufferTargets.get(r._canvasTarget);
  if (target) target.samples = samples;
}

const TARGET_MS = 1000 / 40;  // 40 frames a second
const STEADY = 0.9; // 90% of frames within 3/4 of the target can step up
const SAMPLES = 60;
const LONGEST = 250;          // longer isn't averaged in…
const PAUSE = 1000;           // …and longer still is a pause (a dialog, the debugger), not a hitch
const CHOPPY = 0.25, CHOPPY_WINDOWS = 2; // a quarter of its time in them is choppy: two in a row step down
const WARMUP = 4000, SETTLE = 3000, RETRY = 120000;
const STUCK = 5;
const WAITING = 0.5; // a frame whose work took under half its time was waiting
const ULTRA_ROOM = 0.4; // High's work in under 10 ms a frame (of 25) can step up to Ultra

// Where Auto starts on graphics chips whose sessions mostly ended up lower (or, on touch
// screens, higher) than the usual start: the median of where Auto had settled a minute or
// more into the game, from 45 days of telemetry to 25 Nov 2026 (sessions per chip in brackets).
// Starting there saves a stretch of slow frames, or of waiting to step up. Chips not listed
// start as before. The names are the WebGPU adapter's vendor and architecture, or WebGL's.
const AUTO_START: [RegExp, Tier][] = [
  [/^intel gen-(9|12lp)$/, 'lowest'], // gen-9: all of 29 on Lowest; gen-12lp: 70% of 95
  [/^qualcomm adreno-6xx$/, 'lowest'], // 86% of 15
  [/^arm valhall$|^mali-/i, 'low'], // Valhall: 58% of 71 on Low or Lowest; Mali-T760 on WebGL: 64% of 17
  [/^adreno \(tm\) 6/i, 'low'], // Adreno 650 on WebGL: 58% of 34
  [/^intel\(r\) hd graphics/i, 'medium'], // on WebGL, 59% of 31 at Medium or below
  [/^apple$|^qualcomm adreno-[78]xx$/, 'high'], // phones and tablets: 67% of 146 iPhones and iPads, 57% of 40 and 76% of 34 Adrenos on High
];
export function autoStart(gpu: string, touch: boolean): Tier {
  const name = gpu.replace(/, or similar$/, '');
  return AUTO_START.find(([chip]) => chip.test(name))?.[1] ?? (touch ? 'medium' : 'high');
}

// The choice of graphics before the game has its Graphics: ?graphics, else the one saved.
export function savedChoice(params: URLSearchParams): Choice {
  let saved: string | null = null;
  try { saved = localStorage.getItem('graphics'); } catch {}
  const pick = (c: string | null) => (CHOICES as string[]).includes(c ?? '') ? c as Choice : null;
  return pick(params.get('graphics')) ?? pick(saved) ?? 'auto';
}

export class AutoTier {
  tier: Tier;
  private targetMs = TARGET_MS;
  private samples: number[] = [];
  private spent = 0;  // the window's time (ms)…
  private stalled = 0; // …and how much of it went in hitches
  private choppy = 0; // windows in a row that were
  private worked: number[] = []; // how long each frame's work took, where the renderer says
  capped = 0; // slow windows held because their frames were waiting
  private holdUntil = 0;
  stuck = 0; // windows in a row too slow with no tier lower to go to
  private failures: Record<Tier, number> = { lowest: 0, low: 0, medium: 0, high: 0, ultra: 0 };
  private retryAt: Record<Tier, number> = { lowest: 0, low: 0, medium: 0, high: 0, ultra: 0 };
  // Skip a tier only when all of its effective settings are the same.
  private same: (a: Tier, b: Tier) => boolean;

  constructor(start: Tier, same: (a: Tier, b: Tier) => boolean, readonly top: Tier = 'high') {
    this.tier = start;
    this.same = same;
  }

  // Headsets need a frame per refresh. Start a fresh window when entering/leaving
  // XR so the desktop's 40 FPS target and its failed tiers do not carry over.
  target(ms: number, now: number) {
    if (ms === this.targetMs) return;
    this.targetMs = ms;
    for (const tier of ORDER) this.failures[tier] = this.retryAt[tier] = 0;
    this.hold(now, SETTLE);
  }

  // Ignore frames for a while (loading, a change, coming back to the tab).
  hold(now: number, ms: number) {
    this.holdUntil = Math.max(this.holdUntil, now + ms);
    this.samples.length = this.worked.length = 0;
    this.spent = this.stalled = this.choppy = 0;
  }

  // How long one frame's work took (Graphics.rendered).
  work(ms: number, now: number) {
    if (now >= this.holdUntil && this.worked.length < SAMPLES * 2) this.worked.push(ms);
  }

  // One frame's time; the new tier when it's time to change.
  record(ms: number, now: number): Tier | null {
    if (ms > PAUSE || now < this.holdUntil) return null;
    this.spent += ms;
    if (ms > this.targetMs * 2) this.stalled += ms;
    if (ms > LONGEST) return null;
    this.samples.push(ms);
    if (this.samples.length < SAMPLES) return null;
    const sorted = [...this.samples].sort((a, b) => a - b);
    const trim = sorted.slice(SAMPLES / 10, -SAMPLES / 10);
    const mean = trim.reduce((a, b) => a + b, 0) / trim.length;
    const choppy = this.stalled > this.spent * CHOPPY;
    const steady = !choppy && sorted.filter((t) => t <= this.targetMs * .75).length >= sorted.length * STEADY;
    this.choppy = choppy ? this.choppy + 1 : 0;
    const median = (a: number[]) => [...a].sort((x, y) => x - y)[a.length >> 1];
    const timed = this.worked.length >= SAMPLES / 2, work = timed ? median(this.worked) : Infinity;
    const waiting = timed && work < median(sorted) * WAITING;
    const slow = mean > this.targetMs * 1.1 && !waiting;
    if (mean > this.targetMs * 1.1 && waiting) this.capped++;
    this.samples.length = this.worked.length = 0;
    this.spent = this.stalled = 0;
    const step = (dir: 1 | -1, from = this.tier): Tier | null => {
      for (let i = ORDER.indexOf(from) + dir; i >= 0 && i < ORDER.length; i += dir) {
        if (!this.same(ORDER[i], from)) return ORDER[i];
      }
      return null;
    };
    let next: Tier | null = null;
    // (Under half the frame rate wanted, two tiers down at once: one wouldn't be enough.)
    const lower = step(-1), up = step(1), muchLower = lower && mean > this.targetMs * 2 && !waiting ? step(-1, lower) : null, higher = up && ORDER.indexOf(up) <= ORDER.indexOf(this.top)
      && (up !== 'ultra' || (!this.failures.ultra && this.targetMs === TARGET_MS && work < this.targetMs * ULTRA_ROOM)) ? up : null;
    this.stuck = slow && !lower ? this.stuck + 1 : 0;
    if ((slow || this.choppy >= CHOPPY_WINDOWS) && lower) {
      this.failures[this.tier] += 1;
      this.retryAt[this.tier] = now + RETRY * 2 ** (this.failures[this.tier] - 1);
      next = muchLower ?? lower;
    } else if (higher && steady && now >= this.retryAt[higher]) next = higher;
    if (!next) return null;
    this.tier = next;
    this.hold(now, SETTLE);
    return next;
  }
}

export class Graphics {
  choice: Choice;
  tier: Tier;
  // The player's choice of water, or null to follow the graphics tier.
  private waterChoice: boolean | null = null;
  get water() { return this.waterChoice ?? this.tier !== 'lowest'; }
  reflections: Reflections = 'lights';
  private clutter: boolean | null = null; // ?clutter=on|off
  private auto: AutoTier;
  private renderer: THREE.WebGLRenderer;
  private sky: Sky;
  private fixedRatio: number | null;
  private applied = false;
  private presenting = false;
  // The player's own settings (Custom), once they have chosen it.
  custom: Custom | null = loadCustom();
  // How many times the usual crowd the page has room for (main.ts sizes the crowd's buffers
  // at load, for the saved Custom crowd and at least double): more takes a reload.
  crowdRoom = 2;

  // (`gpu`: the graphics chip's name, for where Auto starts.)
  constructor(renderer: THREE.WebGLRenderer, sky: Sky, params: URLSearchParams, gpu = '') {
    this.renderer = renderer;
    this.sky = sky;
    this.fixedRatio = Number(params.get('dpr')) || null;
    try { const w = localStorage.getItem('water'); if (w) this.waterChoice = w === 'on'; } catch {}
    if (params.has('water')) this.waterChoice = params.get('water') !== 'off';
    try { const r = localStorage.getItem('reflections'); if (REFLECTIONS.includes(r as Reflections)) this.reflections = r as Reflections; } catch {}
    const r = params.get('reflections');
    if (REFLECTIONS.includes(r as Reflections)) this.reflections = r as Reflections;
    if (params.has('clutter')) this.clutter = params.get('clutter') !== 'off';
    this.choice = savedChoice(params);
    const touch = matchMedia('(pointer: coarse)').matches;
    // After a start the graphics broke, this tab stays on Low at most (renderer.ts, startRetry);
    // a setting chosen above Low is held there too, without changing what is saved.
    const retried = startRetry() !== '';
    if (retried && this.choice !== 'auto' && (this.choice === 'custom' || CHOICES.indexOf(this.choice) < CHOICES.indexOf('low'))) this.choice = 'low';
    const webgpu = !!(renderer as unknown as GPURenderer).backend?.isWebGPUBackend;
    this.auto = new AutoTier(retried ? 'low' : autoStart(gpu, touch), (a, b) => this.same(a, b), retried ? 'low' : touch || !webgpu ? 'high' : 'ultra');
    this.tier = this.choice === 'auto' ? this.auto.tier : this.choice === 'custom' ? 'ultra' : this.choice;
    if (this.choice === 'custom' && !this.custom) this.custom = customFrom('ultra');
    this.apply();
    document.addEventListener('visibilitychange', () => { if (!document.hidden) this.auto.hold(performance.now(), WARMUP); });
  }

  // The level Auto is at (or would start at, with another setting chosen).
  get autoTier() { return this.auto.tier; }

  // The game has loaded: start judging frames after a few seconds.
  started(now: number) { this.auto.hold(now, WARMUP); }

  private ratio(t: Tier) { return this.fixedRatio ?? Math.min(devicePixelRatio, this.settings(t).maxRatio); }
  // What is drawn: the tier's settings, or the player's own on Custom.
  private settings(t = this.tier): Custom { return this.choice === 'custom' && this.custom && t === this.tier ? this.custom : customFrom(t); }
  private same(a: Tier, b: Tier) {
    const x = TIERS[a], y = TIERS[b];
    return x.look === y.look && x.view === y.view && x.cars === y.cars && x.lights === y.lights && x.lampMap === y.lampMap && x.shadowSize === y.shadowSize && x.shadowBlur === y.shadowBlur
      && x.roofs === y.roofs && x.clutter === y.clutter && x.crowd === y.crowd && x.traffic === y.traffic && x.people === y.people
      && (!(this.renderer as GPURenderer).backend?.isWebGPUBackend || x.samples === y.samples)
      && (this.renderer.xr.isPresenting || this.ratio(a) === this.ratio(b))
      && STREET_TIERS[a].avatars === STREET_TIERS[b].avatars && STREET_TIERS[a].treeWood === STREET_TIERS[b].treeWood
      && STREET_TIERS[a].carReach === STREET_TIERS[b].carReach;
  }

  // Fewer people on Lowest, with the usual off-screen retirement (no popping).
  get crowd() { return this.settings().crowd; }
  // How many cars drive about, times the usual (Custom).
  get traffic() { return this.settings().traffic; }
  // Whether the sun's shadow map is drawn every frame (main.ts).
  get sunEveryFrame() { return this.settings().sunEveryFrame; }
  // How far you see from the street (m).
  get viewDistance() { return this.settings().view; }
  // Whether the overhead view gets the street models (Custom).
  get above() { return this.choice === 'custom' && !!this.custom?.above; }
  // In the overhead view with `above` on, the street models reach `radius` m round the
  // middle of the view (at least the tier's own reach); null puts the tier's reach back.
  private reaching: number | null = null;
  overhead(radius: number | null) {
    if (radius !== null) radius = Math.min(ABOVE_REACH, Math.round(radius / 5) * 5);
    if (radius === this.reaching) return;
    this.reaching = radius;
    this.street();
  }
  private street() {
    const own = this.settings(), q = STREET_TIERS[own.street], r = this.reaching ?? 0;
    Object.assign(STREET_QUALITY, q, { groundFine: own.ground,
      avatarReach: Math.max(q.avatarReach, r), carReach: Math.max(q.carReach, r), wallReach: Math.max(q.wallReach, r), castings: Math.max(q.castings, r) });
  }

  private apply() {
    const own = this.settings();
    this.street();
    if (this.choice !== 'auto' || !this.applied) setAnisotropy(own.aniso);
    const { look, samples, shadowBlur, roofs, clutter, cars, lights, lampMap, people } = own;
    // (Custom's 8192 only where the graphics chip takes a texture that large.)
    const gpu = this.renderer as GPURenderer & { backend?: { device?: { limits?: { maxTextureDimension2D?: number } } }; capabilities?: { maxTextureSize?: number } };
    const shadowSize = Math.min(own.shadowSize, gpu.backend?.device?.limits?.maxTextureDimension2D ?? gpu.capabilities?.maxTextureSize ?? 4096);
    DIRT.value = LEAVES.value = look ? 1 : 0;
    WATER.value = look && this.water ? 1 : 0;
    this.sky.curve = look;
    LAMP_SHADOWS.value = cars;
    LIGHT_FX.value = lights ? 1 : 0;
    // (Not on Lowest.)
    STREAKS_ON.value = look && this.reflections === 'lights' ? 1 : 0;
    MIRROR_ON.value = look && this.reflections === 'mirror' ? 1 : 0;
    wantStrips(look); // (the cars' mirrored streets)
    PROBE_ON.value = own.probe ? 1 : 0;
    POST.value = own.post ? 1 : 0;
    POST.aoValue = Math.min(3, Number(own.ao) || 0); // (ambient shading from depth, 0 to 3: Custom only; one saved as on is light)
    CAR_SHADE.value = look ? 1 : 0; // (the soft shade under the cars: car.ts)
    PEOPLE_SHADOWS.tier = people; // (what a person casts in the sun: figures.ts)
    CANOPY_LEAVES.value = own.canopy;
    // The street view's hedge leaves and blades of grass (streetHedges.ts, streetGrass.ts): Medium and up.
    STREET_DETAIL.value = own.streetDetail;
    CLOSE_RELIEF.value = own.closeRelief ? 1 : 0;
    // (The lamps resize their maps at the next frame; the materials are bound afresh below,
    // which freezes the game for half a second even on an M5, so Auto keeps the size the
    // lamps were given when it began.)
    // The shadows' edges widening with distance (softshadow.ts): Ultra's own shadow filter,
    // put on the sun's shadow only while Ultra is chosen. Its code would otherwise sit in
    // every material's shader at every tier, and a phone's GPU pays for it even where a
    // switch skips it (a Pixel 5 at Medium: 15 frames a second with it, 32 without).
    // A change of filter is a change of every lit shader: see the rebuild below.
    SOFT_SHADOWS.tier = own.softShadows ? 1 : 0;
    const sunShadow = this.sky.sun.shadow as unknown as { filterNode?: unknown };
    const filter = SOFT_SHADOWS.value > 0 ? SHADOW_FILTER.value ?? null : null;
    const refiltered = (sunShadow.filterNode ?? null) !== filter;
    if (refiltered) sunShadow.filterNode = filter;
    const first = !this.applied;
    const lampSize = this.choice === 'auto' && this.applied ? LAMP_SIZE.value : lampMap, resized = LAMP_SIZE.value !== lampSize;
    LAMP_SIZE.value = lampSize;
    this.applied = true;
    ROOF_DETAIL.value = roofs ? 1 : 0;
    WEATHER_DETAIL.value = look ? 1 : 0;
    ROOF_CLUTTER.value = (this.clutter ?? clutter) ? 1 : 0;
    setSamples(this.renderer, samples);
    const shadow = this.sky.sun.shadow;
    shadow.radius = shadowBlur;
    if (shadow.mapSize.x !== shadowSize || shadow.mapSize.y !== shadowSize) {
      shadow.mapSize.set(shadowSize, shadowSize);
      // WebGPU resizes the shadow target itself, and the materials bind the new depth
      // texture by themselves; WebGL needs a new one.
      if (!(this.renderer as GPURenderer).backend) { shadow.map?.dispose(); shadow.map = null; }
    }
    if ((resized || (refiltered && !first)) && (this.renderer as GPURenderer).backend) {
      // The materials don't notice the lamps' maps being replaced and would go on
      // sampling the destroyed ones. Release their render caches once so every binding
      // is made afresh, including stationary objects. Materials remain reusable.
      const materials = new Set<THREE.Material>();
      this.sky.sun.parent?.traverse((o) => {
        const m = (o as THREE.Mesh).material;
        if (Array.isArray(m)) for (const item of m) materials.add(item);
        else if (m) materials.add(m);
      });
      for (const material of materials) material.dispose();
    }
    const r = this.ratio(this.tier);
    if (!this.renderer.xr.isPresenting && this.renderer.getPixelRatio() !== r) this.renderer.setPixelRatio(r);
  }

  setReflections(r: Reflections) {
    this.reflections = r;
    try { localStorage.setItem('reflections', r); } catch {}
    this.apply();
  }

  setWater(on: boolean) {
    this.waterChoice = on;
    try { localStorage.setItem('water', on ? 'on' : 'off'); } catch {}
    this.apply();
  }

  set(choice: Choice) {
    this.choice = choice;
    try { localStorage.setItem('graphics', choice); } catch {}
    if (choice === 'auto') {
      this.auto.tier = this.tier === 'ultra' && this.auto.top !== 'ultra' ? 'high' : this.tier;
      this.tier = this.auto.tier;
      this.auto.hold(performance.now(), SETTLE);
    } else if (choice === 'custom') {
      // The first time, from what was being drawn.
      if (!this.custom) this.custom = customFrom(this.tier);
      this.tier = 'ultra';
    } else this.tier = choice;
    this.apply();
  }

  // Change some of Custom's settings (and choose Custom, if it wasn't).
  setCustom(change: Partial<Custom>) {
    if (this.choice !== 'custom') this.set('custom');
    this.custom = { ...this.custom!, ...change };
    try { localStorage.setItem('graphicsCustom', JSON.stringify(this.custom)); } catch {}
    this.apply();
  }

  // What draws the game, for a feedback message.
  get api() {
    const b = (this.renderer as GPURenderer).backend;
    return b?.isWebGPUBackend ? 'WebGPU' : b ? 'WebGL 2 (no WebGPU here)' : 'WebGL';
  }

  // The next choice in turn (the G key).
  cycle() { this.set(CHOICES[(CHOICES.indexOf(this.choice) + 1) % CHOICES.length]); }

  // `busy`: map tiles are being built, so this frame doesn't count.
  frame(ms: number, now: number, busy = false) {
    if (this.presenting !== this.renderer.xr.isPresenting) {
      this.presenting = this.renderer.xr.isPresenting;
      if (!this.presenting) this.apply(); // restore the desktop canvas to Auto's current tier
    }
    const session = this.renderer.xr.isPresenting ? this.renderer.xr.getSession() as (XRSession & { frameRate?: number }) | null : null;
    this.auto.target(this.renderer.xr.isPresenting ? 1000 / (session?.frameRate || 60) : TARGET_MS, now);
    if (this.choice !== 'auto' || busy) return;
    const capped = this.auto.capped;
    const next = this.auto.record(ms, now);
    if (this.auto.capped !== capped) telemetry.count('cappedWindows');
    if (next) { this.tier = next; this.apply(); }
    if (this.auto.stuck >= STUCK) slowHint();
  }

  // The frame that began at `began` has been handed to the GPU: on WebGPU, its work is the
  // longer of the main thread's part and the GPU's. `gpu` hears the GPU's part.
  rendered(began: number, gpu?: (ms: number) => void) {
    const device = (this.renderer as GPURenderer).backend?.device;
    if (!device) return;
    const sent = performance.now(), auto = this.choice === 'auto';
    device.queue.onSubmittedWorkDone().then(() => {
      const now = performance.now();
      gpu?.(now - sent);
      if (auto) this.auto.work(Math.max(sent - began, now - sent), now);
    }, () => {});
  }

  label() {
    const name = (k: string) => t(k[0].toUpperCase() + k.slice(1));
    return this.choice === 'auto' ? t('Graphics: Auto ({tier} now)', { tier: name(this.tier).toLowerCase() }) : t('Graphics: {name}', { name: name(this.choice) });
  }

  // What the picture is drawn with, for the developer panel's "Copy this situation"
  // (testkit.ts): the level, the one Auto is on now, or Custom's settings where they
  // aren't Ultra's (as they are kept in 'graphicsCustom').
  describe() {
    if (this.choice === 'auto') return `auto graphics (${this.tier} now)`;
    if (this.choice !== 'custom') return `${this.choice} graphics`;
    const ultra: Record<string, unknown> = customFrom('ultra');
    const own = Object.entries(this.settings()).filter(([k, v]) => ultra[k] !== v).map(([k, v]) => `${k} ${v}`);
    return own.length ? `custom graphics (Ultra but ${own.join(', ')})` : 'custom graphics (as Ultra)';
  }
}
