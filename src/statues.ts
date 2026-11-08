import * as THREE from 'three';
import proj4 from 'proj4';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { cutAway } from './shading.ts';
import { rng, hash } from './map/geo.ts';
import type { Bounds, Point2 } from './map/geo.ts';

// The thirty statues and groups along Charles Bridge's parapets, and Bruncvík on his
// column beside it, where OSM has them (memorial=statue). Each stands on its pedestal
// over a pier, facing the walkway. They're simple stone figures, blackened as the
// sandstone originals are: from above, what shows is their heads and shoulders, a
// gilded halo here and there, and their long shadows across the bridge.

// What a statue looks like, beyond its number of figures: Nepomuk in bronze with his
// halo of stars, the Calvary with its crucifix, the Pietà, a Madonna with her halo, a
// group on a rock, and Bruncvík on his column.
type Look = 'plain' | 'nepomuk' | 'calvary' | 'pieta' | 'madonna' | 'rock' | 'bruncvik';
interface Spec { name: string; at: [number, number]; side: 'n' | 's'; figures: number; look?: Look }

// [lon, lat] from OSM, west (Malá Strana) to east (Old Town) on each side.
const SPECS: Spec[] = [
  { name: 'Salvator, Kosmas a Damián', at: [14.4073533, 50.0871792], side: 'n', figures: 3 },
  { name: 'Vít', at: [14.4077302, 50.087095], side: 'n', figures: 1, look: 'rock' },
  { name: 'Filip Benicius', at: [14.4081475, 50.0870133], side: 'n', figures: 1 },
  { name: 'Kajetán', at: [14.4085683, 50.086937], side: 'n', figures: 1 },
  { name: 'Augustin', at: [14.4089848, 50.0868498], side: 'n', figures: 1 },
  { name: 'Juda Tadeáš', at: [14.4094202, 50.0867842], side: 'n', figures: 1 },
  { name: 'Antonín Paduánský', at: [14.40982, 50.0867124], side: 'n', figures: 1 },
  { name: 'Jan Nepomucký', at: [14.410249, 50.0866796], side: 'n', figures: 1, look: 'nepomuk' },
  { name: 'Norbert, Václav a Zikmund', at: [14.4106731, 50.0866287], side: 'n', figures: 3 },
  { name: 'Jan Křtitel', at: [14.4111014, 50.0865766], side: 'n', figures: 1 },
  { name: 'Cyril a Metoděj', at: [14.4115165, 50.0865268], side: 'n', figures: 3, look: 'rock' },
  { name: 'Anna', at: [14.4119476, 50.0864768], side: 'n', figures: 2 },
  { name: 'Kříž s Kalvárií', at: [14.4123911, 50.0864369], side: 'n', figures: 2, look: 'calvary' },
  { name: 'Madona, Dominik a Tomáš Akvinský', at: [14.4127948, 50.0863702], side: 'n', figures: 3, look: 'madonna' },
  { name: 'Madona a Bernard', at: [14.4132146, 50.0863006], side: 'n', figures: 2, look: 'madonna' },
  { name: 'Václav', at: [14.4073042, 50.0870766], side: 's', figures: 1 },
  { name: 'Jan z Mathy, Felix z Valois a Ivan', at: [14.4076799, 50.0869887], side: 's', figures: 3, look: 'rock' },
  { name: 'Vojtěch', at: [14.4081004, 50.0869101], side: 's', figures: 1 },
  { name: 'Luitgarda', at: [14.4085203, 50.0868476], side: 's', figures: 2, look: 'rock' },
  { name: 'Mikuláš Tolentinský', at: [14.4089529, 50.0867618], side: 's', figures: 1 },
  { name: 'Vincenc Ferrerský a Prokop', at: [14.4093779, 50.0866842], side: 's', figures: 2, look: 'rock' },
  { name: 'František Serafinský', at: [14.4097898, 50.0866136], side: 's', figures: 1 },
  { name: 'Ludmila', at: [14.4102121, 50.0865599], side: 's', figures: 2 },
  { name: 'František Borgia', at: [14.4106414, 50.0865084], side: 's', figures: 1 },
  { name: 'Kryštof', at: [14.4110666, 50.0864601], side: 's', figures: 1 },
  { name: 'František Xaverský', at: [14.4114886, 50.0864162], side: 's', figures: 3, look: 'rock' },
  { name: 'Josef', at: [14.4119144, 50.0863697], side: 's', figures: 2 },
  { name: 'Pieta', at: [14.4123372, 50.0862886], side: 's', figures: 3, look: 'pieta' },
  { name: 'Barbora, Markéta a Alžběta', at: [14.4127466, 50.0862489], side: 's', figures: 3 },
  { name: 'Ivo', at: [14.4131625, 50.086179], side: 's', figures: 2 },
  { name: 'Bruncvík', at: [14.4093666, 50.0866535], side: 's', figures: 1, look: 'bruncvik' },
];

// A statue in the game's metres: where it stands, the way it faces (a unit vector, into
// the bridge) and the half-sizes of its pedestal along and across the parapet.
export interface Statue { name: string; x: number; y: number; fx: number; fy: number; half: [number, number]; figures: number; look: Look }

const PEDESTAL_D = 1.9; // m across the parapet
const pedestalL = (s: Spec) => (s.figures >= 3 || s.look === 'calvary' ? 2.9 : s.figures === 2 ? 2.5 : 2.2);

// The statues in the map's local metres (a transverse Mercator centred on its box);
// none where the map doesn't reach the bridge.
export function placeStatues([w0, s0, e0, n0]: [number, number, number, number]): Statue[] {
  const local = `+proj=tmerc +lat_0=${(s0 + n0) / 2} +lon_0=${(w0 + e0) / 2} +k=1 +x_0=0 +y_0=0 +ellps=WGS84 +units=m`;
  const inside = SPECS.filter((s) => s.at[0] > w0 && s.at[0] < e0 && s.at[1] > s0 && s.at[1] < n0);
  const at = new Map(inside.map((s) => [s, proj4('EPSG:4326', local, s.at) as Point2]));
  return inside.map((s) => {
    const [x, y] = at.get(s)!;
    // Along the parapet: from the neighbours on the same side (the bridge bends a little).
    const row = inside.filter((o) => o.side === s.side && o.look !== 'bruncvik').map((o) => at.get(o)!).sort((a, b) => a[0] - b[0]);
    let i = row.findIndex((p) => Math.hypot(p[0] - x, p[1] - y) < 0.01);
    if (i < 0) i = row.reduce((best, p, k) => (Math.hypot(p[0] - x, p[1] - y) < Math.hypot(row[best][0] - x, row[best][1] - y) ? k : best), 0);
    const a = row[Math.max(0, i - 1)], b = row[Math.min(row.length - 1, i + 1)];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, tx = (b[0] - a[0]) / len, ty = (b[1] - a[1]) / len;
    // Into the bridge: south from the north parapet, north from the south one. Bruncvík
    // looks out over the river.
    const k = (s.side === 'n' ? 1 : -1) * (s.look === 'bruncvik' ? -1 : 1);
    return { name: s.name, x, y, fx: ty * k, fy: -tx * k, half: [pedestalL(s) / 2, PEDESTAL_D / 2], figures: s.figures, look: s.look ?? 'plain' };
  });
}

// Whether a point is inside a statue's pedestal (with `pad` metres round it).
export function inPedestal(s: Statue, x: number, y: number, pad = 0) {
  if (s.look === 'bruncvik') return false;
  const dx = x - s.x, dy = y - s.y;
  const across = dx * s.fx + dy * s.fy, along = dx * s.fy - dy * s.fx;
  return Math.abs(along) <= s.half[0] + pad && Math.abs(across) <= s.half[1] + pad;
}

const STONE = '#857a69', STONE_DARK = '#6c6253', FIGURE = '#4d473e', FIGURE_DARK = '#3d3832';
const BRONZE = '#35302a', GOLD = '#d2a646';

// Parts in a statue's own frame: x along the parapet, y up, z the way it faces.
class Parts {
  list: THREE.BufferGeometry[] = [];
  add(g: THREE.BufferGeometry, color: string, m?: THREE.Matrix4) {
    let geo = g.index ? g.toNonIndexed() : g;
    if (geo !== g) g.dispose();
    geo.deleteAttribute('uv');
    if (m) geo.applyMatrix4(m);
    const c = new THREE.Color(color), col = new Float32Array(geo.attributes.position.count * 3);
    for (let i = 0; i < col.length; i += 3) c.toArray(col, i);
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.list.push(geo);
    return geo;
  }
  box(w: number, h: number, d: number, x: number, y: number, z: number, color: string, m?: THREE.Matrix4) {
    const g = new THREE.BoxGeometry(w, h, d);
    g.translate(x, y, z);
    return this.add(g, color, m);
  }
}

const mat = (x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, s = 1) =>
  new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz, 'YXZ')), new THREE.Vector3(s, s, s));

// A ring of five gilded stars over a head (Nepomuk's, the Madonna's).
function halo(p: Parts, at: THREE.Matrix4, y: number) {
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    p.box(0.12, 0.05, 0.12, Math.cos(a) * 0.3, y, Math.sin(a) * 0.3 - 0.05, GOLD, at);
  }
}

// A standing saint, about 2.4 m tall (the statues are larger than life), in a robe that
// flares to the plinth, arms in a pose of its own. `seated`: half as tall, robe spread.
function figure(p: Parts, at: THREE.Matrix4, r: () => number, color: string, { scale = 1, seated = false } = {}) {
  const m = new THREE.Matrix4().multiplyMatrices(at, mat(0, 0, 0, (r() - 0.5) * 0.12, 0, (r() - 0.5) * 0.12, scale));
  const robe = seated ? 0.9 : 1.55, flare = 0.5 + r() * 0.12;
  const skirt = new THREE.CylinderGeometry(0.3, flare, robe, 7);
  skirt.scale(1, 1, 0.8);
  skirt.translate(0, robe / 2, -0.04);
  p.add(skirt, color, m);
  // A cloak hanging behind, which swells the outline from above.
  p.box(0.7, robe * 0.8, 0.22, 0, robe * 0.45, -0.32, FIGURE_DARK, new THREE.Matrix4().multiplyMatrices(m, mat(0, 0, 0, -0.12, (r() - 0.5) * 0.6)));
  const chest = robe + 0.27;
  p.box(0.66, 0.55, 0.38, 0, chest, 0, color, m);
  p.add(new THREE.IcosahedronGeometry(0.17, 1), color, new THREE.Matrix4().multiplyMatrices(m, mat(0, chest + 0.46, 0.03)));
  // Arms from the shoulders: raised, held out, or bent to the chest (holding something).
  for (const side of [-1, 1]) {
    const pose = r();
    const [up, out] = pose < 0.3 ? [-2.4, 0.3] : pose < 0.65 ? [-1.1, 0.5] : [-0.6, -0.25];
    const arm = new THREE.Matrix4().multiplyMatrices(m, mat(side * 0.36, chest + 0.18, 0, up, 0, side * out));
    p.box(0.15, 0.7, 0.15, 0, -0.32, 0, color, arm);
  }
  return chest + 0.46;
}

// One statue on its pedestal, standing on the deck at y = 0, in its own frame.
function statueParts(s: Statue) {
  const p = new Parts(), r = rng(Math.floor(hash(s.name) * 1e9));
  const L = s.half[0] * 2, D = s.half[1] * 2;
  if (s.look === 'bruncvik') {
    // The column rises from the pier below the bridge; the knight with his gilded sword
    // and the lion at his feet.
    p.add(new THREE.CylinderGeometry(0.42, 0.5, 10, 10).translate(0, -4.2, 0), STONE);
    p.box(1.3, 0.35, 1.3, 0, 0.95, 0, STONE_DARK);
    const top = new THREE.Matrix4().makeTranslation(0, 1.12, 0);
    p.box(0.45, 0.4, 1.0, 0.35, 0.2, 0.05, FIGURE_DARK, top);
    const head = figure(p, top, r, FIGURE, { scale: 0.85 });
    p.box(0.07, 1.1, 0.07, 0.4, head * 0.85 - 0.2, 0.25, GOLD, new THREE.Matrix4().multiplyMatrices(top, mat(0, 0, 0, 0.5, 0, -0.3)));
    return p.list;
  }
  // The pedestal: a broad base the height of the parapet, the die, its cornice. (It
  // reaches below the deck, where the pier is, in case the deck is lower there.)
  const base = 1.25, die = 3.25, top = 3.55;
  p.box(L + 0.2, base + 2, D + 0.2, 0, base / 2 - 1, 0, STONE_DARK);
  p.box(L - 0.2, die - base, D - 0.25, 0, (base + die) / 2, 0, STONE);
  p.box(L + 0.1, top - die, D + 0.05, 0, (die + top) / 2, 0, STONE_DARK);
  let floor = top;
  if (s.look === 'rock' || s.look === 'pieta') {
    // The groups stand on a rough rock, which piles up behind them.
    const rock = new THREE.IcosahedronGeometry(1, 1);
    rock.scale(L * 0.48, 0.55, D * 0.42);
    rock.translate(0, top + 0.2, -0.15);
    p.add(rock, FIGURE_DARK);
    floor = top + 0.3;
  }
  const at = (x: number, y: number, z: number, ry = 0) => mat(x, y, z, 0, ry, 0);
  const n = s.figures;
  // Places on the pedestal for one, two or three figures: side by side along it, the
  // third behind and above the others.
  const spots: [number, number, number, number][] = n === 1 ? [[0, 0, 0.05, 0]]
    : n === 2 ? [[-L * 0.22, 0, 0.1, 0.25], [L * 0.22, 0, 0, -0.25]]
      : [[-L * 0.3, 0, 0.25, 0.35], [L * 0.3, 0, 0.2, -0.35], [0, 0.35, -0.35, 0]];
  if (s.look === 'calvary') {
    // The crucifix in bronze, with its gilded inscription; Mary and John beside it.
    const cz = -0.35;
    p.box(0.22, 4.9, 0.2, 0, top + 2.45, cz, BRONZE);
    p.box(2.1, 0.2, 0.2, 0, top + 4.0, cz, BRONZE);
    p.box(0.34, 1.6, 0.22, 0, top + 3.05, cz + 0.18, BRONZE);
    p.box(1.7, 0.12, 0.14, 0, top + 3.85, cz + 0.18, BRONZE);
    for (let i = -4; i <= 4; i++) {
      const a = (i / 4) * 1.05;
      p.box(0.24, 0.08, 0.06, Math.sin(a) * 1.25, top + 2.6 + Math.cos(a) * 1.25, cz + 0.1, GOLD);
    }
    figure(p, at(-L * 0.33, floor, 0.25, 0.4), r, FIGURE, { scale: 0.9 });
    figure(p, at(L * 0.33, floor, 0.25, -0.4), r, FIGURE, { scale: 0.9 });
    return p.list;
  }
  spots.forEach(([x, y, z, ry], i) => {
    const where = at(x, floor + y, z, ry + (r() - 0.5) * 0.4);
    if (s.look === 'pieta' && i === 0) {
      // Mary seated, with Christ across her lap.
      const h = figure(p, where, r, FIGURE, { seated: true });
      p.box(1.5, 0.3, 0.38, 0.2, h * 0.5, 0.45, FIGURE, new THREE.Matrix4().multiplyMatrices(where, mat(0, 0, 0, 0, 0.3, -0.2)));
      return;
    }
    const nepomuk = s.look === 'nepomuk';
    const head = figure(p, where, r, nepomuk ? BRONZE : FIGURE, { scale: n === 3 && i < 2 ? 0.92 : 1 });
    if (nepomuk) {
      halo(p, where, head + 0.3);
      // His crucifix, held across him.
      const cross = new THREE.Matrix4().multiplyMatrices(where, mat(0.05, head - 0.8, 0.3, 0, 0, 0.6));
      p.box(0.07, 1.0, 0.06, 0, 0, 0, BRONZE, cross);
      p.box(0.4, 0.07, 0.06, 0, 0.25, 0, BRONZE, cross);
    }
    if (s.look === 'madonna' && i === 0) {
      halo(p, where, head + 0.3);
      p.add(new THREE.IcosahedronGeometry(0.2, 1), FIGURE, new THREE.Matrix4().multiplyMatrices(where, mat(0.2, head - 0.6, 0.3)));
    }
  });
  return p.list;
}

let depth: THREE.MeshDepthMaterial | null = null;

// The statues standing in a tile, as one mesh: each on the deck at its height
// (`deck(x, y)`, null where no deck is near; then it isn't drawn). The mesh is the
// tile's own, material and all, as its other fixtures are.
export function statueMesh(statues: Statue[], [x0, y0, x1, y1]: Bounds, deck: (x: number, y: number) => number | null) {
  const parts: THREE.BufferGeometry[] = [];
  for (const s of statues) {
    if (s.x < x0 || s.x >= x1 || s.y < y0 || s.y >= y1) continue;
    const h = deck(s.x, s.y);
    if (h === null) continue;
    // Its frame in the scene: the game's (x, height, -y), turned so +z faces (fx, fy).
    const m = new THREE.Matrix4().compose(new THREE.Vector3(s.x, h, -s.y),
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(s.fx, -s.fy)), new THREE.Vector3(1, 1, 1));
    for (const g of statueParts(s)) { g.applyMatrix4(m); parts.push(g); }
  }
  if (!parts.length) return null;
  const geometry = mergeGeometries(parts, false)!;
  parts.forEach((g) => g.dispose());
  depth ??= new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  const mesh = new THREE.Mesh(geometry, cutAway(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 }), 'furniture'));
  mesh.name = 'statues';
  mesh.customDepthMaterial = depth;
  mesh.castShadow = mesh.receiveShadow = true;
  return mesh;
}
