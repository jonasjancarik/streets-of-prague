// How busy the streets are (data/<area>_now/footfall.png, from
// pipeline/build_footfall.py): 0 where nobody's about, 1 as busy as the Old Town
// Square. Without the map every street counts as equally busy, as before.

const QUIET = 0.036; // about 240 people everywhere

interface FootfallMeta {
  size: [number, number];
  box: [number, number, number, number];
  cell: number;
}

function isFootfallMeta(value: unknown): value is FootfallMeta {
  if (typeof value !== 'object' || value === null) return false;
  const meta = value as Record<string, unknown>;
  return Array.isArray(meta.size) && meta.size.length === 2 && meta.size.every((n) => typeof n === 'number')
    && Array.isArray(meta.box) && meta.box.length === 4 && meta.box.every((n) => typeof n === 'number')
    && typeof meta.cell === 'number';
}

interface FootfallEdge {
  path: { length: number; at(s: number): { x: number; y: number } };
  busy?: number;
}

export async function loadFootfall(area: string) {
  try {
    const meta: unknown = await fetch(`data/${area}_now/footfall.json`).then((r) => r.json());
    if (!isFootfallMeta(meta)) throw new Error('Invalid footfall metadata');
    const blob = await fetch(`data/${area}_now/footfall.png`).then((r) => (r.ok ? r.blob() : Promise.reject()));
    const img = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
    const [w, h] = meta.size;
    const ctx = new OffscreenCanvas(w, h).getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('Cannot create footfall canvas');
    ctx.drawImage(img, 0, 0);
    const px = ctx.getImageData(0, 0, w, h).data;
    const share = new Float32Array(w * h);
    for (let k = 0; k < share.length; k++) share[k] = (px[k * 4] / 255) ** 2; // the grey is the square root
    return new Footfall(share, w, h, meta.box, meta.cell);
  } catch {
    return new Footfall(null);
  }
}

export class Footfall {
  share: Float32Array | null;
  w: number;
  h: number;
  x0: number;
  y1: number;
  cell: number;

  constructor(share: Float32Array | null, w = 0, h = 0, box?: [number, number, number, number], cell = 1) {
    this.share = share;
    this.w = w;
    this.h = h;
    this.cell = cell;
    this.x0 = 0;
    this.y1 = 0;
    if (box) [this.x0, , , this.y1] = box;
  }

  // Busyness at a point, between the cells' centres.
  at(x: number, y: number) {
    if (!this.share) return QUIET;
    const fx = (x - this.x0) / this.cell - 0.5, fy = (this.y1 - y) / this.cell - 0.5;
    const i = Math.floor(fx), j = Math.floor(fy), tx = fx - i, ty = fy - j;
    const c = (a: number, b: number) => this.share![Math.min(this.h - 1, Math.max(0, b)) * this.w + Math.min(this.w - 1, Math.max(0, a))];
    return (c(i, j) * (1 - tx) + c(i + 1, j) * tx) * (1 - ty) + (c(i, j + 1) * (1 - tx) + c(i + 1, j + 1) * tx) * ty;
  }

  // Average busyness within r metres.
  around(x: number, y: number, r: number) {
    if (!this.share) return QUIET;
    let sum = 0, n = 0;
    const step = Math.max(this.cell, r / 12);
    for (let dx = -r; dx <= r; dx += step) {
      for (let dy = -r; dy <= r; dy += step) {
        if (dx * dx + dy * dy > r * r) continue;
        sum += this.at(x + dx, y + dy);
        n++;
      }
    }
    return sum / n;
  }

  // An edge's busyness, taken once at its middle.
  edge(e: FootfallEdge) {
    if (e.busy === undefined) {
      const q = e.path.at(e.path.length / 2);
      e.busy = this.at(q.x, q.y);
    }
    return e.busy;
  }
}
