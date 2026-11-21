// Beneath the southern abutment of Štefánikův most the bare-earth mesh picks up
// the road above. The DTM ZPS transport edges alongside the lower path are at
// 186.6–187.1 m Bpv, six metres below the bridge. The OSM stair ways and their
// surveyed landings identify the walking surface even on older map builds. The
// intermediate stair landings are cross-checked against IPR’s 2023 terrain raster.
import type { Bounds } from './geo.ts';
import type { RawStreetEdge } from '../network.ts';
import { WATER } from '../terrain.ts';

const landings: Record<string, number> = {
  '1238413407': 187.0,
  '1548698464': 186.7, // west and east ends of the lower sidewalk
  '3426549812': 191.2,
  '354686149': 191.35,
  '3426549809': 191.7,
  '3426549808': 192.45,
  '3426549813': 187.15,
  '3426549811': 191.35,
  '3426549810': 192.38,
};
// OSM ways 31696002 and 48051057 both record a handrail. Keep one slim rail
// on the bridge side of each flight, clear of the walking line.
const railSide = new Map([['1238413407>3426549812', 1], ['3426549810>3426549811', 1], ['3426549811>3426549813', 1]]);

type Segment = {
  rail?: number;
  x: number;
  y: number;
  dx: number;
  dy: number;
  d2: number;
  z: number;
  dz: number;
  half: number;
};
export interface BridgeWalk {
  box: Bounds;
  segments: Segment[];
}
type Height = (x: number, y: number, side?: number | boolean) => number;

export function bridgeWalk(ways: RawStreetEdge[] | undefined): BridgeWalk | undefined {
  if (!ways?.some((e) => e.u === '1238413407' || e.v === '1238413407')) return;
  const box: Bounds = [Infinity, Infinity, -Infinity, -Infinity], segments: Segment[] = [];
  for (const e of ways) {
    const z = landings[e.u], end = landings[e.v];
    if (z === undefined || end === undefined || e.bridge || e.tunnel || e.level || e.pts.length < 2) continue;
    const pts = e.pts, half = Math.min(2, Math.max(1, e.width / 2));
    const lengths = pts.slice(1).map((p, i) => Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]));
    const total = lengths.reduce((sum, n) => sum + n, 0);
    let s = 0;
    for (let i = 1; i < pts.length; i++) {
      const [x, y] = pts[i - 1], [bx, by] = pts[i], d = lengths[i - 1];
      if (d < .001) continue;
      const pad = half + 1.4;
      box[0] = Math.min(box[0], x - pad, bx - pad);
      box[1] = Math.min(box[1], y - pad, by - pad);
      box[2] = Math.max(box[2], x + pad, bx + pad);
      box[3] = Math.max(box[3], y + pad, by + pad);
      segments.push({
        x,
        y,
        dx: bx - x,
        dy: by - y,
        d2: d * d,
        z: z + (end - z) * s / total,
        dz: (end - z) * d / total,
        half,
        rail: e.hw === 'steps' ? railSide.get(e.u + '>' + e.v) ?? -(railSide.get(e.v + '>' + e.u) ?? 0) : 0,
      });
      s += d;
    }
  }
  return segments.length ? { box, segments } : undefined;
}

export function withBridgeWalk(base: Height, fit: BridgeWalk | undefined, ref: number): Height {
  if (!fit) return base;
  const [x0, y0, x1, y1] = fit.box;
  return (x, y, side = false) => {
    const h = base(x, y, side);
    if (side === WATER || side === true || x < x0 || x > x1 || y < y0 || y > y1) return h;
    let nearest = Infinity, target = h, width = 0;
    for (const s of fit.segments) {
      const dx = x - s.x, dy = y - s.y, t = Math.max(0, Math.min(1, (dx * s.dx + dy * s.dy) / s.d2));
      const d = (dx - t * s.dx) ** 2 + (dy - t * s.dy) ** 2;
      if (d < nearest) {
        nearest = d;
        target = s.z + t * s.dz - ref;
        width = s.half;
      }
    }
    const mix = Math.max(0, Math.min(1, (width + 1.4 - Math.sqrt(nearest)) / 1.4));
    return h + (target - h) * mix * mix * (3 - 2 * mix);
  };
}
