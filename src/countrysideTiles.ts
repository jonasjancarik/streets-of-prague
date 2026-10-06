// The main thread's side of the countryside past the built map (countryside.ts, plan
// 021; a prototype behind ?countryside): says which tiles can be made, and asks the
// worker for them.
import { countrysideUrl, dataUrl } from './data.ts';
import type { Bounds } from './map/geo.ts';
import type { MapIndex, TileJSON } from './contracts.ts';
import type { CountrysideRequest, CountrysideResponse } from './countrysideWorker.ts';

type Ask = CountrysideRequest extends infer R ? (R extends { id: number } ? Omit<R, 'id'> : never) : never;

export class CountrysideTiles {
  // What the file covers, in the game's metres: null until it has been opened, and for
  // good if it can't be (the map then ends where it always did).
  box: Bounds | null = null;
  times: number[] = []; // ms the worker took over each of the last tiles
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
    this.ask({ type: 'open', url: new URL(countrysideUrl, location.href).href, tiles: new URL(dataUrl(area, 'tiles/'), location.href).href,
      setup: { centre: [(w + e) / 2, (s + n) / 2], tile: index.tile, origin: index.origin, cols: index.cols, rows: index.rows } })
      .then((r) => { if ('box' in r) this.box = r.box; })
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

  async tile(i: number, j: number): Promise<TileJSON> {
    const r = await this.ask({ type: 'tile', i, j });
    if (!('tile' in r)) throw new Error(`Countryside tile ${i}_${j} was not made`);
    this.times.push(r.ms);
    if (this.times.length > 256) this.times.shift();
    return r.tile;
  }
}
