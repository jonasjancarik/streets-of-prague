// Why a frame came late, for the anonymous statistics (docs/telemetry.md): each frame
// interval over 100 ms, a stutter the player feels, is put down to one cause.
//
// An interval is the time from one frame to the next, so what made it long is the work of
// the frame before (timed here in parts: the map tiles' update, the drawing, the rest of
// the game), the GPU's part of that frame (WebGPU only), and whatever ran between the two
// frames. The drawing belongs to the shaders when it built one, and to the tiles when it
// drew a tile for the first time. Chrome and Edge report the scripts between frames as long
// animation frames: a worker's reply is a map tile being put together, a three.js script a
// shader being made ready. Other browsers don't, so a long gap there with nothing timed is
// 'unknown', and one where Chrome saw no script is 'waiting' (the browser, its GPU process,
// garbage collection or the system).
//
// The cause is the main-thread part that took longest, if it took at least BLAME of the
// interval; failing that the GPU, if its part did. (The GPU's answer comes late whenever
// the main thread is busy, so its time holds the main thread's too and can't be compared
// with the parts above.) Long animation frames are reported a little after the frame they
// describe, so each hitch is decided SETTLE ms later.
import * as telemetry from './telemetry.ts';

const HITCH = 100;  // as telemetry.ts
const PAUSE = 2000; // longer is the tab coming back, not a frame
const BLAME = 0.4;
const SETTLE = 1000;

export type Cause = 'shaders' | 'tiles' | 'drawing' | 'game' | 'scripts' | 'gpu' | 'waiting' | 'unknown';
const COUNT: Record<Cause, string> = {
  shaders: 'hitchShaders', tiles: 'hitchTiles', drawing: 'hitchDrawing', game: 'hitchGame', scripts: 'hitchScripts',
  gpu: 'hitchGpu', waiting: 'hitchWaiting', unknown: 'hitchUnknown',
};

interface Frame { began: number; ended: number; work: number; tiles: number; joined: boolean; render: number; built: boolean; gpu: number }
interface Script { start: number; ms: number; cause: 'shaders' | 'tiles' | 'scripts' }
interface Script_ { invokerType?: string; invoker?: string; sourceURL?: string; startTime: number; duration: number }

export function scriptCause(s: { invoker?: string; sourceURL?: string }): Script['cause'] {
  if (/three/i.test(s.sourceURL ?? '')) return 'shaders';
  if (/Worker/.test(s.invoker ?? '')) return 'tiles';
  return 'scripts';
}

// Which part made a long interval, from the frame before it and the scripts between.
export function parts(before: Frame, scripts: Script[]) {
  const p = { shaders: 0, tiles: before.tiles, drawing: 0, game: before.work - before.tiles - before.render, scripts: 0 };
  p[before.built ? 'shaders' : before.joined ? 'tiles' : 'drawing'] += before.render;
  for (const s of scripts) p[s.cause] += s.ms;
  return p;
}
export function blame(ms: number, before: Frame, scripts: Script[], scriptsSeen: boolean): Cause {
  const p = parts(before, scripts), enough = ms * BLAME;
  let most: Cause | null = null;
  for (const c of ['shaders', 'tiles', 'drawing', 'game', 'scripts'] as const) if (p[c] >= enough && (!most || p[c] > p[most as keyof typeof p])) most = c;
  return most ?? (before.gpu >= enough ? 'gpu' : scriptsSeen ? 'waiting' : 'unknown');
}

export class Hitches {
  readonly counts: Record<Cause, number> = { shaders: 0, tiles: 0, drawing: 0, game: 0, scripts: 0, gpu: 0, waiting: 0, unknown: 0 };
  // The last few hitches with their parts, to look at (window.__drive.hitches.recent).
  readonly recent: { at: number; ms: number; cause: Cause; parts: Record<string, number> }[] = [];
  private now: Frame | null = null;
  private waiting: { ms: number; before: Frame; from: number; to: number }[] = [];
  private scripts: Script[] = [];
  private scriptsSeen = false;

  // `builds`: how many shaders the renderer has built so far.
  constructor(private builds: () => number) {
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) for (const s of ((e as unknown as { scripts?: Script_[] }).scripts ?? [])) {
          if (s.invokerType === 'user-callback' && s.invoker === 'FrameRequestCallback') continue; // the game's own frame, timed here
          this.scripts.push({ start: s.startTime, ms: s.duration, cause: scriptCause(s) });
        }
      }).observe({ type: 'long-animation-frame', buffered: false });
      this.scriptsSeen = true;
    } catch {}
  }

  // The start of a frame, `ms` after the one before.
  begin(ms: number) {
    const t = performance.now();
    this.decide(t);
    if (this.now && ms > HITCH && ms <= PAUSE) this.waiting.push({ ms, before: this.now, from: this.now.ended, to: t });
    this.now = { began: t, ended: t, work: 0, tiles: 0, joined: false, render: 0, built: false, gpu: 0 };
  }
  // The tiles' update, and whether a tile joined the scene since the frame before.
  tiles(ms: number, joined: boolean) { if (this.now) { this.now.tiles += ms; this.now.joined ||= joined; } }
  // The drawing, which may build shaders on its way.
  render(draw: () => void) {
    const f = this.now;
    if (!f) { draw(); return; }
    const n = this.builds(), t = performance.now();
    draw();
    f.render += performance.now() - t;
    if (this.builds() > n) f.built = true;
  }
  end() {
    const f = this.now;
    if (f) { f.ended = performance.now(); f.work = f.ended - f.began; }
    return f;
  }
  // The GPU's part of a frame (submit to done), reported later.
  gpu(f: Frame | null, ms: number) { if (f) f.gpu = ms; }

  private decide(t: number) {
    while (this.waiting.length && t - this.waiting[0].to > SETTLE) {
      const h = this.waiting.shift()!;
      const between = this.scripts.filter((s) => s.start >= h.from && s.start < h.to);
      const cause = blame(h.ms, h.before, between, this.scriptsSeen);
      this.counts[cause]++;
      telemetry.hitch(COUNT[cause]);
      const p: Record<string, number> = { ...parts(h.before, between), gpu: h.before.gpu };
      for (const k in p) p[k] = Math.round(p[k]);
      this.recent.push({ at: Math.round(h.to), ms: Math.round(h.ms), cause, parts: p });
      if (this.recent.length > 40) this.recent.shift();
    }
    const keep = this.waiting.length ? this.waiting[0].from : t - SETTLE;
    while (this.scripts.length && this.scripts[0].start < keep) this.scripts.shift();
  }
}
