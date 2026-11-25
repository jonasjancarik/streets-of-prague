import type { Bounds } from './map/geo.ts';

export type RoadGrade = [level: number, halfWidth: number,
  ax: number, ay: number, azCm: number, aCross: number,
  bx: number, by: number, bzCm: number, bCross: number];
type Height = (x: number, y: number, side?: number | boolean) => number;

const cellSize = 24;
const shoulder = 3;
const cellKey = (i: number, j: number) => i * 65536 + j;

function bounds([, halfWidth, ax, ay, , , bx, by]: RoadGrade): Bounds {
  const pad = halfWidth + shoulder;
  return [Math.min(ax, bx) - pad, Math.min(ay, by) - pad, Math.max(ax, bx) + pad, Math.max(ay, by) + pad];
}

// Group short segments so mesh refinement and tunnel occlusion follow the road through the tile.
export function gradeBoxes(parts?: RoadGrade[]): Bounds[] {
  const boxes = new Map<number, Bounds>();
  for (const part of parts ?? []) {
    if (part[0] !== 0) continue;
    const box = bounds(part);
    const key = cellKey(Math.floor((box[0] + box[2]) / 96), Math.floor((box[1] + box[3]) / 96));
    const prev = boxes.get(key);
    boxes.set(key, prev ? [Math.min(prev[0], box[0]), Math.min(prev[1], box[1]),
      Math.max(prev[2], box[2]), Math.max(prev[3], box[3])] : box);
  }
  return [...boxes.values()];
}

export function withMagistrala(base: Height, parts: RoadGrade[] | undefined, level: number, ref: number): Height {
  if (!parts?.length) return base;
  const bins = new Map<number, RoadGrade[]>();
  for (const part of parts) {
    if (part[0] !== level) continue;
    const [x0, y0, x1, y1] = bounds(part);
    for (let i = Math.floor(x0 / cellSize); i <= Math.floor(x1 / cellSize); i++) {
      for (let j = Math.floor(y0 / cellSize); j <= Math.floor(y1 / cellSize); j++) {
        const key = cellKey(i, j), list = bins.get(key);
        if (list) list.push(part);
        else bins.set(key, [part]);
      }
    }
  }
  if (!bins.size) return base;
  return (x, y, side) => {
    const list = bins.get(cellKey(Math.floor(x / cellSize), Math.floor(y / cellSize)));
    if (!list || side === true || side === 1) return base(x, y, side);
    let closest = Infinity, height = 0, weight = 0;
    for (const [, halfWidth, ax, ay, az, ac, bx, by, bz, bc] of list) {
      const dx = bx - ax, dy = by - ay, length2 = dx * dx + dy * dy;
      const along = ((x - ax) * dx + (y - ay) * dy) / length2;
      const u = Math.max(0, Math.min(1, along));
      const ex = x - ax - u * dx, ey = y - ay - u * dy, distance2 = ex * ex + ey * ey;
      // At a merge prefer the segment spanning this point over the tip of the wider road.
      const beyond = (along - u) ** 2 * length2;
      const score = (distance2 + 16 * beyond) / (halfWidth * halfWidth);
      if (score >= closest || distance2 >= (halfWidth + shoulder) ** 2) continue;
      closest = score;
      const lateral = (dy * ex - dx * ey) / Math.sqrt(length2);
      height = (az + u * (bz - az)) * .01 - ref + lateral * (ac + u * (bc - ac)) * .001;
      const w = Math.min(1, (halfWidth + shoulder - Math.sqrt(distance2)) / shoulder);
      weight = w * w * (3 - 2 * w);
    }
    if (weight === 1) return height;
    const original = base(x, y, side);
    return weight ? original + (height - original) * weight : original;
  };
}
