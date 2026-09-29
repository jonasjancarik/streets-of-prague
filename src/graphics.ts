import * as THREE from 'three';
import { DIRT, LEAVES } from './shading.ts';
import type { Sky } from './sky.ts';
import { t } from './i18n.ts';

// Graphics: how sharp the picture is (the pixel ratio, up to the screen's own) and
// whether the costlier looks are on: the tone curve, dirt on the paving and grime on
// the walls, and the small leaves on the trees. Switching them recompiles nothing
// (they're uniforms), so it's instant.
//
// Auto (the default) starts high (medium on touch devices) and moves a tier down
// while frames are too slow and back up once they've been steady, the way
// hussite-wars-threejs does it: frames are judged in windows of 60 by their average
// (without the slowest and quickest tenth; not the median, as there: with the display's
// refresh every frame takes either 16.7 or 33.3 ms, so 45 frames a second has a median
// of 33.3),
// ignoring pauses, frames while map tiles are being built (their hitches aren't the
// graphics'), and the first seconds after loading, coming back to the tab or a change. A tier that proved too slow is tried again only after 2 minutes, then 4, 8…
// The choice is remembered in the browser; ?graphics=auto|high|medium|low overrides
// it for one visit (also lowest), and ?dpr fixes the pixel ratio whatever the tier.

// The pixel ratio is what counts: the looks cost 12–20% of a frame at 2× on a big
// screen but a few % at 1×, where the frame waits on the CPU rather than the GPU
// (measured in the Petřín woods at 2880×1800 on an M5). So they go only in the last
// tier, for weak GPUs.
export type Tier = 'lowest' | 'low' | 'medium' | 'high';
export type Choice = Tier | 'auto';
const ORDER: Tier[] = ['lowest', 'low', 'medium', 'high'];
const CHOICES: Choice[] = ['auto', 'high', 'medium', 'low', 'lowest'];
const TIERS: Record<Tier, { look: boolean; maxRatio: number }> = {
  high: { look: true, maxRatio: 2 },
  medium: { look: true, maxRatio: 1.5 },
  low: { look: true, maxRatio: 1 },
  lowest: { look: false, maxRatio: 1 },
};

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
  private failures: Record<Tier, number> = { lowest: 0, low: 0, medium: 0, high: 0 };
  private retryAt: Record<Tier, number> = { lowest: 0, low: 0, medium: 0, high: 0 };
  // Tiers that would change nothing here (on a 1× screen high and medium are the same).
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
  private same(a: Tier, b: Tier) { return TIERS[a].look === TIERS[b].look && this.ratio(a) === this.ratio(b); }

  private apply() {
    const { look } = TIERS[this.tier];
    DIRT.value = LEAVES.value = look ? 1 : 0;
    this.sky.curve = look;
    const r = this.ratio(this.tier);
    if (this.renderer.getPixelRatio() !== r) this.renderer.setPixelRatio(r);
  }

  set(choice: Choice) {
    this.choice = choice;
    try { localStorage.setItem('graphics', choice); } catch {}
    if (choice === 'auto') {
      this.auto.tier = this.tier;
      this.auto.hold(performance.now(), SETTLE);
    } else this.tier = choice;
    this.apply();
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
