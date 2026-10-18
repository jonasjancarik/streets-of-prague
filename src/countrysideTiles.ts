// The main thread's side of the countryside past the built map (countryside.ts, plan
// 021; a prototype behind ?countryside): says which tiles can be made, and asks the
// worker for them.
import { countrysideUrl, dataUrl, elevationUrl, liveCountrysideUrl } from './data.ts';
import type { Bounds } from './map/geo.ts';
import type { MapIndex, TileJSON } from './contracts.ts';
import type { CountrysideRequest, CountrysideResponse } from './countrysideWorker.ts';
import type { Place } from './countryside.ts';

type Ask = CountrysideRequest extends infer R ? (R extends { id: number } ? Omit<R, 'id'> : never) : never;

// How far from its middle a village's name holds, and a town's (metres).
const VILLAGE_REACH = 900, TOWN_REACH = 2200, PLACES_WITHIN = 3000;

// As far out as the countryside goes: 150 km from the middle of the built map. The
// GPU's 32-bit coordinates are good to a few centimetres that far; further would need
// the world's origin to move with the player.
const LIMIT = 150000;
function limited(box: Bounds, index: MapIndex): Bounds {
  const cx = index.size[0] / 2 - index.origin[0], cy = index.size[1] / 2 - index.origin[1];
  return [Math.max(box[0], cx - LIMIT), Math.max(box[1], cy - LIMIT), Math.min(box[2], cx + LIMIT), Math.min(box[3], cy + LIMIT)];
}

export class CountrysideTiles {
  // What the file covers, in the game's metres: null until it has been opened, and for
  // good if it can't be (the map then ends where it always did).
  box: Bounds | null = null;
  times: number[] = []; // ms the worker took over each of the last tiles
  // Done once the file has been opened or has failed to. A later terminal worker
  // failure can withdraw the coverage again.
  readonly opened: Promise<void>;
  private readonly worker: Worker | null;
  private readonly waiting = new Map<number, { resolve: (r: CountrysideResponse) => void; reject: (e: Error) => void }>();
  private next = 0;
  private places: { x: number; y: number; list: Place[] } | null = null;
  private asking = false;
  private broken: Error | null = null;
  private readonly index: MapIndex;

  // live: read OpenStreetMap's tiles from Protomaps' daily planet build, not the file.
  constructor(index: MapIndex, area: string, live = false) {
    this.index = index;
    try {
      this.worker = new Worker(new URL('./countrysideWorker.ts', import.meta.url), { type: 'module' });
    } catch (error) {
      this.worker = null;
      this.fail(error instanceof Error ? error : new Error(String(error)));
      this.opened = Promise.resolve();
      return;
    }
    this.worker.onmessage = (event: MessageEvent<CountrysideResponse>) => {
      const job = this.waiting.get(event.data.id);
      this.waiting.delete(event.data.id);
      if ('error' in event.data) job?.reject(new Error(event.data.error));
      else job?.resolve(event.data);
    };
    // A worker that can't start (its script didn't load) answers nothing: everyone
    // waiting is told so, and the map ends where it always did.
    this.worker.onerror = (event) => {
      event.preventDefault?.();
      this.fail(new Error(`The countryside's worker failed: ${event.message || 'its script did not load'}`));
    };
    this.worker.onmessageerror = () => this.fail(new Error('The countryside worker response could not be read'));
    const [w, s, e, n] = index.bbox_wgs84;
    this.opened = (live ? liveCountrysideUrl() : Promise.resolve(countrysideUrl)).then((url) => this.ask({ type: 'open', url: new URL(url, location.href).href, tiles: new URL(dataUrl(area, 'tiles/'), location.href).href,
      elevation: elevationUrl && index.terrain ? elevationUrl : null,
      leaving: index.leaving ? new URL(dataUrl(area, 'leaving.json'), location.href).href : null,
      setup: { centre: [(w + e) / 2, (s + n) / 2], tile: index.tile, origin: index.origin, cols: index.cols, rows: index.rows, size: index.size,
        grid: index.terrain && { n: index.terrain.n, step: index.terrain.step } } }))
      .then((r) => { if (!this.broken && 'box' in r) this.box = limited(r.box, index); })
      .catch((err) => this.fail(err));
  }

  // Terminal worker failures end countryside availability. Ordinary tile errors
  // stay local to their request, so a later fetch can still retry them.
  private fail(error: Error) {
    if (this.broken) return;
    this.broken = error;
    console.warn('The countryside past the map is not available', error);
    this.box = null;
    this.places = null;
    if (this.worker) {
      this.worker.onmessage = this.worker.onerror = this.worker.onmessageerror = null;
      this.worker.terminate();
    }
    for (const job of this.waiting.values()) job.reject(error);
    this.waiting.clear();
  }

  private ask(message: Ask) {
    const id = this.next++;
    if (this.broken) return Promise.reject(this.broken);
    return new Promise<CountrysideResponse>((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      try { this.worker!.postMessage({ ...message, id }); }
      catch (error) {
        this.waiting.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  // Whether tile (i, j) is one to make: past the built map and inside the file.
  covers(i: number, j: number) {
    const { tile: T, origin: [ox, oy], cols, rows } = this.index, box = this.box;
    if (!box || (i >= 0 && j >= 0 && i < cols && j < rows)) return false;
    return i * T - ox >= box[0] && j * T - oy >= box[1] && (i + 1) * T - ox <= box[2] && (j + 1) * T - oy <= box[3];
  }

  // Whether the built map's tile (i, j) is one of its last column or row and built only
  // part of the way across: the rest of it is countryside to make.
  partial(i: number, j: number) {
    const { tile: T, cols, rows, size: [W, H] } = this.index;
    return !!this.box && i >= 0 && j >= 0 && i < cols && j < rows && ((i === cols - 1 && W < cols * T - 0.5) || (j === rows - 1 && H < rows * T - 0.5));
  }

  // Such a tile whole: the built part as the map has it, and the countryside beside it.
  // Without the countryside (the file can't be read just now) the built part alone.
  async whole(built: TileJSON): Promise<TileJSON> {
    const { tile: T, origin: [ox, oy] } = this.index, { i, j } = built;
    let rest: TileJSON;
    try { rest = await this.tile(i, j); } catch (err) { console.warn(`The countryside in tile ${i}_${j} was not made`, err); return built; }
    const both = <V>(a: Record<string, V[] | undefined>, b: Record<string, V[] | undefined>) => {
      const out: Record<string, V[] | undefined> = { ...a };
      for (const [kind, list] of Object.entries(b)) out[kind] = [...(out[kind] ?? []), ...(list ?? [])];
      return out;
    };
    const once = <E extends { id: string }>(a: E[] = [], b: E[] = []) => [...a, ...b.filter((e) => !a.some((o) => o.id === e.id))];
    return {
      ...built, box: [i * T - ox, j * T - oy, (i + 1) * T - ox, (j + 1) * T - oy].map((v) => Math.round(v * 100) / 100) as Bounds,
      areas: both(built.areas, rest.areas), roads: both(built.roads, rest.roads),
      buildings: once(built.buildings, rest.buildings), trees: [...built.trees, ...rest.trees],
      drive: once(built.drive, rest.drive), walk: once(built.walk, rest.walk),
    };
  }

  // The name of the town or village you are in or beside, or null out in the open and
  // until the names round here have been read. Asked for again every half kilometre.
  placeAt(x: number, y: number): string | null {
    if (!this.box) return null;
    if (!this.asking && (!this.places || Math.hypot(x - this.places.x, y - this.places.y) > 500)) {
      this.asking = true;
      this.ask({ type: 'places', x, y, r: PLACES_WITHIN })
        .then((r) => { if (!this.broken && 'places' in r) this.places = { x, y, list: r.places }; })
        .catch((err) => console.warn('The place names round here were not read', err))
        .finally(() => { this.asking = false; });
    }
    let best: string | null = null, at = Infinity;
    for (const p of this.places?.list ?? []) {
      const d = Math.hypot(p.at[0] - x, p.at[1] - y);
      if (d < at && d <= (p.kind === 'village' ? VILLAGE_REACH : TOWN_REACH)) { at = d; best = p.name; }
    }
    return best;
  }

  // The hills under tile (i, j), as a tile's height grid; null where there are none to
  // be had (no elevation tiles, or they can't be read just now): the ground stays flat.
  async heights(i: number, j: number): Promise<Uint16Array | null> {
    try {
      const r = await this.ask({ type: 'heights', i, j });
      return 'heights' in r ? r.heights : null;
    } catch (err) {
      console.warn(`The hills of tile ${i}_${j} were not read`, err);
      return null;
    }
  }

  async tile(i: number, j: number): Promise<TileJSON> {
    const r = await this.ask({ type: 'tile', i, j });
    if (!('tile' in r)) throw new Error(`Countryside tile ${i}_${j} was not made`);
    this.times.push(r.ms);
    if (this.times.length > 256) this.times.shift();
    return r.tile;
  }
}
