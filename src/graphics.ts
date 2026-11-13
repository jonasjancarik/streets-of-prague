import { wantStrips } from './reflections.ts';
import { PROBE_ON } from './probe.ts';
import { POST } from './post.ts';
import * as THREE from 'three';
import { DIRT, LEAVES, ROOF_DETAIL, ROOF_CLUTTER, WATER, WEATHER_DETAIL } from './shading.ts';
import { LAMP_SHADOWS, LAMP_SIZE, LIGHT_FX } from './lamps.ts';
import { MIRROR_ON } from './mirror.ts';
import { STREAKS_ON } from './streaks.ts';
import type { Sky } from './sky.ts';
import { t } from './i18n.ts';
import { slowHint } from './graphicswarning.ts';
import * as telemetry from './telemetry.ts';

// Graphics tiers keep the street surfaces and facade pictures at every level. High,
// Medium and Low keep the dirt, grime, leaves, tone curve and detailed roofs too.
// The pixel ratio does most of the GPU scaling; Low also halves the sun shadow map.
// Ultra is High with a sun shadow map twice as sharp and softer shadow edges, and more
// from the lights at night: a light map twice as sharp, shadows from people, trams and
// posts as well as cars, cones of light in the air and glints on cars and wet ground.
// Only choosing it turns it on, Auto goes no higher than High.
// Lowest drops MSAA on WebGPU, roof detail and those looks, and halves the crowd cap;
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
// Auto starts high (medium on touch devices) and judges windows of 60 frame times
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
export const REFLECTIONS = ['none', 'lights', 'mirror'] as const;
export type Reflections = typeof REFLECTIONS[number];
export type Tier = 'lowest' | 'low' | 'medium' | 'high' | 'ultra';
export type Choice = Tier | 'auto';
const ORDER: Tier[] = ['lowest', 'low', 'medium', 'high']; // (Auto's)
export const CHOICES: Choice[] = ['auto', 'ultra', 'high', 'medium', 'low', 'lowest'];
// `cars`: what gets in the way of the lamps' light at night: 3 cars, people, trams and
// posts cast shadows from every lamp and headlight, 2 only the cars do, 1 a soft darkening
// round each car, 0 nothing. `lights`: the cones and glints, and the sharper light map.
// `shadowBlur`: how far the sun shadow's edge is softened, in shadow-map texels.
const TIERS: Record<Tier, { look: boolean; maxRatio: number; samples: 0 | 4; shadowSize: number; shadowBlur: number; roofs: boolean; clutter: boolean; crowd: number; cars: 0 | 1 | 2 | 3; lights: boolean; lampMap: 1024 | 2048 }> = {
  ultra: { look: true, maxRatio: 2, samples: 4, shadowSize: 4096, shadowBlur: 2, roofs: true, clutter: true, crowd: 1, cars: 3, lights: true, lampMap: 2048 },
  high: { look: true, maxRatio: 2, samples: 4, shadowSize: 2048, shadowBlur: 1, roofs: true, clutter: true, crowd: 1, cars: 2, lights: false, lampMap: 2048 },
  medium: { look: true, maxRatio: 1.5, samples: 4, shadowSize: 2048, shadowBlur: 1, roofs: true, clutter: false, crowd: 1, cars: 1, lights: false, lampMap: 1024 },
  low: { look: true, maxRatio: 1, samples: 4, shadowSize: 1024, shadowBlur: 1, roofs: true, clutter: false, crowd: 1, cars: 1, lights: false, lampMap: 1024 },
  lowest: { look: false, maxRatio: 1, samples: 0, shadowSize: 1024, shadowBlur: 1, roofs: false, clutter: false, crowd: 0.5, cars: 0, lights: false, lampMap: 1024 },
};

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
const SLOW = TARGET_MS * 1.1; // a window whose average frame is slower steps down
const QUICK = TARGET_MS * 0.75, STEADY = 0.9; // …and one with 90% of its frames within 3/4 of the target can step up
const SAMPLES = 60;
const LONGEST = 250;          // longer isn't averaged in…
const PAUSE = 1000;           // …and longer still is a pause (a dialog, the debugger), not a hitch
const HITCH = TARGET_MS * 2;  // a frame this long (50 ms) is a hitch, and a window that spends
const CHOPPY = 0.25, CHOPPY_WINDOWS = 2; // a quarter of its time in them is choppy: two in a row step down
const WARMUP = 4000, SETTLE = 3000, RETRY = 120000;
const STUCK = 5;
const WAITING = 0.5; // a frame whose work took under half its time was waiting

export class AutoTier {
  tier: Tier;
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

  constructor(start: Tier, same: (a: Tier, b: Tier) => boolean) {
    this.tier = start;
    this.same = same;
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
    if (ms > HITCH) this.stalled += ms;
    if (ms > LONGEST) return null;
    this.samples.push(ms);
    if (this.samples.length < SAMPLES) return null;
    const sorted = [...this.samples].sort((a, b) => a - b);
    const trim = sorted.slice(SAMPLES / 10, -SAMPLES / 10);
    const mean = trim.reduce((a, b) => a + b, 0) / trim.length;
    const choppy = this.stalled > this.spent * CHOPPY;
    const steady = !choppy && sorted.filter((t) => t <= QUICK).length >= sorted.length * STEADY;
    this.choppy = choppy ? this.choppy + 1 : 0;
    const median = (a: number[]) => [...a].sort((x, y) => x - y)[a.length >> 1];
    const waiting = this.worked.length >= SAMPLES / 2 && median(this.worked) < median(sorted) * WAITING;
    const slow = mean > SLOW && !waiting;
    if (mean > SLOW && waiting) this.capped++;
    this.samples.length = this.worked.length = 0;
    this.spent = this.stalled = 0;
    const step = (dir: 1 | -1) => {
      for (let i = ORDER.indexOf(this.tier) + dir; i >= 0 && i < ORDER.length; i += dir) {
        if (!this.same(ORDER[i], this.tier)) return ORDER[i];
      }
      return null;
    };
    let next: Tier | null = null;
    const lower = step(-1), higher = step(1);
    this.stuck = slow && !lower ? this.stuck + 1 : 0;
    if ((slow || this.choppy >= CHOPPY_WINDOWS) && lower) {
      this.failures[this.tier] += 1;
      this.retryAt[this.tier] = now + RETRY * 2 ** (this.failures[this.tier] - 1);
      next = lower;
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
  // The player's choice of water, or null while they haven't made one (then Ultra has the waves).
  private waterChoice: boolean | null = null;
  get water() { return this.waterChoice ?? this.tier === 'ultra'; }
  reflections: Reflections = 'lights';
  private clutter: boolean | null = null; // ?clutter=on|off
  private auto: AutoTier;
  private renderer: THREE.WebGLRenderer;
  private sky: Sky;
  private fixedRatio: number | null;
  private applied = false;

  constructor(renderer: THREE.WebGLRenderer, sky: Sky, params: URLSearchParams) {
    this.renderer = renderer;
    this.sky = sky;
    this.fixedRatio = Number(params.get('dpr')) || null;
    let saved: string | null = null;
    try { saved = localStorage.getItem('graphics'); } catch {}
    try { const w = localStorage.getItem('water'); if (w) this.waterChoice = w === 'on'; } catch {}
    if (params.has('water')) this.waterChoice = params.get('water') !== 'off';
    try { const r = localStorage.getItem('reflections'); if (REFLECTIONS.includes(r as Reflections)) this.reflections = r as Reflections; } catch {}
    const r = params.get('reflections');
    if (REFLECTIONS.includes(r as Reflections)) this.reflections = r as Reflections;
    if (params.has('clutter')) this.clutter = params.get('clutter') !== 'off';
    const asked = params.get('graphics');
    const pick = (c: string | null) => (CHOICES as string[]).includes(c ?? '') ? c as Choice : null;
    this.choice = pick(asked) ?? pick(saved) ?? 'auto';
    const touch = matchMedia('(pointer: coarse)').matches;
    this.auto = new AutoTier(touch ? 'medium' : 'high', (a, b) => this.same(a, b));
    this.tier = this.choice === 'auto' ? this.auto.tier : this.choice;
    this.apply();
    document.addEventListener('visibilitychange', () => { if (!document.hidden) this.auto.hold(performance.now(), WARMUP); });
  }

  // The game has loaded: start judging frames after a few seconds.
  started(now: number) { this.auto.hold(now, WARMUP); }

  private ratio(t: Tier) { return this.fixedRatio ?? Math.min(devicePixelRatio, TIERS[t].maxRatio); }
  private same(a: Tier, b: Tier) {
    const x = TIERS[a], y = TIERS[b];
    return x.look === y.look && x.cars === y.cars && x.lights === y.lights && x.lampMap === y.lampMap && x.shadowSize === y.shadowSize && x.shadowBlur === y.shadowBlur
      && x.roofs === y.roofs && x.clutter === y.clutter && x.crowd === y.crowd
      && (!(this.renderer as GPURenderer).backend?.isWebGPUBackend || x.samples === y.samples)
      && this.ratio(a) === this.ratio(b);
  }

  // Fewer people on Lowest, with the usual off-screen retirement (no popping).
  get crowd() { return TIERS[this.tier].crowd; }

  private apply() {
    const { look, samples, shadowSize, shadowBlur, roofs, clutter, cars, lights, lampMap } = TIERS[this.tier];
    DIRT.value = LEAVES.value = look ? 1 : 0;
    WATER.value = look && this.water ? 1 : 0;
    this.sky.curve = look;
    LAMP_SHADOWS.value = cars;
    LIGHT_FX.value = lights ? 1 : 0;
    // (Not on Lowest.)
    STREAKS_ON.value = look && this.reflections === 'lights' ? 1 : 0;
    MIRROR_ON.value = look && this.reflections === 'mirror' ? 1 : 0;
    wantStrips(look); // (the cars' mirrored streets)
    PROBE_ON.value = this.tier === 'ultra' ? 1 : 0;
    POST.value = this.tier === 'ultra' ? 1 : 0; // (and the bloom: post.ts) // (and on Ultra the real one round the middle of the view)
    // (The lamps resize their maps at the next frame; the materials are bound afresh below,
    // which freezes the game for half a second even on an M5, so Auto keeps the size the
    // lamps were given when it began.)
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
    if (resized && (this.renderer as GPURenderer).backend) {
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
    if (this.renderer.getPixelRatio() !== r) this.renderer.setPixelRatio(r);
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
      this.auto.tier = this.tier === 'ultra' ? 'high' : this.tier;
      this.tier = this.auto.tier;
      this.auto.hold(performance.now(), SETTLE);
    } else this.tier = choice;
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
    const name = (k: Tier) => t(k[0].toUpperCase() + k.slice(1));
    return this.choice === 'auto' ? t('Graphics: Auto ({tier} now)', { tier: name(this.tier).toLowerCase() }) : t('Graphics: {name}', { name: name(this.choice) });
  }
}
