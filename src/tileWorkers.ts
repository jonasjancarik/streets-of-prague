import type { WorkerJobs, WorkerKind, WorkerResults, WorkerResponse } from './contracts.ts';

export type JobPriority = 'required' | 'optional';
export interface WorkerEndpoint {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null;
}

interface Job {
  id: number;
  type: WorkerKind;
  data: unknown | (() => unknown);
  transfer: Transferable[];
  priority: JobPriority;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  settled: boolean;
  cancelled: boolean;
}

export interface WorkerHandle<T> { promise: Promise<T>; cancel: () => void }

// A worker runs one job at a time. Optional neighbour lighting never occupies more
// than one worker, leaving the others ready for tile construction.
export class TileWorkers {
  readonly size: number;
  readonly stats = { completedRequired: 0, completedOptional: 0, failed: 0, cancelled: 0 };
  private readonly endpoints: (WorkerEndpoint | null)[];
  private readonly running: (Job | null)[];
  private readonly failures: number[];
  private readonly required: Job[] = [];
  private readonly optional: Job[] = [];
  private next = 0;
  private draining = false;

  constructor(n = Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 4) - 2)),
    private readonly makeWorker: () => WorkerEndpoint = () => new Worker(new URL('./tileWorker.ts', import.meta.url), { type: 'module' })) {
    this.size = n;
    this.endpoints = Array(n).fill(null);
    this.running = Array(n).fill(null);
    this.failures = Array(n).fill(0);
    for (let i = 0; i < n; i++) this.replace(i);
  }

  get counts() {
    return {
      queuedRequired: this.required.length, queuedOptional: this.optional.length,
      runningRequired: this.running.filter((j) => j?.priority === 'required').length,
      runningOptional: this.running.filter((j) => j?.priority === 'optional').length,
      ...this.stats,
    };
  }

  run<K extends WorkerKind>(type: K, data: WorkerJobs[K], transfer: Transferable[] = []): Promise<WorkerResults[K]> {
    return this.submit(type, data, transfer).promise;
  }

  submit<K extends WorkerKind>(type: K, data: WorkerJobs[K] | (() => WorkerJobs[K]),
    transfer: Transferable[] = [], priority: JobPriority = 'required'): WorkerHandle<WorkerResults[K]> {
    let job!: Job;
    const promise = new Promise<WorkerResults[K]>((resolve, reject) => {
      job = { id: this.next++, type, data, transfer, priority,
        resolve: (result) => resolve(result as WorkerResults[K]), reject, settled: false, cancelled: false };
      (priority === 'required' ? this.required : this.optional).push(job);
    });
    this.drain();
    return { promise, cancel: () => {
      if (job.settled || job.cancelled) return;
      job.cancelled = true;
      this.stats.cancelled++;
      const queue = job.priority === 'required' ? this.required : this.optional;
      const at = queue.indexOf(job);
      if (at >= 0) queue.splice(at, 1);
      this.settle(job, new Error('Tile worker job cancelled'));
      this.drain();
    } };
  }

  private settle(job: Job, error?: Error, result?: unknown) {
    if (job.settled) return;
    job.settled = true;
    if (error) job.reject(error);
    else job.resolve(result);
  }

  private replace(i: number) {
    if (this.failures[i] > 2) return;
    try {
      const w = this.makeWorker();
      this.endpoints[i] = w;
      w.onmessage = (event) => {
        const job = this.running[i];
        if (!job) return;
        const response = event.data as WorkerResponse;
        if (!response || response.id !== job.id || (typeof response.error !== 'string' && !('result' in response))) {
          this.retire(i, new Error(`Invalid tile worker response: expected ${job.id}, got ${response?.id}`));
          return;
        }
        this.running[i] = null;
        if (response.error) { this.stats.failed++; this.settle(job, new Error(response.error)); }
        else {
          this.stats[job.priority === 'required' ? 'completedRequired' : 'completedOptional']++;
          this.settle(job, undefined, response.result);
        }
        this.drain();
      };
      w.onerror = (event) => { event.preventDefault?.(); this.retire(i, new Error(event.message || 'Tile worker failed')); };
      w.onmessageerror = () => this.retire(i, new Error('Tile worker message failed'));
    } catch (error) {
      this.endpoints[i] = null;
      this.failures[i]++;
    }
  }

  private retire(i: number, error: Error) {
    const w = this.endpoints[i];
    if (!w) return;
    w.onmessage = w.onerror = w.onmessageerror = null;
    w.terminate();
    this.endpoints[i] = null;
    const job = this.running[i];
    this.running[i] = null;
    if (job) { this.stats.failed++; this.settle(job, error); }
    this.failures[i]++;
    this.replace(i);
    this.drain();
  }

  private drain() {
    if (this.draining) return;
    this.draining = true;
    try {
      for (let i = 0; i < this.size; i++) {
        const w = this.endpoints[i];
        if (!w || this.running[i]) continue;
        const job = this.required.shift() ?? (this.running.some((j) => j?.priority === 'optional') ? undefined : this.optional.shift());
        if (!job) continue;
        this.running[i] = job;
        try {
          const data = typeof job.data === 'function' ? job.data() : job.data;
          w.postMessage({ id: job.id, type: job.type, data }, job.transfer);
          job.transfer = []; // ownership moved exactly once
        } catch (error) {
          this.running[i] = null;
          this.stats.failed++;
          this.settle(job, error instanceof Error ? error : new Error(String(error)));
          i--; // the same worker remains idle and can take the next job
        }
      }
      if (this.endpoints.every((w) => !w)) {
        for (const job of [...this.required.splice(0), ...this.optional.splice(0)])
          this.settle(job, new Error('No tile workers available'));
      }
    } finally { this.draining = false; }
  }
}
