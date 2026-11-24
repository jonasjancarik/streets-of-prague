// Where a tile's carriageways are, as a picture of it two cells a metre, made the first
// time someone asks about the tile: a quick lookup for the walkers, who keep to the
// pavement beside a street (people.ts). (kerbDrop.ts has a finer picture of the same,
// but it fades out towards bridges and tunnels, so it can't say where a street is there.)
import type { Bounds, Polygons } from './map/geo.ts';

const RES = 2; // cells a metre

interface Mask { x0: number; y0: number; w: number; h: number; cells: Uint8Array }

// Every polygon (rings, even-odd) filled into the picture, a row at a time.
function paint(box: Bounds, polys: Polygons): Mask {
  const [x0, y0, x1, y1] = box, w = Math.max(1, Math.ceil((x1 - x0) * RES)), h = Math.max(1, Math.ceil((y1 - y0) * RES));
  const cells = new Uint8Array(w * h), xs: number[] = [];
  for (const rings of polys) {
    let lo = Infinity, hi = -Infinity;
    for (const ring of rings) for (const p of ring) { lo = Math.min(lo, p[1]); hi = Math.max(hi, p[1]); }
    const j0 = Math.max(0, Math.floor((lo - y0) * RES)), j1 = Math.min(h - 1, Math.ceil((hi - y0) * RES));
    for (let j = j0; j <= j1; j++) {
      const y = y0 + (j + 0.5) / RES;
      xs.length = 0;
      for (const ring of rings) {
        for (let i = 0, n = ring.length, k = n - 1; i < n; k = i++) {
          const a = ring[k], b = ring[i];
          if ((a[1] > y) !== (b[1] > y)) xs.push(a[0] + ((y - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
        }
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const i0 = Math.max(0, Math.ceil((xs[k] - x0) * RES - 0.5)), i1 = Math.min(w - 1, Math.floor((xs[k + 1] - x0) * RES - 0.5));
        for (let i = i0; i <= i1; i++) cells[j * w + i] = 1;
      }
    }
  }
  return { x0, y0, w, h, cells };
}

// `tileAt`: the tile at a point (kept between calls: lookups come in runs in one tile);
// `shapes`: its box and its carriageways.
export function carriageways<T extends object>(tileAt: (x: number, y: number) => T | undefined, shapes: (tile: T) => { box: Bounds; polys: Polygons }) {
  const masks = new WeakMap<T, Mask>();
  return (x: number, y: number) => {
    const tile = tileAt(x, y);
    if (!tile) return false;
    let m = masks.get(tile);
    if (!m) {
      const s = shapes(tile);
      masks.set(tile, (m = paint(s.box, s.polys)));
    }
    const i = Math.floor((x - m.x0) * RES), j = Math.floor((y - m.y0) * RES);
    return i >= 0 && j >= 0 && i < m.w && j < m.h && m.cells[j * m.w + i] === 1;
  };
}
