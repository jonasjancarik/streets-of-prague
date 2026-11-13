// Stop shelters. OpenStreetMap has many of Prague's tram and bus stop shelters as small
// buildings (building=yes with amenity=shelter, shelter_type=public_transport), which
// IPR's 3D model doesn't have, so the game raised them from their outlines as little
// houses with tiled roofs on the platforms. Maps built after this change mark them
// (`shelter`, pipeline/osm_area.py). In older maps, which don't, a building is taken for
// one by its outline and place: small, narrow and low, its long side along a tram track
// close by. (Along streets too, that caught substations, garages and a bakery: 36 of 121
// across Prague were not shelters; by the tracks all 32 were.) Instead of a house, one of
// Prague's new shelters stands in the outline (shelterParts). Made up: that every stop
// has the new design, and where its parts go; the place and size are OSM's.
//
// Coordinates are the tile's (x east, y north, z up), as in roofDetails.ts.
import type { Point2 } from './geo.ts';
import type { Part } from './roofDetails.ts';

export interface StopLine { pts: Point2[]; reach: number; track?: boolean } // reach: m from the line a shelter may stand
export interface Shelter { x: number; y: number; c: number; s: number; length: number; depth: number; back: number }

const KINDS = new Set(['yes', 'roof', 'shelter']);
const HEIGHT = 4; // m: no taller (OSM's or the pipeline's guess)
const DEPTH = [0.8, 2.8]; // m
const LENGTH = [2.5, 16]; // m
const NARROW = 1.6; // long side at least this many times the short one
const ALONG = 0.85; // cos of the angle between its long side and the line it stands by

// A building as a stop shelter, or null if it doesn't look like one.
// `marked`: the tile's map says which buildings are shelters (some of its buildings have
// `shelter`); then that decides, and `lines` only which side is the back.
export function shelterOf(b: { kind: string; h: number; rings: Point2[][]; shelter?: 1 }, lines: StopLine[], marked: boolean): Shelter | null {
  if (marked ? !b.shelter : !KINDS.has(b.kind) || !(b.h <= HEIGHT)) return null;
  if (b.rings.length !== 1) return null;
  const pts = b.rings[0];
  if (pts.length < 3 || (!marked && pts.length > 8)) return null;
  let mx = 0, my = 0;
  for (const [x, y] of pts) { mx += x; my += y; }
  mx /= pts.length; my /= pts.length;
  // Its long axis, and its size along and across it.
  let sxx = 0, syy = 0, sxy = 0;
  for (const [x, y] of pts) { sxx += (x - mx) ** 2; syy += (y - my) ** 2; sxy += (x - mx) * (y - my); }
  const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy), c = Math.cos(ang), s = Math.sin(ang);
  let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
  for (const [x, y] of pts) {
    const a = (x - mx) * c + (y - my) * s, v = -(x - mx) * s + (y - my) * c;
    a0 = Math.min(a0, a); a1 = Math.max(a1, a); b0 = Math.min(b0, v); b1 = Math.max(b1, v);
  }
  const length = a1 - a0, depth = b1 - b0;
  if (!marked && (depth < DEPTH[0] || depth > DEPTH[1] || length < LENGTH[0] || length > LENGTH[1] || length < NARROW * depth)) return null;
  if (marked && (depth > DEPTH[1] * 2 || length > LENGTH[1] * 2)) return null; // a bus station's hall: left a building
  const x = mx + c * (a0 + a1) / 2 - s * (b0 + b1) / 2, y = my + s * (a0 + a1) / 2 + c * (b0 + b1) / 2;
  const near = nearestAlong(x, y, c, s, marked ? lines.map((l) => ({ ...l, reach: Infinity })) : lines.filter((l) => l.track));
  if (!near && !marked) return null;
  // The back is the side away from the track or street.
  const back = near && -(near[0] - x) * s + (near[1] - y) * c > 0 ? -1 : 1;
  return { x, y, c, s, length, depth, back };
}

// The nearest point of a line within its reach whose direction there runs along (c, s).
function nearestAlong(x: number, y: number, c: number, s: number, lines: StopLine[]): Point2 | null {
  let best: Point2 | null = null, bestD = Infinity;
  for (const { pts, reach } of lines) for (let i = 0; i + 1 < pts.length; i++) {
    const [ax, ay] = pts[i], [bx, by] = pts[i + 1], dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    if (!l2) continue;
    const u = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2));
    const px = ax + u * dx, py = ay + u * dy, d = Math.hypot(x - px, y - py);
    if (d > reach || d >= bestD) continue;
    if (Math.abs((dx * c + dy * s) / Math.sqrt(l2)) < ALONG) continue;
    best = [px, py]; bestD = d;
  }
  return best;
}

// Where shelters may stand in a tile: by its tram tracks, and by its streets (a bus stop's).
const BY_TRACK = 9; // m from a track's middle
const BY_STREET = 7; // m beyond a street's edge
export function stopLines(t: { rails?: { kind: string; pts: Point2[] }[]; drive?: { pts: Point2[]; width: number }[] }): StopLine[] {
  return [
    ...(t.rails ?? []).filter((r) => r.kind === 'tram').map((r) => ({ pts: r.pts, reach: BY_TRACK, track: true })),
    ...(t.drive ?? []).map((e) => ({ pts: e.pts, reach: e.width / 2 + BY_STREET })),
  ];
}

const lin = (u: number) => (u <= 0.04045 ? u / 12.92 : Math.pow((u + 0.055) / 1.055, 2.4));
const rgb = (hex: string): [number, number, number] => [1, 3, 5].map((i) => lin(parseInt(hex.slice(i, i + 2), 16) / 255)) as [number, number, number];
// Prague's new shelters (from 2022): near-black steel, a thin flat roof running forward
// over the platform from posts along the back, an advertising light box at one end that
// is also a post, a bench along the back, and a low railing carrying on beyond the other
// end. Their glass back wall and side pane aren't drawn: the game can't make them see-
// through, and from above they would only cast a shadow the real glass doesn't.
const STEEL = rgb('#26292b'), POSTER = rgb('#d9dcd6'), BENCH = rgb('#5b4a38');
const ROOF_AT = 2.6, ROOF = 0.12, POST = 0.1, OVERHANG = 0.4, RAIL = 0.05;

// A shelter's parts (roofDetails.ts Part, drawn by partArrays at the ground's height).
export function shelterParts(sh: Shelter): Part[] {
  const { c, s, length, back } = sh, depth = Math.max(1.5, Math.min(2.2, sh.depth));
  const put = (u: number, v: number) => ({ x: sh.x + c * u - s * v, y: sh.y + s * u + c * v, c, s });
  const box = (u: number, v: number, a: number, b: number, h: number, lift: number, rgb: Part['rgb'], side = STEEL): Part =>
    ({ shape: 'box', ...put(u, v), a, b, h, lift, rgb, side, top: 0 });
  const backV = back * (depth / 2 - POST); // the line of the posts
  const parts: Part[] = [
    // The roof, reaching a little further forward than the outline.
    box(0, -back * OVERHANG / 2, length, depth + OVERHANG, ROOF, ROOF_AT, STEEL),
    // The light box across one end, from the back nearly to the roof's front edge.
    box(length / 2 - 0.15, back * 0.1, 0.25, Math.min(1.4, depth - 0.3), ROOF_AT, 0, STEEL, POSTER),
    // A bench along the back.
    box(-0.2, back * (depth / 2 - 0.4), Math.min(2.4, length - 1.4), 0.4, 0.45, 0, BENCH),
  ];
  const posts = Math.max(2, Math.round(length / 3) + 1);
  for (let i = 1; i < posts; i++) { // (the light box stands for the first)
    const u = length / 2 - 0.15 - (i * (length - 0.15 - POST)) / (posts - 1);
    parts.push(box(u, backV, POST, POST, ROOF_AT, 0, STEEL));
  }
  // The railing beyond the other end: two posts and a top rail, 1 m high, 2 m long.
  const r0 = -length / 2 - 0.3, r1 = r0 - 2;
  for (const u of [r0, r1]) parts.push(box(u, backV, RAIL, RAIL, 1, 0, STEEL));
  parts.push(box((r0 + r1) / 2, backV, 2 + RAIL, RAIL, RAIL, 0.95, STEEL), box((r0 + r1) / 2, backV, 2, RAIL * 0.6, RAIL * 0.6, 0.35, STEEL));
  return parts;
}
