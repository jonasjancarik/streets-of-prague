import { historicCore } from '../facades.ts';
import { zebras, type CrossingEnd, type GroundRoadEdge } from '../ground.ts';
import { onPolygons, type Bounds, type Point2, type Polygons } from './geo.ts';
import type { FenceTile } from './fences.ts';

// Which of a tile's fence lines are Prague's street railings and which chains between
// bollards (drawn by map/railings.ts), and the railings put up beside zebra crossings.
//
// The technical map's railings (dtm_walls.py: "railing", or on older maps a surveyed
// fence 1 m high) are a street railing, except where the survey breaks the line at
// every bollard: a group of railings joined end to end, mostly in spans 1 to 2.8 m long,
// is a chain hung between bollards (round the Hus memorial, on the Old Town's squares). A railing in the historic core is
// painted anthracite; elsewhere most are the old red and white, some the newer
// anthracite, the same along one stretch of street. Fences in the core are iron bars.
//
// The survey has few railings along the kerbs, where Prague has a great many: at a zebra
// over a main road (trunk to tertiary), on most of them, a railing stands 0.45 m behind
// the kerb on each side of it, from a little past the zebra's edge for up to 7 m, or as
// far as the pavement goes (not over a road, parking, tram bed, water or a building, nor
// into another crossing). Where they stand comes from the map; that they stand there is
// made up.

type Line = NonNullable<FenceTile['fences']>[number];
const SPAN = [1, 2.8]; // m: a chain's span between two bollards
const BUSY = /^(trunk|primary|secondary|tertiary)/;
const ZEBRA_SHARE = 0.8;
const BEHIND = 0.45; // m behind the kerb
const FROM = 2.1; // m from the zebra's middle line, along the kerb
const REACH = 7; // m of railing at most, each side
const SHORTEST = 2.5;
const STRETCH = 40; // m: railings within one square of this size are painted the same
const IRON_BARS = 2; // the fences' texture row (map/fences.ts)

function hash(x: number, y: number, salt = 0) {
  const h = Math.sin(x * 127.1 + y * 311.7 + salt * 74.7) * 43758.5453;
  return h - Math.floor(h);
}

export function railingLook(x: number, y: number, core: boolean) {
  if (core) return 1;
  return hash(Math.floor(x / STRETCH), Math.floor(y / STRETCH), 3) < 0.35 ? 1 : 0;
}

export interface RailingInputs {
  fences: Line[];
  bbox: Bounds; // the area's, in WGS84
  roads: Record<string, Polygons | undefined>;
  areas: Record<string, Polygons | undefined>;
  buildings: { rings: Point2[][] }[];
  crossings: Point2[][];
  roadEdges: GroundRoadEdge[];
  box: Bounds; // the tile's
}

export function streetRailings(d: RailingInputs): Line[] {
  const { inCore } = historicCore(d.bbox);
  const surveyed = (f: Line) => f.kind === 'railing' || (f.kind === 'fence' && f.s === 1 && f.h === 1);
  const segs = (f: Line) => f.pts.slice(1).map((p, i) => Math.hypot(p[0] - f.pts[i][0], p[1] - f.pts[i][1]));
  // The surveyed railings joined end to end, in groups (a union-find over their ends).
  const rails = d.fences.filter(surveyed), up = rails.map((_, i) => i);
  const root = (i: number): number => (up[i] === i ? i : (up[i] = root(up[i])));
  const key = (p: Point2) => `${Math.round(p[0] * 10)},${Math.round(p[1] * 10)}`;
  const byEnd = new Map<string, number>();
  rails.forEach((f, i) => {
    for (const p of [f.pts[0], f.pts[f.pts.length - 1]]) {
      const j = byEnd.get(key(p));
      if (j === undefined) byEnd.set(key(p), i); else up[root(i)] = root(j);
    }
  });
  // A group mostly in spans of a bollard's spacing is a chain all round (the survey
  // breaks some of it at its corners, and runs some spans on); so is a group beside a
  // chain, at a gap left for a path, if a good part of it is in such spans, or all of
  // it short. Whatever is left is a railing.
  const groups = new Map<number, { lines: Line[]; all: number; spans: number; short: boolean }>();
  rails.forEach((f, i) => {
    const g = groups.get(root(i)) ?? { lines: [], all: 0, spans: 0, short: true };
    g.lines.push(f);
    for (const l of segs(f)) { g.all += l; if (l >= SPAN[0] && l <= SPAN[1]) g.spans += l; if (l > SPAN[1]) g.short = false; }
    groups.set(root(i), g);
  });
  const chained = new Set<Line>(), chainEnds: Point2[] = [];
  const chain = (g: { lines: Line[] }) => { for (const f of g.lines) { chained.add(f); chainEnds.push(f.pts[0], f.pts[f.pts.length - 1]); } };
  const rest = [...groups.values()].filter((g) => {
    if (g.lines.length >= 2 && g.spans >= 0.5 * g.all) { chain(g); return false; }
    return true;
  });
  for (let grew = true; grew;) {
    grew = false;
    for (const g of rest) {
      if (chained.has(g.lines[0]) || !(g.short || g.spans >= 0.3 * g.all)) continue;
      const near = g.lines.some((f) => [f.pts[0], f.pts[f.pts.length - 1]].some((p) => chainEnds.some((q) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 4)));
      if (near) { chain(g); grew = true; }
    }
  }
  const out: Line[] = d.fences.map((f) => {
    const [x, y] = f.pts[0];
    if (chained.has(f)) return { kind: 'chain', pts: f.pts };
    if (surveyed(f)) return { kind: 'railing', h: f.h ?? 1, look: railingLook(x, y, inCore(x, y)), pts: f.pts };
    if (f.kind === 'fence' && inCore(x, y)) return { ...f, look: IRON_BARS };
    return f;
  });
  out.push(...zebraRailings(d, inCore));
  return out;
}

function zebraRailings(d: RailingInputs, inCore: (x: number, y: number) => boolean): Line[] {
  if (!d.crossings.length || !d.roadEdges.length) return [];
  const road = [...(d.roads.road ?? []), ...(d.roads.sett ?? [])];
  const ends: CrossingEnd[] = [];
  zebras(d.crossings, d.roadEdges, road, d.box, ends);
  if (!ends.length) return [];
  const blocked = onPolygons([...road, ...(d.areas.parking ?? []), ...(d.roads.trambed ?? []), ...(d.areas.water ?? []), ...d.buildings.map((b) => b.rings)]);
  const [x0, y0, x1, y1] = d.box;
  const inBox = (x: number, y: number) => x > x0 + 0.5 && x < x1 - 0.5 && y > y0 + 0.5 && y < y1 - 0.5;
  const out: Line[] = [];
  for (const end of ends) {
    const { at: [kx, ky], out: [ox, oy], along: [rx, ry], hw } = end;
    if (!BUSY.test(hw) || hash(Math.round(kx / 3), Math.round(ky / 3), 1) > ZEBRA_SHARE) continue;
    const at = (b: number, s: number): Point2 => [kx + ox * b + rx * s, ky + oy * b + ry * s];
    // Past a parking lane or a bay at the zebra's end to the pavement's kerb, as the tactile paving does.
    let kerb = 0;
    while (kerb < 3 && blocked(...at(kerb + 0.05, 0))) kerb += 0.1;
    if (kerb >= 3) continue;
    const b = kerb + BEHIND;
    const open = (s: number) => {
      const p = at(b, s);
      return inBox(...p) && !blocked(...at(b - 0.25, s)) && !blocked(...p) && !blocked(...at(b + 0.3, s))
        // (Not into the mouth of another zebra.)
        && ends.every((e) => e === end || Math.hypot(e.at[0] - p[0], e.at[1] - p[1]) > FROM + 0.5);
    };
    for (const side of [-1, 1]) {
      let s = FROM;
      if (!open(s * side)) continue;
      while (s + 0.25 <= FROM + REACH && open((s + 0.25) * side)) s += 0.25;
      if (s - FROM < SHORTEST) continue;
      const a = at(b, FROM * side), e = at(b, s * side);
      out.push({ kind: 'railing', h: 1, look: railingLook(kx, ky, inCore(kx, ky)), pts: [a, e] });
    }
  }
  return out;
}
