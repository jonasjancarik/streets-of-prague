// How much of the sky each spot sees (the "sky view factor"), baked for a tile in its worker.
// Courtyards and narrow lanes see little of it, roofs and squares see all of it, so from
// above every block reads as a bright ring of roofs round a darker well. It scales the
// ambient (sky) light only, never the sun or the street lamps.
//
// A height field of the terrain plus the buildings is marched in 16 directions from each
// texel; the highest angle to the skyline in a direction gives cos² of it, and the mean of
// those is the ground's factor (the share of a cosine-weighted hemisphere that is open).
import type { Bounds, Point2 } from './geo.ts';
import type { HeightGrid } from '../contracts.ts';
import { heightSampler } from '../terrain.ts';

export const SKY_STEP = 1; // metres a texel of the ground's texture
export const SKY_MARGIN = 60; // how far beyond the tile the neighbours' buildings count

export interface Shadower { rings: Point2[][]; h: number }
// A building mesh's vertices, for the walls' share (positions are the game's x, y up, -y).
export interface SkyMesh { position: Float32Array; normal: Float32Array; facade: Float32Array | null }
export interface SkyJob { box: Bounds; ground: HeightGrid | null; shapes: Shadower[]; meshes: SkyMesh[] }
export interface SkyResult { n: number; texels: Uint8Array; walls: Float32Array[] }

const DIRS = 16;
const RING = Array.from({ length: DIRS }, (_, k) => [Math.cos((k + 0.5) * 2 * Math.PI / DIRS), Math.sin((k + 0.5) * 2 * Math.PI / DIRS)]);
// Distances along a ray, closer together near the start where the nearest walls matter most.
const REACH = [1.5, 3, 4.5, 6, 8, 10, 13, 16, 20, 25, 30, 37, 45, 52, 60];

// Fill a polygon (outer ring, then holes) into a height field with `top` where it is higher.
function fill(field: Float32Array, w: number, h: number, ox: number, oy: number, rings: Point2[][], top: number) {
  let y0 = Infinity, y1 = -Infinity;
  for (const p of rings[0]) { y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); }
  const j0 = Math.max(0, Math.floor(y1 < y0 ? 0 : (y0 - oy) / SKY_STEP)), j1 = Math.min(h - 1, Math.floor((y1 - oy) / SKY_STEP));
  for (let j = j0; j <= j1; j++) {
    const y = oy + (j + 0.5) * SKY_STEP, xs: number[] = [];
    for (const r of rings) {
      for (let a = 0, b = r.length - 1; a < r.length; b = a++) {
        const [xa, ya] = r[a], [xb, yb] = r[b];
        if (ya > y !== yb > y) xs.push(xa + ((y - ya) / (yb - ya)) * (xb - xa));
      }
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const i0 = Math.max(0, Math.ceil((xs[k] - ox) / SKY_STEP - 0.5)), i1 = Math.min(w - 1, Math.floor((xs[k + 1] - ox) / SKY_STEP - 0.5));
      for (let i = i0; i <= i1; i++) if (top > field[j * w + i]) field[j * w + i] = top;
    }
  }
}

export function skyView({ box, ground, shapes, meshes }: SkyJob): SkyResult {
  const [bx0, by0, bx1, by1] = box;
  const n = Math.ceil(Math.max(bx1 - bx0, by1 - by0) / SKY_STEP);
  const m = SKY_MARGIN, w = n + 2 * m, ox = bx0 - m, oy = by0 - m;
  const terrain = ground ? heightSampler(ground.hm, ground.box, ground.n, ground.step) : () => 0;
  const land = new Float32Array(w * w), field = new Float32Array(w * w);
  for (let j = 0; j < w; j++) for (let i = 0; i < w; i++) land[j * w + i] = terrain(ox + (i + 0.5) * SKY_STEP, oy + (j + 0.5) * SKY_STEP);
  field.set(land);
  for (const s of shapes) {
    // Each building stands on the lowest ground under its outline.
    let base = Infinity;
    for (const [x, y] of s.rings[0]) base = Math.min(base, terrain(x, y));
    fill(field, w, w, ox, oy, s.rings, base + s.h);
  }
  const texels = new Uint8Array(n * n);
  const openness = (x: number, y: number, z0: number) => {
    let sum = 0;
    for (let k = 0; k < DIRS; k++) {
      const dx = RING[k][0], dy = RING[k][1];
      let t = 0;
      for (const d of REACH) {
        const i = Math.floor((x + dx * d - ox) / SKY_STEP), j = Math.floor((y + dy * d - oy) / SKY_STEP);
        if (i < 0 || j < 0 || i >= w || j >= w) break;
        const up = (field[j * w + i] - z0) / d;
        if (up > t) t = up;
      }
      sum += 1 / (1 + t * t);
    }
    return sum / DIRS;
  };
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = bx0 + (i + 0.5) * SKY_STEP, y = by0 + (j + 0.5) * SKY_STEP;
      const c = (j + m) * w + i + m;
      // On a roof (or wherever the field stands above the land) the whole sky is in view.
      texels[j * n + i] = field[c] > land[c] + 0.5 ? 255 : Math.round(255 * openness(x, y, land[c] + 0.3));
    }
  }
  const at = (x: number, y: number) => {
    const u = Math.min(n - 1.001, Math.max(0, (x - bx0) / SKY_STEP - 0.5)), v = Math.min(n - 1.001, Math.max(0, (y - by0) / SKY_STEP - 0.5));
    const i = Math.floor(u), j = Math.floor(v), fu = u - i, fv = v - j;
    const a = texels[j * n + i], b = texels[j * n + i + 1], c = texels[(j + 1) * n + i], d = texels[(j + 1) * n + i + 1];
    return ((a * (1 - fu) + b * fu) * (1 - fv) + (c * (1 - fu) + d * fu) * fv) / 255;
  };
  // A wall sees what the street in front of it sees near the ground, and the whole sky
  // above the roofs of its neighbours: the street's factor, fading out by ~18 m up.
  const walls = meshes.map(({ position, normal, facade }) => {
    const out = new Float32Array(position.length / 3);
    for (let v = 0; v < out.length; v++) {
      const nx = normal[v * 3], ny = normal[v * 3 + 1], nz = normal[v * 3 + 2];
      if (ny > 0.5) { out[v] = 1; continue; }
      const x = position[v * 3], y = -position[v * 3 + 2];
      const height = facade && facade[v * 4 + 2] > 0 ? facade[v * 4 + 1] : Math.max(0, position[v * 3 + 1] - terrain(x, y));
      const g = at(x + nx * 1.2, y - nz * 1.2);
      const t = Math.min(1, height / 18);
      out[v] = g + (1 - g) * t * t * (3 - 2 * t);
    }
    return out;
  });
  return { n, texels, walls };
}
