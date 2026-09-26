// Area data is in local metres: +x east, +y north, origin at the bbox centre.
// three.js world: X = x, Y = up, Z = -y  (so north is "up" on screen).

export class Geo {
  constructor(data) {
    this.data = data;
    this.W = data.size[0];
    this.H = data.size[1];
    this.ox = data.origin[0];
    this.oy = data.origin[1];
    this.minX = -this.ox;
    this.minY = -this.oy;
    this.maxX = this.W - this.ox;
    this.maxY = this.H - this.oy;
    this.cx = this.minX + this.W / 2;
    this.cy = this.minY + this.H / 2;
  }

  // Canvas pixel for local coords at `s` px per metre.
  px(x, y, s) {
    return [(x + this.ox) * s, (this.H - (y + this.oy)) * s];
  }

  inside(x, y, pad = 0) {
    return x > this.minX + pad && x < this.maxX - pad && y > this.minY + pad && y < this.maxY - pad;
  }
}

export function ringPath(ctx, geo, rings, s) {
  for (const ring of rings) {
    ring.forEach(([x, y], i) => {
      const [u, v] = geo.px(x, y, s);
      if (i === 0) ctx.moveTo(u, v);
      else ctx.lineTo(u, v);
    });
    ctx.closePath();
  }
}

// Each polygon is filled on its own (even-odd only within its rings), so
// overlapping polygons don't cancel out. Leaves all outlines as the current path.
export function fillPolys(ctx, geo, polys, s) {
  for (const rings of polys) {
    ctx.beginPath();
    ringPath(ctx, geo, rings, s);
    ctx.fill('evenodd');
  }
  ctx.beginPath();
  for (const rings of polys) ringPath(ctx, geo, rings, s);
}

export function strokeLines(ctx, geo, lines, s) {
  ctx.beginPath();
  for (const pts of lines) {
    pts.forEach(([x, y], i) => {
      const [u, v] = geo.px(x, y, s);
      if (i === 0) ctx.moveTo(u, v);
      else ctx.lineTo(u, v);
    });
  }
  ctx.stroke();
}

export function signedArea(ring) {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % ring.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

export function centroid(ring) {
  let x = 0, y = 0;
  for (const p of ring) { x += p[0]; y += p[1]; }
  return [x / ring.length, y / ring.length];
}

// Deterministic per-feature randomness.
export function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

export function rng(seed = 1) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Rasterised lookup grid (walkability, land-use) at `res` cells per metre.
export class Grid {
  constructor(geo, res, paint) {
    this.geo = geo;
    this.res = res;
    this.w = Math.ceil(geo.W * res);
    this.h = Math.ceil(geo.H * res);
    const c = document.createElement('canvas');
    c.width = this.w;
    c.height = this.h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = false;
    paint(ctx, res);
    const img = ctx.getImageData(0, 0, this.w, this.h).data;
    this.cells = new Uint8Array(this.w * this.h);
    for (let i = 0; i < this.cells.length; i++) this.cells[i] = img[i * 4];
    this.canvas = c;
  }

  at(x, y) {
    const [u, v] = this.geo.px(x, y, this.res);
    const i = Math.floor(u), j = Math.floor(v);
    if (i < 0 || j < 0 || i >= this.w || j >= this.h) return 255;
    return this.cells[j * this.w + i];
  }
}
