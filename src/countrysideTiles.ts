// The main thread's side of the countryside past the built map (countryside.ts, plan
// 021; a prototype behind ?countryside): says which tiles can be made, and asks the
// worker for them.
import { countrysideUrl, dataUrl } from './data.ts';
import type { Bounds } from './map/geo.ts';
import type { MapIndex, TileJSON } from './contracts.ts';
import type { CountrysideRequest, CountrysideResponse } from './countrysideWorker.ts';

type Ask = CountrysideRequest extends infer R ? (R extends { id: number } ? Omit<R, 'id'> : never) : never;

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
  // Done once the file has been opened or has failed to: `box` is then as it will stay.
  readonly opened: Promise<void>;
  private readonly worker: Worker;
  private readonly waiting = new Map<number, { resolve: (r: CountrysideResponse) => void; reject: (e: Error) => void }>();
  private next = 0;
  private readonly index: MapIndex;

  constructor(index: MapIndex, area: string) {
    this.index = index;
    this.worker = new Worker(new URL('./countrysideWorker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (event: MessageEvent<CountrysideResponse>) => {
      const job = this.waiting.get(event.data.id);
      this.waiting.delete(event.data.id);
      if ('error' in event.data) job?.reject(new Error(event.data.error));
      else job?.resolve(event.data);
    };
    const [w, s, e, n] = index.bbox_wgs84;
    this.opened = this.ask({ type: 'open', url: new URL(countrysideUrl, location.href).href, tiles: new URL(dataUrl(area, 'tiles/'), location.href).href,
      leaving: index.leaving ? new URL(dataUrl(area, 'leaving.json'), location.href).href : null,
      setup: { centre: [(w + e) / 2, (s + n) / 2], tile: index.tile, origin: index.origin, cols: index.cols, rows: index.rows, size: index.size } })
      .then((r) => { if ('box' in r) this.box = limited(r.box, index); })
      .catch((err) => console.warn('The countryside past the map is not available', err));
  }

  private ask(message: Ask) {
    const id = this.next++;
    return new Promise<CountrysideResponse>((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.worker.postMessage({ ...message, id });
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

  async tile(i: number, j: number): Promise<TileJSON> {
    const r = await this.ask({ type: 'tile', i, j });
    if (!('tile' in r)) throw new Error(`Countryside tile ${i}_${j} was not made`);
    this.times.push(r.ms);
    if (this.times.length > 256) this.times.shift();
    return r.tile;
  }
}
