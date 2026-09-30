import * as THREE from 'three';
import proj4 from 'proj4';

// Facade modules: one window bay by one storey each, drawn as sheets of 6 × 2
// (upper floors on top, ground floors below) and packed by assets/facades/build_atlas.py
// into public/facades.webp, one sheet under another. The shader (shading.ts) picks a
// module for every bay and storey of a wall, by the wall's style.
export const CELL = [256, 512];
export const SHEETS = 5;

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
    const [w, h] = CELL, cols = 6, rows = SHEETS * 2;
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('Cannot create facade atlas canvas');
    ctx.drawImage(img, 0, 0);
    const px = ctx.getImageData(0, 0, img.width, img.height).data;
    // Cut the atlas into layers of a texture array, so modules never bleed into
    // their neighbours in the mipmaps.
    const data = new Uint8Array(w * h * 4 * cols * rows);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const layer = r * cols + c;
      for (let y = 0; y < h; y++) {
        const src = ((r * h + y) * img.width + c * w) * 4;
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
export function facadeCoords(p: Float32Array, groundAt: (x: number, y: number) => number, styleAt: (x: number, y: number, height: number) => number) {
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
    let from = Infinity, to = -Infinity, top = 0;
    for (const t of tris) {
      let ground = Infinity;
      for (let v = t * 9; v < t * 9 + 9; v += 3) ground = Math.min(ground, groundAt(p[v], -p[v + 2]));
      for (let v = t * 9; v < t * 9 + 9; v += 3) {
        const o = (v / 3) * 4, s = (p[v] - p[a]) * tx + (p[v + 2] - p[a + 2]) * tz;
        out[o] = s;
        out[o + 1] = p[v + 1] - ground;
        from = Math.min(from, s); to = Math.max(to, s); top = Math.max(top, out[o + 1]);
      }
    }
    const style = styleAt((p[a] + p[b]) / 2, -(p[a + 2] + p[b + 2]) / 2, top) + 0.999 * cellHash(p[a], p[a + 2]);
    for (const t of tris) for (let o = t * 12; o < t * 12 + 12; o += 4) {
      out[o] -= from;
      out[o + 2] = Math.max(to - from, 0.5);
      out[o + 3] = style;
    }
    ends.push({ tris, nx: nrm[w * 2], nz: nrm[w * 2 + 1], ax: p[a], az: p[a + 2], bx: p[b], bz: p[b + 2], len });
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
export const MANSARD_UP = 0.5; // the steepest a roof face may be: its normal's up component
export function mansardCoords(p: Float32Array, out: Float32Array) {
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
    for (const t of tris) for (let v = 0; v < 3; v++) {
      const q = t * 9 + v * 3, o = (t * 3 + v) * 4;
      out[o] = p[q] * ex + p[q + 2] * ez - lo;
      out[o + 1] = p[q] * ux + p[q + 1] * uy + p[q + 2] * uz - bottom;
      out[o + 2] = hi - lo;
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
export function paintWalls(p: Float32Array, col: Float32Array, facade: Float32Array, base: (t: number) => [number, number, number]) {
  const n = p.length / 9, owner = new Int32Array(n).fill(-1);
  const up = (i: number): number => (owner[i] === i ? i : (owner[i] = up(owner[i])));
  const seen = new Map<string, number>();
  for (let t = 0; t < n; t++) {
    if (!(facade[t * 12 + 2] > 0)) continue; // a roof
    owner[t] = t;
    const [r, g, b] = base(t);
    for (let v = t * 9; v < t * 9 + 9; v += 3) {
      const k = `${Math.round(p[v] * 100)},${Math.round(p[v + 1] * 100)},${Math.round(p[v + 2] * 100)},${r},${g},${b}`;
      const o = seen.get(k);
      if (o === undefined) seen.set(k, t);
      else owner[up(t)] = up(o);
    }
  }
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

// For every bay and storey, which module of the wall's style: upper floors, then the
// ground floor's doors and the rest of the ground floor, as layers of the atlas
// (sheet × 12 + row × 6 + column). A few bays of each ground floor get a door.
// Tenements take their windows, portals and barred ground-floor windows from the fifth
// sheet (neo-Renaissance, after a house in Mělnická), with the first sheet's shops.
// Window bays are as wide as in Prague's houses (F_BAY, about 3 m between window
// axes in a tenement): the module takes F_MOD of that in the middle, and its plaster
// edge (with the cornices and bands) is drawn on across the piers between. Panel
// housing is stretched instead, its modules being whole panels. (The baroque sheet's
// shutters reach the module's edge, so they're left out.)
export const FACADE_GLSL = /* glsl */ `
uniform mediump sampler2DArray uFacades;
uniform float uFacadeOn;
const int F_UP[30] = int[30](48, 49, 50, 51, 52, 53,   12, 13, 15, 12, 13, 15,   24, 25, 24, 25, 26, 24,   27, 28, 27, 27, 28, 27,   36, 37, 38, 39, 40, 36);
const int F_DOOR[15] = int[15](56, 57, 8,   18, 19, 20,   31, 31, 34,   32, 32, 34,   42, 44, 45);
const int F_WALL[20] = int[20](54, 55, 58, 6,   21, 22, 23, 20,   30, 30, 30, 35,   33, 35, 33, 35,   43, 46, 47, 43);
const float F_BAY[5] = float[5](2.9, 3.1, 2.6, 2.4, 2.8);
const float F_MOD[5] = float[5](1.9, 1.9, 2., 2.4, 1.9);
float fHash(float a, float b) { return fract(sin(a * 127.1 + b * 311.7) * 43758.5453); }
// How many window bays across a wall: none on a party wall or one too short for a window.
float fBays(vec4 f) {
  int style = int(floor(f.w));
  return style >= ${BLANK} ? 0. : floor(f.z / F_BAY[style] + .5);
}
vec3 facadeModules(vec3 wall, vec4 f, vec4 fdx, vec4 fdy) {
  float bays = fBays(f);
  // Bare plaster, as bright as the modules' plaster (drawn about .45 grey: × .8).
  if (bays < .5) return wall * (.77 + .06 * vnoise(f.xy * vec2(.9, .6)));
  int style = int(floor(f.w));
  float seed = fract(f.w) * 97.;
  vec2 q = vec2(f.x / f.z * bays, f.y < 4. ? clamp(f.y / 4., 0., .999) : (f.y - 4.) / 3.4);
  vec2 cell = floor(q), uv = fract(q);
  float bay = f.z / bays, mw = min(F_MOD[style], bay);
  float u = clamp((uv.x - .5) * bay / mw + .5, .016, .984);
  int layer;
  if (f.y < 4.) {
    float r = fHash(seed, cell.x);
    layer = r < .18 ? F_DOOR[style * 3 + int(r / .18 * 3.)] : F_WALL[style * 4 + int(fHash(cell.x, seed) * 4.)];
  } else layer = F_UP[style * 6 + int(fHash(seed, cell.y + 7.) * 6.)];
  vec2 k = vec2(1. / mw, 1. / 3.6);
  vec3 t = textureGrad(uFacades, vec3(u, 1. - uv.y, float(layer)), fdx.xy * k, fdy.xy * k).rgb;
  // Plaster is drawn neutral grey: give it the wall's colour. Frames, doors and
  // metal keep their own.
  float hi = max(t.r, max(t.g, t.b)), sat = (hi - min(t.r, min(t.g, t.b))) / max(hi, 1e-3);
  return mix(t, t * wall / .55, 1. - smoothstep(.08, .2, sat));
}
`;
