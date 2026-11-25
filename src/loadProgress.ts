// How far the game has got with loading, as a share and the seconds left, for the start
// screen's button (startscreen.ts) and the loading line.
//
// Loading goes through stages in a known order. Each has a typical duration (TYPICAL),
// replaced on later visits by how long it took on this device last time. The time left is
// the rest of the stages' durations at the pace of those done so far, more when the
// current one runs long. The share is the time so far over that plus the time left, so
// the bar and the seconds agree.

import { t, tn } from './i18n.ts';

export type Stage = 'map' | 'graphics' | 'models' | 'streets' | 'setup' | 'view' | 'move' | 'people';

// Milliseconds a stage typically takes on a first visit. Telemetry's median load to the
// start screen is about 17 s (Nov 2026), shared out by the stages' times measured in
// headless Chrome, fast and at 20 Mbit/s. The start report now sends each stage's time
// (telemetry.ts), to set these from what players see.
const TYPICAL: Record<Stage, number> = {
  map: 1000, graphics: 2000, models: 300, streets: 7500, setup: 300, view: 5000, move: 4000, people: 1500,
};
const KEY = 'loadTimes';
// How sure the typical times are: until about this much time has gone by in finished
// stages, the pace leans towards the typical one.
const PRIOR = 3000;

export type Progress = (share: number, secondsLeft: number | null) => void;

export class LoadProgress {
  private t0 = performance.now();
  private expected: Record<Stage, number>;
  private took: Partial<Record<Stage, number>> = {};
  private stage: Stage | null = null;
  private stageAt = 0;
  private done = 0;
  private total = 0;
  private shown = 0;
  private left: number | null = null;
  private timer = 0;
  // (For scripts: each moment's stage, share and seconds left, in window.__loadLog.)
  readonly log: [number, Stage, number, number][] = [];

  constructor(private stages: Stage[], private report: Progress) {
    this.expected = { ...TYPICAL };
    try {
      const last = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Record<Stage, number>>;
      for (const s of stages) if (typeof last[s] === 'number' && last[s]! > 0) this.expected[s] = last[s]!;
    } catch { /* storage is optional */ }
    this.timer = window.setInterval(() => this.tick(), 200);
    (window as { __loadLog?: unknown }).__loadLog = this.log;
  }

  // A stage begins (and the one before it has ended).
  begin(stage: Stage) {
    const now = performance.now();
    if (this.stage) this.took[this.stage] = now - this.stageAt;
    this.stage = stage;
    this.stageAt = now;
    this.done = this.total = 0;
    this.tick();
  }

  // How much of the stage is done, for stages that can count (tiles).
  count(done: number, total: number) {
    this.done = done;
    this.total = total;
  }

  // Loading is over: remember how long each stage took, for next time.
  finish() {
    if (this.stage) this.took[this.stage] = performance.now() - this.stageAt;
    this.stage = null;
    clearInterval(this.timer);
    try {
      const last = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, number>;
      localStorage.setItem(KEY, JSON.stringify({ ...last, ...this.took }));
    } catch { /* storage is optional */ }
    this.report(1, 0);
  }

  // (For scripts: how long each stage took.)
  get times() { return { ...this.took }; }

  private tick() {
    if (!this.stage) return;
    const now = performance.now(), elapsed = now - this.t0, inStage = now - this.stageAt;
    // The pace so far: real milliseconds a typical one in the finished stages, leaning
    // towards 1 while little is done.
    let took = 0, typicalDone = 0;
    for (const s of this.stages) if (this.took[s] !== undefined) { took += this.took[s]!; typicalDone += this.expected[s]; }
    // (Its square root, and within half to twice: the first stages are mostly downloads and
    // the last mostly the graphics card's, so a slow start says only so much about the rest.)
    const pace = Math.min(2, Math.max(0.5, Math.sqrt((took + PRIOR) / (typicalDone + PRIOR))));
    // This stage: what its expected time leaves; once past that, a quarter of the time it
    // has taken so far (a stage running long will likely run longer still). A count, as
    // the map's tiles have, can only shorten it: tiles mostly come in together at the end.
    const expected = this.expected[this.stage] * pace;
    let left = inStage < expected ? expected - inStage : inStage * 0.25;
    if (this.total > 0 && this.done > 0) left = Math.min(left, expected * (1 - this.done / this.total));
    for (let i = this.stages.indexOf(this.stage) + 1; i < this.stages.length; i++) left += this.expected[this.stages[i]] * pace;
    left = Math.max(left, 150);
    this.shown = Math.max(this.shown, Math.min(0.99, elapsed / (elapsed + left)));
    // The seconds, eased so they don't jump about.
    this.left = this.left === null ? left : this.left * 0.85 + left * 0.15;
    this.log.push([Math.round(elapsed), this.stage, +this.shown.toFixed(3), Math.round(left)]);
    this.report(this.shown, elapsed > 1500 ? this.left / 1000 : null);
  }


}

// "About 20 seconds left", rounded the way people would say it.
export function leftLabel(seconds: number | null) {
  if (seconds === null) return '';
  if (seconds < 3) return t('Almost there');
  if (seconds < 60) return tn(seconds < 15 ? Math.ceil(seconds) : Math.ceil(seconds / 5) * 5, 'About {n} second left|About {n} seconds left');
  return tn(Math.round(seconds / 60), 'About {n} minute left|About {n} minutes left');
}
