// Stop shelters. OpenStreetMap has many of Prague's tram and bus stop shelters as small
// buildings (building=yes with amenity=shelter, shelter_type=public_transport), which
// IPR's 3D model doesn't have, so the game raised them from their outlines as little
// houses with tiled roofs on the platforms. Maps built after this change mark them
// (`shelter`, pipeline/osm_area.py). In older maps, which don't, a building is taken for
// one by its outline and place: small, narrow and low, its long side along a tram track
// close by. (Along streets too, that caught substations, garages and a bakery: 36 of 121
// across Prague were not shelters; by the tracks all 32 were.) Instead of a house, a
// shelter as Prague's are stands in the outline: a flat glass roof in a dark
// frame on posts along the back, an advertising panel across one end and a bench under
// the roof. Made up: the shelter's parts and where they go; the place and size are OSM's.
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
const FRAME = rgb('#3d4346'), GLASS = rgb('#7f949b'), PANEL = rgb('#d9dcd6'), WOOD = rgb('#7a6448');
const ROOF_AT = 2.45, ROOF = 0.1, POST = 0.08;

// A shelter's parts (roofDetails.ts Part, drawn by partArrays at the ground's height).
export function shelterParts(sh: Shelter): Part[] {
  const { c, s, length, back } = sh, depth = Math.max(1.5, Math.min(2.2, sh.depth));
  const put = (u: number, v: number) => ({ x: sh.x + c * u - s * v, y: sh.y + s * u + c * v, c, s });
  const parts: Part[] = [
    // The roof: glass in a dark frame (a roof window's look, facade w 10).
    { shape: 'skylight', ...put(0, 0), a: length, b: depth, h: ROOF, lift: ROOF_AT, rgb: GLASS, side: FRAME, top: 10 },
    // An advertising panel across one end.
    { shape: 'box', ...put(length / 2 - 0.15, 0), a: 0.18, b: Math.min(1.3, depth - 0.2), h: 2.15, lift: 0.1, rgb: FRAME, side: PANEL, top: 0 },
    // A bench along the back.
    { shape: 'box', ...put(-0.3, back * (depth / 2 - 0.45)), a: Math.min(2.4, length - 1.4), b: 0.4, h: 0.45, rgb: WOOD, side: FRAME, top: 0 },
  ];
  const posts = Math.max(2, Math.round(length / 3) + 1);
  for (let i = 0; i < posts; i++) {
    const u = -length / 2 + POST + (i * (length - 2 * POST)) / (posts - 1);
    parts.push({ shape: 'box', ...put(u, back * (depth / 2 - POST)), a: POST, b: POST, h: ROOF_AT, rgb: FRAME, side: FRAME, top: 0 });
  }
  return parts;
}
