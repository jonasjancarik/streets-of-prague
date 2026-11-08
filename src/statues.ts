import * as THREE from 'three';
import proj4 from 'proj4';
import { difference } from 'polyclip-ts';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { cutAway } from './shading.ts';
import { rng, hash } from './map/geo.ts';
import type { Bounds, Point2, Polygons } from './map/geo.ts';
import type { TileStructure } from './contracts.ts';
import bridge from './charlesBridge.json';

// Charles Bridge: its piers and the thirty statues and groups on its parapets, and
// Bruncvík on his column beside it, from OSM (pipeline/charles_bridge.py writes
// charlesBridge.json). OSM's outline of the bridge takes in the piers' cutwaters, a
// triangle out from the parapet on each side of every pier, which the map raises to
// the deck's height. Here they come off the deck (the parapet runs straight across
// where they were) and stand as piers some 4 m below it, and the statue of each pier
// stands on the parapet above it, its pedestal out over the pier, facing the walkway.
// The figures are simple stone saints, blackened as the sandstone originals are: from
// above it's their heads and shoulders, the odd gilded halo, and their long shadows.

// What a statue is, beyond its number of figures: Nepomuk in bronze with his halo of
// stars, the Calvary with its crucifix, the Pietà, a Madonna with her halo and the
// child, a group on a rock, Bruncvík on his column. `attr`: what the saint holds.
type Look = 'plain' | 'nepomuk' | 'calvary' | 'pieta' | 'madonna' | 'rock' | 'bruncvik';
type Attr = 'book' | 'cross' | 'staff' | 'child' | 'lance' | 'shoulder';
interface Spec { figures: number; look?: Look; attr?: Attr; scale?: number }

// By OSM's name.
const SPECS: Record<string, Spec> = {
  'svatý Salvator se svatými Kosmou a Damiánem': { figures: 3 },
  'svatý Vít': { figures: 1, look: 'rock', attr: 'book' },
  'svatý Filip Benicius': { figures: 1, attr: 'cross' },
  'svatý Kajetán': { figures: 1, attr: 'book' },
  'svatý Augustin': { figures: 1, attr: 'staff' },
  'svatý Juda Tadeáš': { figures: 1, attr: 'book' },
  'svatý Antonín Paduánský': { figures: 1, attr: 'child' },
  'svatý Jan Nepomucký': { figures: 1, look: 'nepomuk' },
  'svatí Norbert, Václav a Zikmund': { figures: 3, attr: 'staff' },
  'svatý Jan Křtitel': { figures: 1, attr: 'cross' },
  'svatí Cyril a Metoděj': { figures: 3, look: 'rock', attr: 'staff' },
  'svatá Anna': { figures: 2, attr: 'child' },
  'svatý Kříž s Kalvárií': { figures: 2, look: 'calvary' },
  'Madona se svatými Dominikem a Tomášem Akvinským': { figures: 3, look: 'madonna' },
  'Madona se svatým Bernardem': { figures: 2, look: 'madonna' },
  'svatý Václav': { figures: 1, attr: 'lance' },
  'svatí Jan z Mathy, Felix z Valois a Ivan': { figures: 3, look: 'rock' },
  'svatý Vojtěch': { figures: 1, attr: 'staff' },
  'svatá Luitgarda': { figures: 2, look: 'rock', attr: 'cross' },
  'svatý Mikuláš Tolentinský': { figures: 1, attr: 'book' },
  'svatý Vincenc Ferrerský a svatý Prokop': { figures: 2, look: 'rock', attr: 'staff' },
  'svatý František Serafinský': { figures: 1, attr: 'cross' },
  'svatá Ludmila': { figures: 2, attr: 'child' },
  'svatý František Borgia': { figures: 2, attr: 'book' },
  'svatý Kryštof': { figures: 1, attr: 'shoulder', scale: 1.15 },
  'svatý František Xaverský': { figures: 3, look: 'rock', attr: 'cross' },
  'svatý Josef': { figures: 1, attr: 'child' },
  'Pieta': { figures: 3, look: 'pieta' },
  'svaté Barbora, Markéta a Alžběta': { figures: 3, attr: 'book' },
  'svatý Ivo': { figures: 2, attr: 'book' },
  'Bruncvík': { figures: 1, look: 'bruncvik' },
};

// A statue in the game's metres: where its pedestal stands, the way it faces (a unit
// vector, into the bridge) and its pedestal's half-sizes along and across the parapet.
export interface Statue { name: string; x: number; y: number; fx: number; fy: number; half: [number, number]; spec: Spec }
// A pier: its cutwater's outline (from one end of the parapet line across it round to
// the other), the way out from the deck, and what is cut off the deck (`cutter`, a
// polygon beyond the parapet line; null where the deck keeps it).
export interface Pier { outline: Point2[]; base: [Point2, Point2]; out: Point2; cutter: Point2[] | null }
export interface Bridge { statues: Statue[]; piers: Pier[] }

const PEDESTAL_D = 1.9; // m across the parapet
const OUT = 0.35; // m: how far the pedestal's middle stands out from the parapet line
const pedestalL = (s: Spec) => (s.figures >= 3 || s.look === 'calvary' ? 2.9 : s.figures === 2 ? 2.5 : 2.2);

// The bridge in the map's local metres (a transverse Mercator centred on its box);
// nothing where the map doesn't reach it.
export function placeBridge([w0, s0, e0, n0]: [number, number, number, number]): Bridge {
  const local = `+proj=tmerc +lat_0=${(s0 + n0) / 2} +lon_0=${(w0 + e0) / 2} +k=1 +x_0=0 +y_0=0 +ellps=WGS84 +units=m`;
  const [bw, bs] = bridge.piers[0].base[0];
  if (!(bw > w0 && bw < e0 && bs > s0 && bs < n0)) return { statues: [], piers: [] };
  const to = (p: number[]) => proj4('EPSG:4326', local, p) as Point2;
  const piers: (Pier & { names: string[] })[] = bridge.piers.map((p) => {
    const a = to(p.base[0]), b = to(p.base[1]), outline = p.outline.map(to);
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]), ux = (b[0] - a[0]) / len, uy = (b[1] - a[1]) / len;
    // Out from the deck: the side of the parapet line the cutwater is on.
    const cx = outline.reduce((s, q) => s + q[0], 0) / outline.length, cy = outline.reduce((s, q) => s + q[1], 0) / outline.length;
    const k = (cx - a[0]) * -uy + (cy - a[1]) * ux > 0 ? 1 : -1, nx = -uy * k, ny = ux * k;
    const reach = Math.max(...outline.map((q) => (q[0] - a[0]) * nx + (q[1] - a[1]) * ny)) + 0.5;
    const cutter: Point2[] | null = p.cut ? [[a[0] - ux * 0.2, a[1] - uy * 0.2], [b[0] + ux * 0.2, b[1] + uy * 0.2],
      [b[0] + ux * 0.2 + nx * reach, b[1] + uy * 0.2 + ny * reach], [a[0] - ux * 0.2 + nx * reach, a[1] - uy * 0.2 + ny * reach]] : null;
    return { outline, base: [a, b], out: [nx, ny], cutter, names: p.statues };
  });
  const statues: Statue[] = [];
  for (const { name, at } of bridge.statues) {
    const spec = SPECS[name], pier = piers.find((p) => p.names.includes(name));
    if (!spec || !pier) continue;
    const [a, b] = pier.base, [nx, ny] = pier.out, L = pedestalL(spec);
    if (spec.look === 'bruncvik') {
      const [x, y] = to(at);
      statues.push({ name, x, y, fx: nx, fy: ny, half: [0.6, 0.6], spec });
      continue;
    }
    // On the parapet line, across from where OSM has it (on the pier), out over the pier.
    const [px, py] = to(at), len = Math.hypot(b[0] - a[0], b[1] - a[1]), ux = (b[0] - a[0]) / len, uy = (b[1] - a[1]) / len;
    const along = Math.min(Math.max((px - a[0]) * ux + (py - a[1]) * uy, Math.min(L / 2 + 0.3, len / 2)), Math.max(len - L / 2 - 0.3, len / 2));
    statues.push({ name, x: a[0] + ux * along + nx * OUT, y: a[1] + uy * along + ny * OUT, fx: -nx, fy: -ny, half: [L / 2, PEDESTAL_D / 2], spec });
  }
  return { statues, piers: piers.map(({ names: _, ...p }) => p) };
}

// A tile's structures with the cutwaters off the bridge decks.
export function clipDecks(structures: TileStructure[], piers: Pier[], [x0, y0, x1, y1]: Bounds): TileStructure[] {
  const cutters = piers.flatMap((p) => (p.cutter && p.cutter.some(([x, y]) => x > x0 - 30 && x < x1 + 30 && y > y0 - 30 && y < y1 + 30) ? [[p.cutter]] : []));
  if (!cutters.length) return structures;
  return structures.map((s) => {
    if (s.kind !== 'bridge') return s;
    const polys = difference(s.polys as [number, number][][][], ...(cutters as [number, number][][][])) as Polygons;
    // (Its rings come back closed; the map's are open.)
    for (const rings of polys) for (const ring of rings) {
      const f = ring[0], l = ring[ring.length - 1];
      if (ring.length > 3 && f[0] === l[0] && f[1] === l[1]) ring.pop();
    }
    return { ...s, polys };
  });
}

// Whether a point is inside a statue's pedestal (with `pad` metres round it).
export function inPedestal(s: Statue, x: number, y: number, pad = 0) {
  if (s.spec.look === 'bruncvik') return false;
  const dx = x - s.x, dy = y - s.y;
  const across = dx * s.fx + dy * s.fy, along = dx * s.fy - dy * s.fx;
  return Math.abs(along) <= s.half[0] + pad && Math.abs(across) <= s.half[1] + pad;
}

const STONE = '#8b8170', STONE_DARK = '#6f6656', PIER = '#8a826f', FIGURE = '#4f4940', FIGURE_DARK = '#3e3933';
const BRONZE = '#38322b', GOLD = '#d4a742';
const PIER_DROP = 4.3; // m: a pier's top below the deck
const PIER_FOOT = 16; // m: and its foot (under the water)

// Parts in a statue's own frame: x along the parapet, y up, z the way it faces. Their
// colour is lighter on what faces up, as weathered stone is.
class Parts {
  list: THREE.BufferGeometry[] = [];
  r: () => number;
  constructor(r: () => number) { this.r = r; }
  add(g: THREE.BufferGeometry, color: string, m?: THREE.Matrix4, flat = false) {
    const geo = g.index ? g.toNonIndexed() : g;
    if (geo !== g) g.dispose();
    geo.deleteAttribute('uv');
    if (m) geo.applyMatrix4(m);
    if (flat) geo.computeVertexNormals();
    const c = new THREE.Color(color).multiplyScalar(0.94 + this.r() * 0.12), n = geo.attributes.normal;
    const col = new Float32Array(geo.attributes.position.count * 3), v = new THREE.Color();
    for (let i = 0; i < n.count; i++) v.copy(c).multiplyScalar(0.82 + 0.38 * Math.max(0, n.getY(i))).toArray(col, i * 3);
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.list.push(geo);
    return geo;
  }
  box(w: number, h: number, d: number, x: number, y: number, z: number, color: string, m?: THREE.Matrix4) {
    return this.add(new THREE.BoxGeometry(w, h, d).translate(x, y, z), color, m);
  }
}

const mat = (x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, s = 1) =>
  new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz, 'YXZ')), new THREE.Vector3(s, s, s));
const times = (a: THREE.Matrix4, b: THREE.Matrix4) => new THREE.Matrix4().multiplyMatrices(a, b);

// A ring of five gilded stars over a head (Nepomuk's, the Madonna's).
function halo(p: Parts, at: THREE.Matrix4, y: number) {
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    p.add(new THREE.OctahedronGeometry(0.08), GOLD, times(at, mat(Math.cos(a) * 0.28, y, Math.sin(a) * 0.28 - 0.06)));
  }
}

// A saint's body turned on a lathe: the robe flaring to the plinth, the waist, the
// chest and shoulders, the neck; 2.2 m to the neck (the statues are larger than life).
const BODY = [[0, 0], [0.5, 0], [0.5, 0.1], [0.44, 0.5], [0.38, 0.95], [0.31, 1.3], [0.32, 1.5], [0.37, 1.7], [0.39, 1.84],
  [0.27, 1.96], [0.1, 2.02], [0.09, 2.12], [0, 2.12]].map(([r, y]) => new THREE.Vector2(r, y));
const SHOULDER = 1.86, NECK = 2.12;
const SEATED = BODY.map((v) => new THREE.Vector2(v.x * (v.y < 0.9 ? 1.25 : 1), v.y < 0.9 ? v.y * 0.55 : v.y - 0.4));

// One figure, standing (or seated) at `at`, facing +z, with its arms in a pose of its
// own and what it holds. Returns the height of the top of its head.
function figure(p: Parts, at: THREE.Matrix4, color: string, { scale = 1, seated = false, attr = null as Attr | null, mitre = false } = {}) {
  const r = p.r;
  const m = times(at, mat(0, 0, 0, (r() - 0.5) * 0.08, 0, (r() - 0.5) * 0.1, scale * 1.1));
  const drop = seated ? 0.4 : 0;
  p.add(new THREE.LatheGeometry(seated ? SEATED : BODY, 12).scale(1, 1, 0.74), color, m);
  // The drapery: a mantle swept across the body from one hip to the other shoulder, and
  // the cloak hanging behind.
  const side = r() < 0.5 ? -1 : 1;
  p.add(new THREE.CapsuleGeometry(0.12, 0.75 - drop * 0.5, 3, 8).scale(1.6, 1, 0.45), FIGURE_DARK, times(m, mat(side * 0.05, 1.0 - drop * 0.7, 0.24, 0.1, 0, side * 0.55)));
  p.add(new THREE.CylinderGeometry(0.36, 0.5, 1.75 - drop, 10, 1, true, Math.PI * 0.6, Math.PI * 0.8).translate(0, (1.75 - drop) / 2, -0.1),
    FIGURE_DARK, times(m, mat(0, 0, 0, -0.06)));
  const head = NECK - drop + 0.13;
  p.add(new THREE.IcosahedronGeometry(0.17, 1).scale(1, 1.12, 1), color, times(m, mat(0, head, 0.02)));
  if (mitre) p.add(new THREE.ConeGeometry(0.13, 0.32, 4), color, times(m, mat(0, head + 0.25, 0, 0, Math.PI / 4)));
  // The arms: from the shoulder to the elbow in a wide sleeve, then the forearm.
  const POSES: [number, number, number][] = [[-2.5, 0.25, -0.3], [-1.25, 0.15, -0.55], [-0.5, -0.35, -1.9], [-0.15, 0.12, -0.4], [-0.8, 0.65, -0.5]];
  const hands: THREE.Matrix4[] = [];
  for (const k of [-1, 1]) {
    const [pitch, roll, elbow] = attr && k === 1 ? POSES[1] : POSES[Math.floor(r() * POSES.length)];
    const shoulder = times(m, mat(k * 0.38, SHOULDER - drop, 0, pitch, 0, k * roll));
    p.add(new THREE.CylinderGeometry(0.1, 0.15, 0.36, 7).translate(0, -0.18, 0), color, shoulder);
    const fore = times(shoulder, mat(0, -0.34, 0, elbow));
    p.add(new THREE.CylinderGeometry(0.06, 0.08, 0.34, 6).translate(0, -0.17, 0), color, fore);
    hands.push(times(fore, mat(0, -0.38, 0)));
  }
  const hand = hands[1];
  if (attr === 'book') p.box(0.3, 0.06, 0.24, 0, 0, 0.05, color, hand);
  if (attr === 'cross') {
    p.box(0.06, 0.95, 0.06, 0, 0.15, 0.08, color, hand);
    p.box(0.38, 0.06, 0.06, 0, 0.4, 0.08, color, hand);
  }
  if (attr === 'child') figure(p, times(hand, mat(-0.1, -0.15, 0.12, 0, 0.3, 0, 0.32)), color);
  // A bishop's or an abbot's crozier, and Wenceslas's lance with its banner, stand on the plinth beside them.
  if (attr === 'staff' || attr === 'lance') {
    const tall = attr === 'lance' ? 3.4 : 2.7, staff = times(m, mat(0.62, 0, 0.18, 0, 0, -0.04));
    p.add(new THREE.CylinderGeometry(0.035, 0.035, tall, 5).translate(0, tall / 2, 0), color, staff);
    if (attr === 'staff') p.add(new THREE.TorusGeometry(0.12, 0.035, 4, 8, Math.PI * 1.5), color, times(staff, mat(-0.1, tall + 0.05, 0)));
    else p.box(0.04, 0.5, 0.75, 0, tall - 0.35, -0.38, color, staff);
  }
  // Christopher, carrying the child on his shoulder.
  if (attr === 'shoulder') figure(p, times(m, mat(-0.22, SHOULDER + 0.02, -0.02, 0, 0.4, 0, 0.32)), color, { seated: true });
  return head * scale * 1.1 + 0.15;
}

// One statue on its pedestal, standing on the deck at y = 0, in its own frame.
function statueParts(s: Statue) {
  const p = new Parts(rng(Math.floor(hash(s.name) * 1e9))), r = p.r, spec = s.spec;
  const L = s.half[0] * 2, D = s.half[1] * 2, n = spec.figures, look = spec.look ?? 'plain';
  const at = (x: number, y: number, z: number, ry = 0) => mat(x, y, z, 0, ry, 0);
  if (look === 'bruncvik') {
    // The column rises from the pier; the knight with his gilded sword, the lion at his feet.
    p.add(new THREE.CylinderGeometry(0.4, 0.48, 9, 12).translate(0, -4.3, 0), STONE);
    p.box(1.2, 0.3, 1.2, 0, 0.3, 0, STONE_DARK);
    p.box(1.0, 0.25, 1.0, 0, 0.55, 0, STONE);
    const top = mat(0, 0.68, 0);
    p.add(new THREE.IcosahedronGeometry(1, 1).scale(0.22, 0.25, 0.5), FIGURE_DARK, times(top, mat(0.3, 0.2, 0.05)));
    const head = figure(p, top, FIGURE, { scale: 0.85 });
    p.box(0.06, 1.0, 0.06, 0.38, head * 0.6, 0.25, GOLD, times(top, mat(0, 0, 0, 0.5, 0, -0.3)));
    return p.list;
  }
  // The pedestal: its foot on the pier below and the parapet's height above the deck,
  // a moulding, the die with a relief on its face, the cornice and the top slab.
  p.box(L + 0.1, PIER_DROP + 1.15, D + 0.1, 0, (1.15 - PIER_DROP) / 2, 0, STONE_DARK);
  p.box(L + 0.24, 0.2, D + 0.24, 0, 1.25, 0, STONE);
  p.box(L - 0.25, 1.65, D - 0.3, 0, 2.18, 0, STONE);
  p.box(L - 0.75, 1.0, 0.06, 0, 2.15, (D - 0.3) / 2 + 0.03, STONE_DARK);
  p.box(L + 0.14, 0.2, D + 0.1, 0, 3.1, 0, STONE);
  p.box(L - 0.05, 0.15, D - 0.1, 0, 3.27, 0, STONE_DARK);
  const top = 3.35;
  let floor = top;
  if (look === 'rock' || look === 'pieta') {
    // The groups stand on a rough rock, which piles up behind them.
    p.add(new THREE.IcosahedronGeometry(1, 1).scale(L * 0.5, 0.6, D * 0.45), FIGURE_DARK, mat(0, top + 0.15, -0.12), true);
    p.add(new THREE.IcosahedronGeometry(1, 0).scale(L * 0.25, 0.7, D * 0.25), FIGURE_DARK, mat((r() - 0.5) * L * 0.4, top + 0.5, -0.45), true);
    floor = top + 0.32;
  }
  if (look === 'calvary') {
    // The crucifix in bronze with its gilded inscription arched over it; Mary and John below.
    const cz = -0.4;
    p.box(0.24, 5.0, 0.22, 0, top + 2.5, cz, BRONZE);
    p.box(2.2, 0.22, 0.22, 0, top + 4.1, cz, BRONZE);
    p.add(new THREE.CylinderGeometry(0.16, 0.12, 1.5, 6).translate(0, top + 3.2, cz + 0.2), BRONZE);
    p.box(1.8, 0.11, 0.12, 0, top + 3.98, cz + 0.2, BRONZE);
    p.add(new THREE.IcosahedronGeometry(0.13, 1), BRONZE, mat(0.08, top + 4.05, cz + 0.25));
    for (let i = -5; i <= 5; i++) {
      const a = (i / 5) * 1.1;
      p.box(0.2, 0.09, 0.05, Math.sin(a) * 1.35, top + 2.8 + Math.cos(a) * 1.35, cz + 0.12, GOLD, mat(0, 0, 0, 0, 0, -a));
    }
    figure(p, at(-L * 0.32, floor, 0.3, 0.45), FIGURE, { scale: 0.92 });
    figure(p, at(L * 0.32, floor, 0.3, -0.45), FIGURE, { scale: 0.92 });
    return p.list;
  }
  // Places on the pedestal for one, two or three figures: side by side along it, a
  // third behind and above the others.
  const spots: [number, number, number, number][] = n === 1 ? [[0, 0, 0.05, 0]]
    : n === 2 ? [[-L * 0.22, 0, 0.12, 0.3], [L * 0.22, 0.1, -0.05, -0.3]]
      : [[-L * 0.3, 0, 0.28, 0.4], [L * 0.3, 0, 0.22, -0.4], [0, 0.4, -0.35, 0]];
  spots.forEach(([x, y, z, ry], i) => {
    const where = at(x, floor + y, z, ry + (r() - 0.5) * 0.3);
    const scale = (spec.scale ?? 1) * (n === 3 && i < 2 ? 0.9 : n === 2 && i === 0 ? 0.95 : 1);
    if (look === 'pieta' && i === 0) {
      // Mary seated, with Christ lying across her lap.
      figure(p, where, FIGURE, { seated: true });
      p.add(new THREE.CapsuleGeometry(0.17, 1.4, 3, 6).rotateZ(Math.PI / 2 - 0.25), FIGURE, times(where, mat(0.25, 0.95, 0.42, 0, 0.35)));
      return;
    }
    const nepomuk = look === 'nepomuk', madonna = look === 'madonna' && i === 0;
    // The main figure holds the attribute (the child, for a Madonna); bishops wear the mitre.
    const attr = madonna ? 'child' : i === 0 || n === 1 ? spec.attr ?? null : null;
    const head = figure(p, where, nepomuk ? BRONZE : FIGURE, { scale, attr: nepomuk ? 'cross' : attr, mitre: attr === 'staff' });
    if (nepomuk || madonna) halo(p, where, head + 0.12);
  });
  return p.list;
}

// A pier: its cutwater from the outline, capped with stone sloping down to the tip
// from some 4 m below the deck (`h`), its sides down under the water; and its body
// under the deck, in from the parapet to the bridge's middle.
function pierParts(pier: Pier, h: number) {
  const p = new Parts(rng(7)), [a] = pier.base, [nx, ny] = pier.out, top = h - PIER_DROP, foot = h - PIER_FOOT;
  const out = (x: number, y: number) => (x - a[0]) * nx + (y - a[1]) * ny, reach = Math.max(...pier.outline.map(([x, y]) => out(x, y)), 1);
  const capAt = (x: number, y: number) => top - 1.1 * Math.min(1, Math.max(0, out(x, y) / reach));
  const prism = (ring: Point2[], at: (x: number, y: number) => number, color: string) => {
    const shape = ring.map(([x, y]) => new THREE.Vector2(x, y));
    if (THREE.ShapeUtils.isClockWise(shape)) shape.reverse();
    const pos: number[] = [];
    // (Counter-clockwise from above, which faces up once y is flipped to -z.)
    for (const tri of THREE.ShapeUtils.triangulateShape(shape, [])) for (const v of tri) pos.push(shape[v].x, at(shape[v].x, shape[v].y), -shape[v].y);
    for (let i = 0; i < shape.length; i++) {
      const u = shape[i], w = shape[(i + 1) % shape.length], hu = at(u.x, u.y), hw = at(w.x, w.y);
      pos.push(u.x, hu, -u.y, u.x, foot, -u.y, w.x, foot, -w.y, u.x, hu, -u.y, w.x, foot, -w.y, w.x, hw, -w.y);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.computeVertexNormals();
    p.add(g, color);
  };
  prism(pier.outline, capAt, PIER);
  const [b] = pier.base.slice(1), inX = -nx * 5.6, inY = -ny * 5.6;
  prism([a, b, [b[0] + inX, b[1] + inY], [a[0] + inX, a[1] + inY]], () => h - 1.25, STONE_DARK);
  return p.list;
}

let depth: THREE.MeshDepthMaterial | null = null;

// The piers and statues in a tile, as one mesh: each statue on the deck at its height,
// each pier below it (`deck(x, y)`: the deck at or near a point, null where there's
// none; then it isn't drawn). The mesh is the tile's own, material and all, as its
// other fixtures are.
export function bridgeMesh({ statues, piers }: Bridge, [x0, y0, x1, y1]: Bounds, deck: (x: number, y: number) => number | null) {
  const parts: THREE.BufferGeometry[] = [];
  const inside = (x: number, y: number) => x >= x0 && x < x1 && y >= y0 && y < y1;
  for (const s of statues) {
    if (!inside(s.x, s.y)) continue;
    const h = deck(s.x, s.y);
    if (h === null) continue;
    // Its frame in the scene: the game's (x, height, -y), turned so +z faces (fx, fy).
    const m = new THREE.Matrix4().compose(new THREE.Vector3(s.x, h, -s.y),
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(s.fx, -s.fy)), new THREE.Vector3(1, 1, 1));
    for (const g of statueParts(s)) { g.applyMatrix4(m); parts.push(g); }
  }
  for (const pier of piers) {
    if (!pier.cutter) continue;
    const [a, b] = pier.base, mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
    if (!inside(mx, my)) continue;
    const h = deck(mx - pier.out[0] * 1.5, my - pier.out[1] * 1.5);
    if (h !== null) parts.push(...pierParts(pier, h));
  }
  if (!parts.length) return null;
  const geometry = mergeGeometries(parts, false)!;
  parts.forEach((g) => g.dispose());
  depth ??= new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  const mesh = new THREE.Mesh(geometry, cutAway(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 }), 'furniture'));
  mesh.name = 'Charles Bridge statues';
  mesh.customDepthMaterial = depth;
  mesh.castShadow = mesh.receiveShadow = true;
  return mesh;
}
