// Area data is in local metres: +x east, +y north, origin at the bbox centre.
// three.js world: X = x, Y = up, Z = -y  (so north is "up" on screen).

export type Point2 = [number, number];
export type Bounds = [number, number, number, number];
export type Rings = Point2[][];
export type Polygons = Rings[];
export type PaintContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export interface GeoData {
  size: Point2;
  origin: Point2;
}

export class Geo<T extends GeoData = GeoData> {
  data: T;
  W: number;
  H: number;
  ox: number;
  oy: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  cx: number;
  cy: number;

  constructor(data: T) {
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
  px(x: number, y: number, s: number): Point2 {
    return [(x + this.ox) * s, (this.H - (y + this.oy)) * s];
  }

  inside(x: number, y: number, pad = 0) {
    return x > this.minX + pad && x < this.maxX - pad && y > this.minY + pad && y < this.maxY - pad;
  }
}

export function ringPath(ctx: PaintContext, geo: Geo, rings: Rings, s: number) {
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
export function fillPolys(ctx: PaintContext, geo: Geo, polys: Polygons, s: number) {
  for (const rings of polys) {
    ctx.beginPath();
    ringPath(ctx, geo, rings, s);
    ctx.fill('evenodd');
  }
  ctx.beginPath();
  for (const rings of polys) ringPath(ctx, geo, rings, s);
}

export function strokeLines(ctx: PaintContext, geo: Geo, lines: Point2[][], s: number) {
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

export function signedArea(ring: Point2[]) {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % ring.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

export function centroid(ring: Point2[]): Point2 {
  let x = 0, y = 0;
  for (const p of ring) { x += p[0]; y += p[1]; }
  return [x / ring.length, y / ring.length];
}

// Deterministic per-feature randomness.
export function hash(str: string) {
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

// Rasterised lookup grid (walkability, land-use) at `res` cells per metre. Painted
// on an OffscreenCanvas where there is one, so it can be made in a worker; with
// `paint` null, `cells` are ones already made.
export class Grid {
  geo: Geo;
  res: number;
  w: number;
  h: number;
  ox: number;
  oy: number;
  H: number;
  cells: Uint8Array;

  constructor(geo: Geo, res: number, paint: ((ctx: PaintContext, res: number) => void) | null, cells: Uint8Array | null = null) {
    this.geo = geo;
    this.res = res;
    this.w = Math.ceil(geo.W * res);
    this.h = Math.ceil(geo.H * res);
    // For at(): the same sums as geo.px, without an array for every lookup.
    this.ox = geo.ox;
    this.oy = geo.oy;
    this.H = geo.H;
    if (!paint) {
      if (!cells) throw new Error('Grid cells are required when there is no paint callback');
      this.cells = cells;
      return;
    }
    const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(this.w, this.h) : document.createElement('canvas');
    c.width = this.w;
    c.height = this.h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    if (!ctx || !('getImageData' in ctx)) throw new Error('Cannot create a 2D canvas context');
    ctx.imageSmoothingEnabled = false;
    paint(ctx, res);
    const img = ctx.getImageData(0, 0, this.w, this.h).data;
    this.cells = new Uint8Array(this.w * this.h);
    for (let i = 0; i < this.cells.length; i++) this.cells[i] = img[i * 4];
    c.width = c.height = 0; // let the canvas go now
  }

  at(x: number, y: number) {
    const i = Math.floor((x + this.ox) * this.res), j = Math.floor((this.H - (y + this.oy)) * this.res);
    if (i < 0 || j < 0 || i >= this.w || j >= this.h) return 255;
    return this.cells[j * this.w + i];
  }
}

// Whether a point is on any of the polygons (with holes).
export function onPolygons(polys: Polygons) {
  const boxes = polys.map((rings) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of rings[0]) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    return [x0, y0, x1, y1];
  });
  const inRing = (ring: Point2[], x: number, y: number) => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
  return (x: number, y: number) => polys.some((rings, k) => {
    const b = boxes[k];
    return x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3] && inRing(rings[0], x, y) && !rings.slice(1).some((hole) => inRing(hole, x, y));
  });
}
