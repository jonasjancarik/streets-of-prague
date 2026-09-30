import type { WorkerHandle } from './tileWorkers.ts';

// One refresh request covers every neighbour change before dispatch. A later
// request while the worker is busy schedules just one follow-up calculation.
export class SkyRefresh<T> {
  requested = 0;
  applied = 0;
  coalesced = 0;
  cancelled = 0;
  running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private handle: WorkerHandle<T> | null = null;
  private disposed = false;
  private revision = 0;

  constructor(private readonly submit: (started: () => void) => WorkerHandle<T>,
    private readonly apply: (result: T) => void,
    private readonly delay = 400) {}

  request() {
    if (this.disposed) return;
    this.requested++;
    if (this.handle) { this.coalesced++; return; }
    if (this.timer) { clearTimeout(this.timer); this.coalesced++; }
    this.timer = setTimeout(() => { this.timer = null; this.start(); }, this.delay);
  }

  private start() {
    if (this.disposed || this.handle) return;
    // The callback runs at worker dispatch, so queued refreshes use the latest
    // neighbour shapes and the revision that goes with them.
    const handle = this.submit(() => { this.running = true; this.revision = this.requested; });
    this.handle = handle;
    handle.promise.then((result) => {
      if (!this.disposed && this.revision === this.requested) {
        this.apply(result);
        this.applied = this.revision;
      }
    }).catch(() => { /* another neighbour change is the controlled retry */ }).finally(() => {
      if (this.handle !== handle) return;
      this.handle = null;
      this.running = false;
      if (!this.disposed && this.revision !== this.requested) this.start();
    });
  }

  drop() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; this.cancelled++; }
    if (this.handle) { this.handle.cancel(); this.cancelled++; }
  }
}
