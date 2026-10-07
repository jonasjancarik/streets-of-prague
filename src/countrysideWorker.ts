// Makes countryside tiles (countryside.ts) off the main thread: one worker, which reads
// the vector tiles from the PMTiles file by range requests and keeps what it has read
// of the vector tiles round the player.
import { PMTiles } from 'pmtiles';
import { Countryside } from './countryside.ts';
import type { CountrysideSetup, Place } from './countryside.ts';
import type { Bounds } from './map/geo.ts';
import type { TileJSON } from './contracts.ts';

export type CountrysideRequest =
  | { id: number; type: 'open'; url: string; tiles: string; leaving: string | null; setup: CountrysideSetup } // tiles: where the built map's tiles are; leaving: its list of streets that run on outside, if it has one
  | { id: number; type: 'tile'; i: number; j: number }
  | { id: number; type: 'places'; x: number; y: number; r: number };
// open: the part of the map the file covers, in the game's metres. tile: the tile, and
// how long it took (ms).
export type CountrysideResponse =
  | { id: number; box: Bounds } | { id: number; tile: TileJSON; ms: number } | { id: number; places: Place[] } | { id: number; error: string };

const worker = self as unknown as { postMessage(message: CountrysideResponse): void; onmessage: ((event: MessageEvent<CountrysideRequest>) => void) | null };
let land: Countryside | null = null;

worker.onmessage = async (event) => {
  const m = event.data, id = m.id;
  try {
    if (m.type === 'open') {
      const archive = new PMTiles(m.url), h = await archive.getHeader();
      const built = async (i: number, j: number) => {
        const r = await fetch(`${m.tiles}${i}_${j}.json`);
        if (r.status === 404) return undefined;
        if (!r.ok) throw new Error(`Tile ${i}_${j} could not be loaded (${r.status})`);
        return r.json();
      };
      const leaving = m.leaving === null ? undefined : async () => {
        const r = await fetch(m.leaving!);
        if (!r.ok) throw new Error(`The streets that leave the map could not be loaded (${r.status})`);
        return r.json();
      };
      land = new Countryside(async (z, x, y) => (await archive.getZxy(z, x, y))?.data, built, m.setup, h.maxZoom, leaving);
      const sw = land.metres(h.minLon, h.minLat), se = land.metres(h.maxLon, h.minLat);
      const nw = land.metres(h.minLon, h.maxLat), ne = land.metres(h.maxLon, h.maxLat);
      worker.postMessage({ id, box: [Math.max(sw[0], nw[0]), Math.max(sw[1], se[1]), Math.min(se[0], ne[0]), Math.min(nw[1], ne[1])] });
    } else if (m.type === 'places') {
      if (!land) throw new Error('The countryside file is not open');
      worker.postMessage({ id, places: await land.places(m.x, m.y, m.r) });
    } else {
      if (!land) throw new Error('The countryside file is not open');
      const started = performance.now(), tile = await land.tile(m.i, m.j);
      worker.postMessage({ id, tile, ms: performance.now() - started });
    }
  } catch (err) {
    worker.postMessage({ id, error: String(err instanceof Error ? err.stack || err.message : err) });
  }
};
