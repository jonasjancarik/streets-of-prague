// How busy the streets are (data/<area>_now/footfall.png, from
// pipeline/build_footfall.py): 0 where nobody's about, 1 as busy as the Old Town
// Square. Without the map every street counts as equally busy, as before.

const QUIET = 0.036; // about 240 people everywhere

export async function loadFootfall(area) {
  try {
    const meta = await fetch(`data/${area}_now/footfall.json`).then((r) => r.json());
    const blob = await fetch(`data/${area}_now/footfall.png`).then((r) => (r.ok ? r.blob() : Promise.reject()));
    const img = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
    const [w, h] = meta.size;
    const ctx = new OffscreenCanvas(w, h).getContext('2d', { willReadFrequently: true });
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
  constructor(share, w, h, box, cell) {
    Object.assign(this, { share, w, h, cell });
    if (box) [this.x0, , , this.y1] = box;
  }

  // Busyness at a point, between the cells' centres.
  at(x, y) {
    if (!this.share) return QUIET;
    const fx = (x - this.x0) / this.cell - 0.5, fy = (this.y1 - y) / this.cell - 0.5;
    const i = Math.floor(fx), j = Math.floor(fy), tx = fx - i, ty = fy - j;
    const c = (a, b) => this.share[Math.min(this.h - 1, Math.max(0, b)) * this.w + Math.min(this.w - 1, Math.max(0, a))];
    return (c(i, j) * (1 - tx) + c(i + 1, j) * tx) * (1 - ty) + (c(i, j + 1) * (1 - tx) + c(i + 1, j + 1) * tx) * ty;
  }

  // Average busyness within r metres.
  around(x, y, r) {
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
  edge(e) {
    if (e.busy === undefined) {
      const q = e.path.at(e.path.length / 2);
      e.busy = this.at(q.x, q.y);
    }
    return e.busy;
  }
}
