import type { Car } from './car.ts';

export interface Obstacle {
  x: number; y: number; z?: number; r: number; vx: number; vy: number; kind: string; car?: Car;
}
export interface RestingObstacle extends Obstacle { car: Car }
interface Snapshot {
  x: number; y: number; h: number; gz?: number; r: number; vx: number; vy: number; kind: string;
  offsets: number[]; offsetsRef: readonly number[]; n: number;
}
interface Entry { shapes: RestingObstacle[]; buckets: number[]; snapshot: Snapshot; order: number; seen: number }

// The same numeric cells and traversal as SpatialHash.near. Entry identity survives
// no-op scans; removal uses the old cells, before a car's new pose is indexed.
export class RestingCars {
  readonly map = new Map<number, RestingObstacle[]>();
  readonly entries = new Map<Car, Entry>();
  readonly stats = { scans: 0, changedCars: 0, removedCars: 0, allocatedCircles: 0, unchangedCars: 0, touchedBuckets: 0 };
  last = { indexedCars: 0, changedCars: 0, removedCars: 0, allocatedCircles: 0, touchedBuckets: 0 };
  private generation = 0;
  constructor(readonly cell = 10) {}

  near(x: number, y: number, r: number, out: Obstacle[] = []): Obstacle[] {
    const c = this.cell, i0 = Math.floor((x - r) / c), i1 = Math.floor((x + r) / c), j0 = Math.floor((y - r) / c), j1 = Math.floor((y + r) / c);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const b = this.map.get(i * 131072 + j);
      if (b) for (let k = 0; k < b.length; k++) out.push(b[k]);
    }
    return out;
  }

  // Start again from nothing (the next sync indexes every resting car).
  reset() {
    this.map.clear();
    this.entries.clear();
  }

  private key(x: number, y: number) {
    return Math.floor(x / this.cell) * 131072 + Math.floor(y / this.cell);
  }

  private remove(car: Car, entry: Entry, touched: Set<number>) {
    for (let i = 0; i < entry.shapes.length; i++) {
      const key = entry.buckets[i], bucket = this.map.get(key);
      if (!bucket) throw new Error('Resting-car bucket missing');
      const at = bucket.indexOf(entry.shapes[i]);
      if (at < 0) throw new Error('Resting-car obstacle missing');
      bucket.splice(at, 1);
      if (!bucket.length) this.map.delete(key);
      else touched.add(key);
    }
    this.entries.delete(car);
    car.resting = false;
    this.stats.removedCars++;
  }

  sync(loose: Car[], moving: (car: Car) => boolean) {
    // Most steps change no resting car. Match the old cheap scan before touching
    // Map entries or bucket state; any arrival, departure, pose or obstacle-field
    // change takes the exact incremental update path below.
    let count = 0, stale = false;
    for (const car of loose) {
      if (moving(car)) { stale ||= !!car.resting; continue; }
      count++;
      const at = car.restAt, fields = car.restFields;
      stale ||= !car.resting || !at || at[0] !== car.x || at[1] !== car.y || at[2] !== car.h ||
        !fields || fields.gz !== car.gz || fields.r !== car.r || fields.vx !== car.vx || fields.vy !== car.vy ||
        fields.offsetsRef !== car.offsets || fields.n !== car.offsets.length;
    }
    this.stats.scans++;
    if (!stale && count === this.entries.size) {
      this.stats.unchangedCars += count;
      this.last.indexedCars = count;
      this.last.changedCars = this.last.removedCars = this.last.allocatedCircles = this.last.touchedBuckets = 0;
      return this.last;
    }
    const generation = ++this.generation;
    const touched: { buckets: Set<number> | null } = { buckets: null };
    let seenResting = 0;
    const changedBuckets = () => (touched.buckets ??= new Set<number>());
    const changedBefore = this.stats.changedCars, removedBefore = this.stats.removedCars, allocatedBefore = this.stats.allocatedCircles;
    for (let order = 0; order < loose.length; order++) {
      const car = loose[order];
      const old = this.entries.get(car);
      if (moving(car)) {
        if (old) this.remove(car, old, changedBuckets());
        car.resting = false;
        continue;
      }
      seenResting++;
      const kind = car.mode === 'player' ? 'player' : 'car';
      const s = old?.snapshot;
      let changed = !s || s.x !== car.x || s.y !== car.y || s.h !== car.h || s.gz !== car.gz ||
        s.r !== car.r || s.vx !== car.vx || s.vy !== car.vy || s.kind !== kind || s.offsets.length !== car.offsets.length;
      if (!changed && s) for (let i = 0; i < s.offsets.length; i++) if (s.offsets[i] !== car.offsets[i]) { changed = true; break; }
      if (!changed && old) {
        old.seen = generation;
        old.order = order;
        car.resting = true;
        this.stats.unchangedCars++;
        continue;
      }
      if (old) this.remove(car, old, changedBuckets());
      const shapes: RestingObstacle[] = [], buckets: number[] = [];
      for (const [x, y] of car.circles()) {
        const shape = { x, y, z: car.gz, r: car.r, vx: car.vx, vy: car.vy, kind, car };
        const key = this.key(x, y);
        let bucket = this.map.get(key);
        if (!bucket) this.map.set(key, (bucket = []));
        bucket.push(shape);
        shapes.push(shape);
        buckets.push(key);
        changedBuckets().add(key);
      }
      const snapshot: Snapshot = { x: car.x, y: car.y, h: car.h, gz: car.gz, r: car.r, vx: car.vx, vy: car.vy,
        kind, offsets: car.offsets.slice(), offsetsRef: car.offsets, n: car.offsets.length };
      this.entries.set(car, { shapes, buckets, snapshot, order, seen: generation });
      car.resting = true;
      car.restAt = [car.x, car.y, car.h];
      car.restFields = snapshot;
      this.stats.changedCars++;
      this.stats.allocatedCircles += shapes.length;
    }
    if (seenResting !== this.entries.size)
      for (const [car, entry] of this.entries) if (entry.seen !== generation) this.remove(car, entry, changedBuckets());
    // Only cells touched by changed cars are reordered. Existing loose cars keep
    // relative order when another car is spliced out or a tile is appended.
    for (const key of touched.buckets ?? []) {
      const bucket = this.map.get(key);
      if (!bucket) continue;
      const circle = new Map<RestingObstacle, number>();
      for (const shape of bucket) {
        const entry = this.entries.get(shape.car)!;
        circle.set(shape, entry.shapes.indexOf(shape));
      }
      bucket.sort((a, b) => {
        const ea = this.entries.get(a.car)!, eb = this.entries.get(b.car)!;
        return ea.order - eb.order || circle.get(a)! - circle.get(b)!;
      });
    }
    this.stats.touchedBuckets += touched.buckets?.size ?? 0;
    return this.last = { indexedCars: this.entries.size, changedCars: this.stats.changedCars - changedBefore,
      removedCars: this.stats.removedCars - removedBefore,
      allocatedCircles: this.stats.allocatedCircles - allocatedBefore, touchedBuckets: touched.buckets?.size ?? 0 };
  }
}
