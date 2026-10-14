import * as THREE from 'three';
import proj4 from 'proj4';

// Facade modules: one window bay by one storey each, drawn as sheets of 6 × 2
// (upper floors on top, ground floors below) and packed by assets/facades/build_atlas.py
// into public/facades.webp, one sheet under another. The shader (shading.ts) picks a
// module for every bay and storey of a wall, by the wall's style.
export const CELL = [256, 512];
export const SHEETS = 11;

// Styles: 0 tenement, 1 baroque, 2 functionalist, 3 panel housing, 4 family house.
// A party wall (štítová zeď, see facadeCoords) has its style plus BLANK: plaster, no windows.
export const STYLE = { tenement: 0, baroque: 1, functionalist: 2, panel: 3, house: 4 };
export const BLANK = 5;

export const FACADE_ATLAS: { value: THREE.DataArrayTexture | null } = { value: null };
export const FACADE_ON = { value: 0 };

let loading = null;
export function loadFacadeAtlas() {
  loading ??= (async () => {
    const img = new Image();
    img.src = 'facades.webp';
    await img.decode();
    // Phones and tablets get the modules at half size: a quarter of the memory (all of
    // them sharp is some 90 MB on the GPU), and from the usual height above the
    // street a module is a few dozen pixels across anyway.
    const k = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches ? 2 : 1;
    const [w, h] = CELL.map((x) => x / k), cols = 6, rows = SHEETS * 2;
    const W = img.width / k, H = img.height / k;
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('Cannot create facade atlas canvas');
    ctx.drawImage(img, 0, 0, W, H);
    const px = ctx.getImageData(0, 0, W, H).data;
    // Cut the atlas into layers of a texture array, so modules never bleed into
    // their neighbours in the mipmaps.
    const data = new Uint8Array(w * h * 4 * cols * rows);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const layer = r * cols + c;
      for (let y = 0; y < h; y++) {
        const src = ((r * h + y) * W + c * w) * 4;
        data.set(px.subarray(src, src + w * 4), (layer * h + y) * w * 4);
      }
    }
    const tex = new THREE.DataArrayTexture(data, w, h, cols * rows);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = true;
    tex.anisotropy = 8; // walls are seen almost edge-on from above
    tex.needsUpdate = true;
    FACADE_ATLAS.value = tex;
    FACADE_ON.value = 1;
  })().catch((err) => console.warn('Facade textures did not load, drawing plain windows', err));
  return loading;
}

// A wall's style from where it stands and how tall it is. Old Town, Malá Strana and
// Hradčany are mostly baroque and older; tall blocks far out are prefab panel housing;
// low buildings are family houses; the rest is mostly 19th-century tenements with some
// 1920s–30s functionalism further out. Neighbouring walls share the random pick
// (it goes by 60 m squares), so a block keeps to one style.
export function styleFor(index: { bbox_wgs84: [number, number, number, number] }) {
  const [w, s, e, n] = index.bbox_wgs84;
  const local = `+proj=tmerc +lat_0=${(s + n) / 2} +lon_0=${(w + e) / 2} +k=1 +x_0=0 +y_0=0 +ellps=WGS84 +units=m`;
  const at = (lon: number, lat: number) => proj4('EPSG:4326', local, [lon, lat]);
  const oldTown = at(14.4213, 50.0875);
  const core = [
    [...oldTown, 750], // Staré Město
    [...at(14.4034, 50.0880), 550], // Malá Strana
    [...at(14.3975, 50.0890), 450], // Hradčany
  ];
  return (x: number, y: number, height: number) => {
    if (height < 8.5) return STYLE.house;
    const pick = cellHash(Math.floor(x / 60), Math.floor(y / 60));
    if (core.some(([cx, cy, r]) => Math.hypot(x - cx, y - cy) < r)) return pick < 0.65 ? STYLE.baroque : STYLE.tenement;
    const d = Math.hypot(x - oldTown[0], y - oldTown[1]);
    if (height > 20 && d > 3500) return STYLE.panel;
    if (d > 1800 && pick < 0.25) return STYLE.functionalist;
    return STYLE.tenement;
  };
}

// How wide a window bay is in each style, m between window axes, and how many bays a
// wall of a style and length gets (fBays in the shaders).
export const F_BAY = [2.9, 3.1, 2.6, 2.4, 2.8];
// How tall the ground floor and the floors above it are in each style, m from floor to
// floor, and how much wall a cornice or parapet takes above the top floor. A
// 19th-century tenement's floors are about 3.7 m (rooms 3.2-3.5 m high under wooden
// ceilings) over a 4-4.5 m ground floor; a panel block's are 2.8 m.
export const F_GROUND = [4.4, 4.0, 3.6, 2.9, 3.0];
export const F_STOREY = [3.7, 3.4, 3.1, 2.85, 2.9];
const F_CORNICE = [1.0, 0.6, 0.5, 0.9, 0.3];
// A wall's own floor height is its style's, scaled by 0.8 to 1.25 so that a whole
// number of floors fits under its cornice (fStorey in the shaders).
export const STOREY_FIT = [0.8, 0.45];
export const baysOf = (style: number, length: number) => (style >= BLANK ? 0 : Math.floor(length / F_BAY[style] + 0.5));

// A wall as facadeCoords measured it, for what has to line up with its windows (the
// mansard above it): a point on it and its outward normal, the direction its windows
// are counted along, where it starts and how long it is along that, and its top.
export interface WallLine { nx: number; nz: number; ax: number; az: number; tx: number; tz: number; from: number; length: number; top: number; tris: number[] }

// Looks: the sets of modules a facade is drawn with (rows of F_UP, F_DOOR, F_WALL).
// The first five are the styles' own; the rest are more for some styles.
export const LOOK = { neoRenaissance: 0, baroque: 1, functionalist: 2, panel: 3, house: 4, artNouveau: 5, plain: 6, early20th: 7, modern: 8, burgher: 9, renovatedPanel: 10 };
type Mix = [number, number][]; // looks and their weights
const TENEMENTS: Mix = [[LOOK.neoRenaissance, 0.35], [LOOK.plain, 0.35], [LOOK.artNouveau, 0.3]];
// What the map says of a wall (the upper half of its material byte, tileWorker.ts; see
// pipeline/building_age.py, which writes it): 0 nothing (the game picks the style,
// styleFor), 1-5 the style plus one, 6 and up a style with the looks of the period the
// building is from, where IPR's data knows it. Each code: its style and the looks its
// buildings take.
export const WALL_CODES: [number, Mix][] = [
  [STYLE.tenement, TENEMENTS], // not used
  [STYLE.tenement, TENEMENTS],
  [STYLE.baroque, [[LOOK.baroque, 0.5], [LOOK.burgher, 0.5]]],
  [STYLE.functionalist, [[LOOK.functionalist, 1]]],
  // Most panel blocks have been insulated and repainted since 2000.
  [STYLE.panel, [[LOOK.panel, 0.35], [LOOK.renovatedPanel, 0.65]]],
  [STYLE.house, [[LOOK.house, 1]]],
  [STYLE.tenement, [[LOOK.plain, 0.6], [LOOK.neoRenaissance, 0.4]]], // 1843-1875
  [STYLE.tenement, [[LOOK.neoRenaissance, 0.55], [LOOK.plain, 0.45]]], // 1876-1889
  [STYLE.tenement, [[LOOK.artNouveau, 0.4], [LOOK.neoRenaissance, 0.35], [LOOK.plain, 0.25]]], // 1890-1914
  [STYLE.tenement, [[LOOK.early20th, 0.8], [LOOK.artNouveau, 0.2]]], // 1915-1924
  [STYLE.functionalist, [[LOOK.modern, 1]]], // since 1990
];

// The last touches to a tile's walls, once their styles are settled: every building
// takes one look, and every wall's floors are fitted to its height (F_STOREY). Both go
// in the fraction of the facade attribute's w, with the wall's random pick:
// (pick × 512 + fit × 16 + look + 0.5) / 16384, five, five and four bits (fLook and
// fStorey in the shaders). `lines`: the walls, as facadeCoords gives them; `base(t)`:
// the colour a triangle came with (see paintWalls); `code(t)`: what the map says
// (WALL_CODES), if it says.
export function finishWalls(p: Float32Array, facade: Float32Array, lines: WallLine[], base: (t: number) => [number, number, number], code?: (t: number) => number) {
  const owner = buildings(p, facade, base), pick = new Map<number, number>();
  for (const l of lines) {
    let top = 0;
    for (const t of l.tris) for (let o = t * 12 + 1; o < t * 12 + 12; o += 4) top = Math.max(top, facade[o]);
    const t0 = l.tris[0], w = facade[t0 * 12 + 3], whole = Math.floor(w), style = whole % BLANK;
    const room = top - F_GROUND[style] - F_CORNICE[style], n = Math.round(room / F_STOREY[style]);
    const scale = n >= 1 ? room / n / F_STOREY[style] : 1;
    const fit = Math.min(31, Math.max(0, Math.round((scale - STOREY_FIT[0]) / STOREY_FIT[1] * 31)));
    // The building's look, by a random pick of its own (a party wall has the style too).
    let c = code?.(t0) ?? 0;
    if (!(c > 0 && c < WALL_CODES.length && WALL_CODES[c][0] === style)) c = style + 1;
    const b = owner[t0] >= 0 ? owner[t0] : t0;
    if (!pick.has(b)) pick.set(b, cellHash(p[b * 9 + 2] * 0.71, p[b * 9] * 1.37));
    const r = pick.get(b)!, mix = WALL_CODES[c][1];
    let look = mix[mix.length - 1][0];
    for (let i = 0, sum = 0, all = mix.reduce((a, [, k]) => a + k, 0); i < mix.length; i++) {
      sum += mix[i][1] / all;
      if (r < sum) { look = mix[i][0]; break; }
    }
    const fraction = (Math.floor((w - whole) * 32) * 512 + fit * 16 + look + 0.5) / 16384;
    for (const t of l.tris) for (let o = t * 12 + 3; o < t * 12 + 12; o += 4) facade[o] = Math.floor(facade[o]) + fraction;
  }
}

// Which building each wall triangle belongs to (a triangle of it, the same for all of
// its walls; -1 for roofs and for walls `skip` leaves out): walls that touch and came in
// the same colour are one building.
function buildings(p: Float32Array, facade: Float32Array, base: (t: number) => [number, number, number], skip?: (t: number) => boolean) {
  const n = p.length / 9, owner = new Int32Array(n).fill(-1);
  const up = (i: number): number => (owner[i] === i ? i : (owner[i] = up(owner[i])));
  const seen = new Map<string, number>();
  for (let t = 0; t < n; t++) {
    if (!(facade[t * 12 + 2] > 0)) continue; // a roof
    if (skip?.(t)) continue;
    owner[t] = t;
    const [r, g, b] = base(t);
    for (let v = t * 9; v < t * 9 + 9; v += 3) {
      const k = `${Math.round(p[v] * 100)},${Math.round(p[v + 1] * 100)},${Math.round(p[v + 2] * 100)},${r},${g},${b}`;
      const o = seen.get(k);
      if (o === undefined) seen.set(k, t);
      else owner[up(t)] = up(o);
    }
  }
  for (let t = 0; t < n; t++) if (owner[t] >= 0) owner[t] = up(t);
  return owner;
}

export function cellHash(i: number, j: number) {
  const s = Math.sin(i * 127.1 + j * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

// Where each wall pixel sits on its facade, for the windows (see shading.ts and
// facades.ts): metres along the wall, metres above the ground at its foot, the wall's
// length, and its style plus a random fraction. Triangles that share an edge and lie in
// one plane make one wall, measured from its own end in the direction between its two
// ends, so the windows run on across the triangles. `p`: the triangles' positions
// (three.js world); returns 4 floats a vertex. (Measured from the world's origin
// with each triangle's own normal, they jumped by metres at every seam.)
export function facadeCoords(p: Float32Array, groundAt: (x: number, y: number) => number, styleAt: (x: number, y: number, height: number) => number, lines?: WallLine[]) {
  const n = p.length / 9, out = new Float32Array(n * 12);
  const nrm = new Float32Array(n * 2), wall = new Int32Array(n).fill(-1);
  const up = (i: number): number => (wall[i] === i ? i : (wall[i] = up(wall[i])));
  const key = (v: number) => `${Math.round(p[v] * 1000)},${Math.round(p[v + 1] * 1000)},${Math.round(p[v + 2] * 1000)}`;
  const edges = new Map<string, number>();
  for (let t = 0; t < n; t++) {
    const i = t * 9;
    const ax = p[i + 3] - p[i], ay = p[i + 4] - p[i + 1], az = p[i + 5] - p[i + 2];
    const bx = p[i + 6] - p[i], by = p[i + 7] - p[i + 1], bz = p[i + 8] - p[i + 2];
    const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx, h = Math.hypot(nx, nz);
    if (!(h > 0) || Math.abs(ny) > 0.15 * Math.hypot(nx, ny, nz)) continue; // a roof, or a sliver
    nrm[t * 2] = nx / h; nrm[t * 2 + 1] = nz / h; wall[t] = t;
    const k = [key(i), key(i + 3), key(i + 6)];
    for (const [u, v] of [[0, 1], [1, 2], [2, 0]]) {
      const e = k[u] < k[v] ? k[u] + k[v] : k[v] + k[u], o = edges.get(e);
      if (o === undefined) { edges.set(e, t); continue; }
      const dot = nrm[t * 2] * nrm[o * 2] + nrm[t * 2 + 1] * nrm[o * 2 + 1];
      if (Math.abs(dot) > 0.999) wall[up(t)] = up(o);
    }
  }
  const walls = new Map<number, number[]>(), ends: WallEnds[] = [];
  for (let t = 0; t < n; t++) if (wall[t] >= 0) { const w = up(t); walls.has(w) ? walls.get(w)!.push(t) : walls.set(w, [t]); }
  for (const [w, tris] of walls) {
    // The wall's two ends: the farthest apart along its rough direction.
    const rx = -nrm[w * 2 + 1], rz = nrm[w * 2];
    let lo = Infinity, hi = -Infinity, a = 0, b = 0;
    for (const t of tris) for (let v = t * 9; v < t * 9 + 9; v += 3) {
      const s = p[v] * rx + p[v + 2] * rz;
      if (s < lo) { lo = s; a = v; }
      if (s > hi) { hi = s; b = v; }
    }
    const len = Math.hypot(p[b] - p[a], p[b + 2] - p[a + 2]) || 1;
    const tx = (p[b] - p[a]) / len, tz = (p[b + 2] - p[a + 2]) / len;
    let from = Infinity, to = -Infinity, top = 0, topY = -Infinity, bottom = Infinity;
    for (const t of tris) {
      let ground = Infinity;
      for (let v = t * 9; v < t * 9 + 9; v += 3) ground = Math.min(ground, groundAt(p[v], -p[v + 2]));
      for (let v = t * 9; v < t * 9 + 9; v += 3) {
        const o = (v / 3) * 4, s = (p[v] - p[a]) * tx + (p[v + 2] - p[a + 2]) * tz;
        out[o] = s;
        out[o + 1] = p[v + 1] - ground;
        from = Math.min(from, s); to = Math.max(to, s); top = Math.max(top, out[o + 1]); topY = Math.max(topY, p[v + 1]);
        bottom = Math.min(bottom, out[o + 1]);
      }
    }
    const style = styleAt((p[a] + p[b]) / 2, -(p[a + 2] + p[b + 2]) / 2, top) + 0.999 * cellHash(p[a], p[a + 2]);
    // A small box standing on a roof (a chimney, or what IPR's model makes of a dormer): no windows.
    const rooftopBox = bottom > 6 && top - bottom < 5 && to - from <= 3.5;
    for (const t of tris) for (let o = t * 12; o < t * 12 + 12; o += 4) {
      out[o] -= from;
      out[o + 2] = rooftopBox ? 0 : Math.max(to - from, 0.5);
      out[o + 3] = style;
    }
    ends.push({ tris, nx: nrm[w * 2], nz: nrm[w * 2 + 1], ax: p[a], az: p[a + 2], bx: p[b], bz: p[b + 2], len });
    lines?.push({ nx: nrm[w * 2], nz: nrm[w * 2 + 1], ax: p[a], az: p[a + 2], tx, tz, from, length: Math.max(to - from, 0.5), top: topY, tris });
  }
  for (const e of partyWalls(ends)) for (const t of e.tris) for (let o = t * 12 + 3; o < t * 12 + 12; o += 4) out[o] += BLANK;
  return out;
}

// Mansards: the steep lower slope of a mansard roof (steeper than 60°) gets a row of
// windows in the shader, and for that facade coordinates of its own: the position along
// the eave, the height up the slope from its lower edge, and its length along the eave
// (x, y, z; w keeps the roof's material). Faces shorter than 4 m or lower than 2 m (the
// gables of hips, a dormer's cheeks) get none. Faces are told apart by their normal and
// plane.
// With `lines` (the walls, as facadeCoords gives them, their styles in `out` already),
// a mansard's windows stand over the windows of the wall below it: its coordinates are
// then the wall's, scaled so that the shader's 3.2 m bays come out as the wall's bays.
export const MANSARD_UP = 0.5; // the steepest a roof face may be: its normal's up component
const MANSARD_BAY = 3.2; // m, mansardGlass in the shaders
export function mansardCoords(p: Float32Array, out: Float32Array, lines?: WallLine[]) {
  const n = p.length / 9, faces = new Map<string, number[]>();
  const nrm = new Float32Array(n * 3);
  for (let t = 0; t < n; t++) {
    const i = t * 9;
    const ax = p[i + 3] - p[i], ay = p[i + 4] - p[i + 1], az = p[i + 5] - p[i + 2];
    const bx = p[i + 6] - p[i], by = p[i + 7] - p[i + 1], bz = p[i + 8] - p[i + 2];
    let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
    const l = Math.hypot(nx, ny, nz);
    if (!(l > 0)) continue;
    nx /= l; ny /= l; nz /= l;
    if (ny <= 0.15 || ny >= MANSARD_UP) continue;
    nrm.set([nx, ny, nz], t * 3);
    const d = nx * p[i] + ny * p[i + 1] + nz * p[i + 2];
    const k = `${Math.round(nx * 40)},${Math.round(ny * 40)},${Math.round(nz * 40)},${Math.round(d / 0.5)}`;
    faces.has(k) ? faces.get(k)!.push(t) : faces.set(k, [t]);
  }
  for (const tris of faces.values()) {
    const t0 = tris[0] * 3, nx = nrm[t0], ny = nrm[t0 + 1], nz = nrm[t0 + 2];
    // Along the eave (level), and up the slope.
    const h = Math.hypot(nx, nz), ex = -nz / h, ez = nx / h;
    const ux = -ny * ez, uy = nx * ez - nz * ex, uz = ny * ex; // e × n, pointing up
    let lo = Infinity, hi = -Infinity, bottom = Infinity, top = -Infinity;
    for (const t of tris) for (let v = t * 9; v < t * 9 + 9; v += 3) {
      const s = p[v] * ex + p[v + 2] * ez, u = p[v] * ux + p[v + 1] * uy + p[v + 2] * uz;
      lo = Math.min(lo, s); hi = Math.max(hi, s); bottom = Math.min(bottom, u); top = Math.max(top, u);
    }
    if (hi - lo < 4 || top - bottom < 2) continue;
    // The wall below: facing the same way, in line with the mansard's foot, ending near
    // it, and under most of it.
    let wall: WallLine | null = null, bays = 0, under = 0.5 * (hi - lo);
    if (lines) {
      let fx = 0, fy = Infinity, fz = 0, k = 0;
      for (const t of tris) for (let v = t * 9; v < t * 9 + 9; v += 3) if (p[v] * ux + p[v + 1] * uy + p[v + 2] * uz < bottom + 0.3) { fx += p[v]; fz += p[v + 2]; fy = Math.min(fy, p[v + 1]); k++; }
      fx /= k; fz /= k;
      for (const l of lines) {
        if ((l.nx * nx + l.nz * nz) / h < 0.97 || Math.abs(l.nx * (fx - l.ax) + l.nz * (fz - l.az)) > 1.5 || l.top < fy - 3 || l.top > fy + 1.5) continue;
        const s0 = l.ax * ex + l.az * ez + (l.tx * ex + l.tz * ez) * l.from, s1 = s0 + (l.tx * ex + l.tz * ez) * l.length;
        const shared = Math.min(hi, Math.max(s0, s1)) - Math.max(lo, Math.min(s0, s1));
        const style = Math.floor(out[l.tris[0] * 12 + 3]);
        if (shared > under && baysOf(style, l.length) >= 1) { wall = l; bays = baysOf(style, l.length); under = shared; }
      }
    }
    for (const t of tris) for (let v = 0; v < 3; v++) {
      const q = t * 9 + v * 3, o = (t * 3 + v) * 4;
      out[o + 1] = p[q] * ux + p[q + 1] * uy + p[q + 2] * uz - bottom;
      if (wall) {
        out[o] = ((p[q] - wall.ax) * wall.tx + (p[q + 2] - wall.az) * wall.tz - wall.from) / wall.length * bays * MANSARD_BAY;
        out[o + 2] = bays * MANSARD_BAY;
      } else {
        out[o] = p[q] * ex + p[q + 2] * ez - lo;
        out[o + 2] = hi - lo;
      }
    }
  }
}

interface WallEnds { tris: number[]; nx: number; nz: number; ax: number; az: number; bx: number; bz: number; len: number }

// Party walls: walls standing back to back with another building's, in one plane and
// facing away from each other, over at least half their length. What shows of them
// above a lower neighbour is a štítová zeď, plastered and without windows. (A
// neighbour in the next tile isn't seen, so a few stay with windows.)
function partyWalls(walls: WallEnds[]) {
  const A = 0.03, D = 0.4, turns = Math.round(Math.PI / A);
  // Bucketed by the line they lie on: direction (either way round) and distance from the origin.
  const line = (e: WallEnds) => {
    let ang = Math.atan2(e.nz, e.nx), d = e.nx * e.ax + e.nz * e.az;
    if (ang < 0) { ang += Math.PI; d = -d; }
    return [Math.round(ang / A) % turns, Math.round(d / D)];
  };
  const buckets = new Map<string, WallEnds[]>();
  for (const e of walls) {
    const [i, j] = line(e), k = `${i},${j}`;
    buckets.has(k) ? buckets.get(k)!.push(e) : buckets.set(k, [e]);
  }
  const party = new Set<WallEnds>();
  for (const e of walls) {
    const [i, j] = line(e), tx = (e.bx - e.ax) / e.len, tz = (e.bz - e.az) / e.len;
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
      for (const o of buckets.get(`${(i + di + turns) % turns},${j + dj}`) ?? []) {
        if (o === e || e.nx * o.nx + e.nz * o.nz > -0.995) continue;
        if (Math.abs(e.nx * (o.ax - e.ax) + e.nz * (o.az - e.az)) > 0.35) continue;
        const s1 = (o.ax - e.ax) * tx + (o.az - e.az) * tz, s2 = (o.bx - e.ax) * tx + (o.bz - e.az) * tz;
        const overlap = Math.min(e.len, Math.max(s1, s2)) - Math.max(0, Math.min(s1, s2));
        if (overlap > 0.5 * e.len) party.add(e);
      }
    }
  }
  return party;
}

// Plaster colours, sRGB. Prague's are mostly ochres and yellows, with the earthy,
// stone-like greys and sands of neo-Renaissance tenements, creams and a few pale
// greens, pinks and blues from later repainting (Metodický materiál pro obnovu
// fasád, hl. m. Praha / NPÚ: "typický pražský kolorit okrů a žlutí"). Repeats weight
// the pick; each style has its own mix.
const CREAM = ['#e8dcbc', '#efe4c8', '#e2d5b5'];
const OCHRE = ['#e4c98f', '#dcbd7e', '#e9d29e', '#d6b06a', '#cfaa6c'];
const SAND = ['#cdbb98', '#c4b192', '#bfae90', '#b8a582', '#b39676'];
const GREY = ['#cac4b7', '#bdb8ad', '#d3d0c8'];
const WHITE = ['#ebe8e0', '#e4e1d8'];
const PASTEL = ['#cdd5b3', '#c3cdab', '#e2b995', '#dcae92', '#dfbfb1', '#c4cdd0'];
export const TENEMENT_PLASTER = [...CREAM, ...OCHRE, ...OCHRE, ...SAND, ...SAND, ...GREY, ...WHITE, ...PASTEL];
const PLASTER = [
  TENEMENT_PLASTER,
  [...CREAM, ...OCHRE, ...OCHRE, ...OCHRE, ...SAND, ...WHITE, ...PASTEL.slice(2, 5)], // baroque
  [...CREAM, ...GREY, ...GREY, ...WHITE, ...WHITE, ...OCHRE.slice(0, 3), ...SAND.slice(0, 2)], // functionalist
  [...GREY, ...GREY, ...CREAM, ...OCHRE.slice(0, 3), ...PASTEL, ...PASTEL], // panel housing
  [...CREAM, ...OCHRE, ...WHITE, ...GREY, ...PASTEL, ...SAND.slice(0, 3)], // family house
].map((list) => list.map((hex) => new THREE.Color(hex)));

// Paint every building's walls one of the plaster colours of its style, in place.
// `col`: linear RGB a vertex; `base(t)`: the colour a triangle came with, which tells
// one building from its neighbour (walls that touch and came in the same colour are
// one building). The pick goes by where the building stands, so it's the same every
// time the tile loads. Whatever shading `col` has on top of the colour is kept.
export function paintWalls(p: Float32Array, col: Float32Array, facade: Float32Array, base: (t: number) => [number, number, number], keep?: (t: number) => boolean) {
  const n = p.length / 9, owner = buildings(p, facade, base, keep), up = (t: number) => owner[t];
  const paint = new Map<number, THREE.Color>(), at = new Map<number, number[]>();
  for (let t = 0; t < n; t++) {
    if (owner[t] < 0) continue;
    const w = up(t), c = at.get(w);
    if (!c || p[t * 9] < c[0]) at.set(w, [p[t * 9], p[t * 9 + 2], t]);
  }
  for (const [w, [x, z, t]] of at) {
    const list = PLASTER[Math.floor(facade[t * 12 + 3]) % BLANK];
    const h = cellHash(Math.round(x * 10) / 10, Math.round(z * 10) / 10);
    paint.set(w, list[Math.floor(h * list.length)].clone().multiplyScalar(0.96 + 0.08 * cellHash(z, x)));
  }
  const was = new THREE.Color();
  for (let t = 0; t < n; t++) {
    if (owner[t] < 0) continue;
    const [r, g, b] = base(t), c = paint.get(up(t))!;
    was.setRGB(r / 255, g / 255, b / 255, THREE.SRGBColorSpace);
    for (let v = t * 9; v < t * 9 + 9; v += 3) {
      col[v] *= c.r / Math.max(was.r, 1e-3); col[v + 1] *= c.g / Math.max(was.g, 1e-3); col[v + 2] *= c.b / Math.max(was.b, 1e-3);
    }
  }
}

// For every bay and storey, which module: upper floors, then the ground floor's doors
// and the rest of the ground floor, as layers of the atlas (sheet × 12 + row × 6 +
// column), a row of each table for every look (LOOK). A few bays of each ground floor
// get a door. The sheets: 1 and 5 neo-Renaissance tenements (5 after a house in
// Mělnická; 1 gives its shops), 2 baroque, 3 functionalist and panel housing, 4 family
// houses, 6 Art Nouveau, 7 the plain tenements of Žižkov and Karlín, 8 houses of
// 1912-1925 (late Art Nouveau, rondocubism), 9 infill since the 1990s, 10 plainer
// burgher houses of the Old Town and Malá Strana, 11 insulated panel blocks.
// Window bays are as wide as in Prague's houses (F_BAY, about 3 m between window
// axes in a tenement): the module takes F_MOD of that in the middle, and its plaster
// edge (with the cornices and bands) is drawn on across the piers between. Panel
// housing is stretched instead, its modules being whole panels. (The baroque sheet's
// shutters reach the module's edge, so they're left out; so are rows that would look
// odd repeated along a whole floor: a staircase's windows, niches.)
export const F_UP = [
  48, 49, 50, 51, 52, 53, 12, 13, 15, 12, 13, 15, 24, 25, 24, 25, 26, 24, 27, 28, 27, 27, 28, 27, 36, 37, 38, 39, 40, 36,
  60, 61, 62, 63, 64, 65, 72, 73, 74, 75, 76, 72, 84, 85, 86, 87, 88, 89, 96, 97, 98, 99, 100, 101,
  108, 109, 110, 112, 108, 109, 120, 121, 122, 123, 121, 120];
export const F_DOOR = [56, 57, 8, 18, 19, 20, 31, 31, 34, 32, 32, 34, 42, 44, 45, 67, 69, 67, 79, 82, 79, 90, 93, 90, 103, 104, 105, 114, 115, 117, 126, 130, 126];
export const F_WALL = [
  54, 55, 58, 6, 21, 22, 23, 20, 30, 30, 30, 35, 33, 35, 33, 35, 43, 46, 47, 43, 66, 68, 70, 71, 78, 80, 81, 83,
  91, 92, 94, 95, 102, 106, 107, 102, 116, 118, 119, 116, 127, 128, 129, 131];
export const F_MOD = [1.9, 1.9, 2, 2.4, 1.9, 1.9, 1.9, 1.9, 2, 1.9, 2.4];
const LOOKS = F_MOD.length;
const glslArray = (type: string, v: number[]) => `${type}[${v.length}](${v.map((x) => (type === 'float' ? x.toFixed(2) : x)).join(', ')})`;
export const FACADE_GLSL = /* glsl */ `
uniform mediump sampler2DArray uFacades;
uniform float uFacadeOn;
const int F_UP[${LOOKS * 6}] = ${glslArray('int', F_UP)};
const int F_DOOR[${LOOKS * 3}] = ${glslArray('int', F_DOOR)};
const int F_WALL[${LOOKS * 4}] = ${glslArray('int', F_WALL)};
const float F_BAY[5] = ${glslArray('float', F_BAY)};
const float F_MOD[${LOOKS}] = ${glslArray('float', F_MOD)};
const float F_GROUND[5] = ${glslArray('float', F_GROUND)};
const float F_STOREY[5] = ${glslArray('float', F_STOREY)};
float fHash(float a, float b) { return fract(sin(a * 127.1 + b * 311.7) * 43758.5453); }
// How many window bays across a wall: none on a party wall or one too short for a window.
float fBays(vec4 f) {
  int style = int(floor(f.w));
  return style >= ${BLANK} ? 0. : floor(f.z / F_BAY[style] + .5);
}
// The wall's ground floor and its other floors, m, and its building's look (finishWalls).
vec2 fStorey(vec4 f) {
  int style = min(int(floor(f.w)), 4);
  float fit = mod(floor(fract(f.w) * 1024.), 32.);
  return vec2(F_GROUND[style], F_STOREY[style] * (${STOREY_FIT[0].toFixed(2)} + fit * ${(STOREY_FIT[1] / 31).toFixed(6)}));
}
int fLook(vec4 f) { return int(mod(floor(fract(f.w) * 16384.), 16.)); }
vec3 facadeModules(vec3 wall, vec4 f, vec4 fdx, vec4 fdy) {
  float bays = fBays(f);
  // Bare plaster, as bright as the modules' plaster (drawn about .45 grey: × .8).
  if (bays < .5) return wall * (.77 + .06 * vnoise(f.xy * vec2(.9, .6)));
  int style = int(floor(f.w));
  float seed = fract(f.w) * 97.;
  int look = min(fLook(f), ${LOOKS - 1});
  vec2 st = fStorey(f);
  vec2 q = vec2(f.x / f.z * bays, f.y < st.x ? clamp(f.y / st.x, 0., .999) : (f.y - st.x) / st.y);
  vec2 cell = floor(q), uv = fract(q);
  float bay = f.z / bays, mw = min(F_MOD[look], bay);
  float u = clamp((uv.x - .5) * bay / mw + .5, .016, .984);
  int layer;
  if (f.y < st.x) {
    float r = fHash(seed, cell.x);
    layer = r < .18 ? F_DOOR[look * 3 + int(r / .18 * 3.)] : F_WALL[look * 4 + int(fHash(cell.x, seed) * 4.)];
  } else layer = F_UP[look * 6 + int(fHash(seed, cell.y + 7.) * 6.)];
  vec2 k = vec2(1. / mw, 1. / st.y);
  vec3 t = textureGrad(uFacades, vec3(u, 1. - uv.y, float(layer)), fdx.xy * k, fdy.xy * k).rgb;
  // Plaster is drawn neutral grey: give it the wall's colour. Frames, doors and
  // metal keep their own.
  float hi = max(t.r, max(t.g, t.b)), sat = (hi - min(t.r, min(t.g, t.b))) / max(hi, 1e-3);
  return mix(t, t * wall / .55, 1. - smoothstep(.08, .2, sat));
}
`;
