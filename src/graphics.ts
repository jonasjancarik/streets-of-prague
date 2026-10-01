import * as THREE from 'three';
import { DIRT, LEAVES, ROOF_DETAIL } from './shading.ts';
import { LAMP_SHADOWS, LAMP_SIZE, LIGHT_FX } from './lamps.ts';
import type { Sky } from './sky.ts';
import { t } from './i18n.ts';

// Graphics tiers keep the street surfaces and facade pictures at every level. High,
// Medium and Low keep the dirt, grime, leaves, tone curve and detailed roofs too.
// The pixel ratio does most of the GPU scaling; Low also halves the sun shadow map.
// Ultra is High with a sun shadow map twice as sharp and softer shadow edges, and more
// from the lights at night: a light map twice as sharp, shadows from people, trams and
// posts as well as cars, cones of light in the air and glints on cars and wet ground.
// Only choosing it turns it on, Auto goes no higher than High.
// Lowest drops MSAA on WebGPU, roof detail and those looks, and halves the crowd cap.
// Car shadows in lamplight go from full to soft to none (2 / 1 / 0).
//
// Auto starts high (medium on touch devices) and judges windows of 60 frame times
// by their mean without the quickest and slowest tenth. It ignores pauses, tile
// builds and the seconds after loading, returning to the tab or changing a tier.
// A tier that proved too slow is tried again after 2 minutes, then 4, 8…
// The choice is remembered; ?graphics=auto|ultra|high|medium|low|lowest overrides it for
// one visit. ?dpr fixes only the pixel ratio, leaving the other tier settings intact.
// WebGL keeps its startup MSAA: it cannot change that without a new renderer.
export type Tier = 'lowest' | 'low' | 'medium' | 'high' | 'ultra';
export type Choice = Tier | 'auto';
const ORDER: Tier[] = ['lowest', 'low', 'medium', 'high']; // (Auto's)
const CHOICES: Choice[] = ['auto', 'ultra', 'high', 'medium', 'low', 'lowest'];
// `cars`: what gets in the way of the lamps' light at night: 3 cars, people, trams and
// posts cast shadows from every lamp and headlight, 2 only the cars do, 1 a soft darkening
// round each car, 0 nothing. `lights`: the cones and glints, and the sharper light map.
// `shadowBlur`: how far the sun shadow's edge is softened, in shadow-map texels.
const TIERS: Record<Tier, { look: boolean; maxRatio: number; samples: 0 | 4; shadowSize: number; shadowBlur: number; roofs: boolean; crowd: number; cars: 0 | 1 | 2 | 3; lights: boolean }> = {
  ultra: { look: true, maxRatio: 2, samples: 4, shadowSize: 4096, shadowBlur: 2, roofs: true, crowd: 1, cars: 3, lights: true },
  high: { look: true, maxRatio: 2, samples: 4, shadowSize: 2048, shadowBlur: 1, roofs: true, crowd: 1, cars: 2, lights: false },
  medium: { look: true, maxRatio: 1.5, samples: 4, shadowSize: 2048, shadowBlur: 1, roofs: true, crowd: 1, cars: 1, lights: false },
  low: { look: true, maxRatio: 1, samples: 4, shadowSize: 1024, shadowBlur: 1, roofs: true, crowd: 1, cars: 1, lights: false },
  lowest: { look: false, maxRatio: 1, samples: 0, shadowSize: 1024, shadowBlur: 1, roofs: false, crowd: 0.5, cars: 0, lights: false },
};

// three r186 has no public sample setter. Its tone-mapping pass caches a target
// with the startup samples, so _samples alone changes nothing on screen. Update
// just the canvas target; three resizes its MSAA attachments on the next render.
// Disposing it here would invalidate depth textures still used by compileAsync.
type GPURenderer = THREE.WebGLRenderer & {
  backend?: { isWebGPUBackend?: boolean };
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
const LONGEST = 250;          // longer is a pause, not a slow frame
const WARMUP = 4000, SETTLE = 3000, RETRY = 120000;

export class AutoTier {
  tier: Tier;
  private samples: number[] = [];
  private holdUntil = 0;
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
    this.samples.length = 0;
  }

  // One frame's time; the new tier when it's time to change.
  record(ms: number, now: number): Tier | null {
    if (ms > LONGEST || now < this.holdUntil) return null;
    this.samples.push(ms);
    if (this.samples.length < SAMPLES) return null;
    const sorted = [...this.samples].sort((a, b) => a - b);
    const trim = sorted.slice(SAMPLES / 10, -SAMPLES / 10);
    const mean = trim.reduce((a, b) => a + b, 0) / trim.length;
    const steady = sorted.filter((t) => t <= QUICK).length >= sorted.length * STEADY;
    this.samples.length = 0;
    const step = (dir: 1 | -1) => {
      for (let i = ORDER.indexOf(this.tier) + dir; i >= 0 && i < ORDER.length; i += dir) {
        if (!this.same(ORDER[i], this.tier)) return ORDER[i];
      }
      return null;
    };
    let next: Tier | null = null;
    const lower = step(-1), higher = step(1);
    if (mean > SLOW && lower) {
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
  private auto: AutoTier;
  private renderer: THREE.WebGLRenderer;
  private sky: Sky;
  private fixedRatio: number | null;

  constructor(renderer: THREE.WebGLRenderer, sky: Sky, params: URLSearchParams) {
    this.renderer = renderer;
    this.sky = sky;
    this.fixedRatio = Number(params.get('dpr')) || null;
    let saved: string | null = null;
    try { saved = localStorage.getItem('graphics'); } catch {}
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
    return x.look === y.look && x.cars === y.cars && x.lights === y.lights && x.shadowSize === y.shadowSize && x.shadowBlur === y.shadowBlur
      && x.roofs === y.roofs && x.crowd === y.crowd
      && (!(this.renderer as GPURenderer).backend?.isWebGPUBackend || x.samples === y.samples)
      && this.ratio(a) === this.ratio(b);
  }

  // Fewer people on Lowest, with the usual off-screen retirement (no popping).
  get crowd() { return TIERS[this.tier].crowd; }

  private apply() {
    const { look, samples, shadowSize, shadowBlur, roofs, cars, lights } = TIERS[this.tier];
    DIRT.value = LEAVES.value = look ? 1 : 0;
    this.sky.curve = look;
    LAMP_SHADOWS.value = cars;
    LIGHT_FX.value = lights ? 1 : 0;
    // (The lamps resize their maps at the next frame; the materials are bound afresh below.)
    const lampSize = lights ? 2048 : 1024, resized = LAMP_SIZE.value !== lampSize;
    LAMP_SIZE.value = lampSize;
    ROOF_DETAIL.value = roofs ? 1 : 0;
    setSamples(this.renderer, samples);
    const shadow = this.sky.sun.shadow;
    shadow.radius = shadowBlur;
    if (shadow.mapSize.x !== shadowSize || shadow.mapSize.y !== shadowSize || resized) {
      shadow.mapSize.set(shadowSize, shadowSize);
      // WebGPU resizes the shadow target itself; WebGL needs a new one.
      if (!(this.renderer as GPURenderer).backend) { shadow.map?.dispose(); shadow.map = null; }
      else {
        // Converted legacy materials don't observe the shadow texture's resize.
        // Release their render caches once so every binding is made for the new
        // texture, including stationary objects. Materials remain reusable.
        const materials = new Set<THREE.Material>();
        this.sky.sun.parent?.traverse((o) => {
          const m = (o as THREE.Mesh).material;
          if (Array.isArray(m)) for (const item of m) materials.add(item);
          else if (m) materials.add(m);
        });
        for (const material of materials) material.dispose();
      }
    }
    const r = this.ratio(this.tier);
    if (this.renderer.getPixelRatio() !== r) this.renderer.setPixelRatio(r);
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
    const next = this.auto.record(ms, now);
    if (next) { this.tier = next; this.apply(); }
  }

  label() {
    const name = (k: Tier) => t(k[0].toUpperCase() + k.slice(1));
    return this.choice === 'auto' ? t('Graphics: Auto ({tier} now)', { tier: name(this.tier).toLowerCase() }) : t('Graphics: {name}', { name: name(this.choice) });
  }
}
