import * as THREE from 'three';
import { dataUrl } from './data.ts';
import { lampLit } from './lamps.ts';
import { sendInstances } from './gpu.ts';

// Tables under parasols outside the cafés, restaurants and pubs that have them, through
// the warm months. Which places have tables outside is OpenStreetMap's word
// (data/<area>_now/terraces.json, from pipeline/build_terraces.py); it doesn't say where
// they stand or how many, so each place gets a short row of them on the open ground
// nearest its door, along the house. A map without the file has none.
//
// From above a terrace is its parasols and their shadows, so every table is one instance
// of one small model (a square parasol on a pole over a round table and four chairs), all
// of them one draw and one more in the shadow pass, rewritten only when a place comes
// into view or leaves it. Nothing collides with them yet: people and cars pass through.

export const TERRACES = {
  from: 100, to: 300, // the days of the year they stand out: 10 April to 27 October
  reach: 12, // m from the place's point on the map to look for open ground
  apart: 2.9, // m between two tables of a row
  most: 320, // tables drawn at once
  beyond: 30, // m past the edge of the view a place's tables are still drawn (their shadows reach in)
};
// A place's parasols are all one colour: canvas mostly, and what breweries hand out.
const COLOURS = ['#e9e2d0', '#e9e2d0', '#ded6c2', '#f1efe8', '#2f5a45', '#2f5a45', '#7a2630', '#22355a', '#c9762b', '#d8b545', '#3d3f44', '#b8322c'];

interface Place { x: number; y: number; kind: number; tables: Float32Array | null } // (x, y, z, heading of each)
export interface TerraceView {
  x: number; y: number; radius: number; day: number;
  loaded: (x: number, y: number) => boolean;
  open: (x: number, y: number) => boolean;
  ground: (x: number, y: number) => number;
}

const fract = (v: number) => v - Math.floor(v);
const chance = (p: Place, salt: number) => fract(Math.sin(p.x * 12.9898 + p.y * 78.233 + salt * 37.719) * 43758.5453);

// The model, standing at the origin: 1 is canvas (it takes the place's colour), the rest
// is dark wood and metal.
function shape() {
  const pos: number[] = [], col: number[] = [];
  const tri = (a: number[], b: number[], c: number[], shade: number) => {
    pos.push(...a, ...b, ...c);
    for (let i = 0; i < 3; i++) col.push(shade, shade, shade);
  };
  const quad = (a: number[], b: number[], c: number[], d: number[], shade: number) => { tri(a, b, c, shade); tri(a, c, d, shade); };
  const box = (x: number, y: number, z: number, w: number, h: number, d: number, shade: number) => {
    const p = (sx: number, sy: number, sz: number) => [x + sx * w / 2, y + sy * h / 2, z + sz * d / 2];
    quad(p(-1, 1, -1), p(-1, 1, 1), p(1, 1, 1), p(1, 1, -1), shade);
    for (const [ax, az, bx, bz] of [[-1, -1, 1, -1], [1, -1, 1, 1], [1, 1, -1, 1], [-1, 1, -1, -1]]) quad(p(ax, -1, az), p(bx, -1, bz), p(bx, 1, bz), p(ax, 1, az), shade * 0.8);
  };
  // The parasol: a square of canvas 2.7 m across, its four panels shaded a little apart,
  // with a short valance hanging round the edge.
  const R = 1.35, TOP = 2.75, RIM = 2.35, corners = [[R, R], [-R, R], [-R, -R], [R, -R]];
  corners.forEach(([x, z], i) => {
    const [nx, nz] = corners[(i + 1) % 4];
    tri([0, TOP, 0], [x, RIM, z], [nx, RIM, nz], i % 2 ? 0.86 : 1);
    quad([x, RIM, z], [x, RIM - 0.16, z], [nx, RIM - 0.16, nz], [nx, RIM, nz], 0.78);
  });
  box(0, 1.4, 0, 0.05, 2.7, 0.05, 0.3); // the pole
  box(0, 0.03, 0, 0.5, 0.06, 0.5, 0.25); // and its foot
  // The table, round, on one leg (it stands by the pole).
  const T = 0.42, TX = 0.5, TY = 0.74, N = 8;
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2, b = ((i + 1) / N) * Math.PI * 2;
    tri([TX, TY, 0], [TX + Math.cos(b) * T, TY, Math.sin(b) * T], [TX + Math.cos(a) * T, TY, Math.sin(a) * T], 0.45);
  }
  box(TX, TY / 2, 0, 0.06, TY, 0.06, 0.25);
  // Chairs round it: a seat and a back.
  for (const [cx, cz, bx, bz] of [[TX + 0.72, 0, 1, 0], [TX, 0.72, 0, 1], [TX, -0.72, 0, -1], [TX - 0.72, 0.5, -0.8, 0.6]]) {
    box(cx, 0.44, cz, 0.4, 0.05, 0.4, 0.38);
    box(cx + bx * 0.2, 0.68, cz + bz * 0.2, bx ? 0.05 : 0.4, 0.44, bz && !bx ? 0.05 : 0.4, 0.34);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  return g;
}

const _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(1, 1, 1), _m = new THREE.Matrix4();
const UP = new THREE.Vector3(0, 1, 0);
const PALETTE = COLOURS.map((c) => new THREE.Color(c));

export class Terraces {
  mesh: THREE.InstancedMesh<THREE.BufferGeometry, THREE.MeshLambertMaterial>;
  places: Place[] = [];
  private shown = '';
  private wait = 0;

  constructor(scene: THREE.Scene, area: string) {
    // (Lit by the street lamps like the lamp posts, with the same shader as theirs.)
    const material = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
    material.onBeforeCompile = (sh) => lampLit(sh);
    material.customProgramCacheKey = () => 'lamp-pole';
    this.mesh = new THREE.InstancedMesh(shape(), material, TERRACES.most);
    this.mesh.setColorAt(0, PALETTE[0]);
    this.mesh.castShadow = this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.visible = false;
    scene.add(this.mesh);
    void fetch(dataUrl(area, 'terraces.json')).then((r) => (r.ok ? r.json() as Promise<{ terraces?: unknown }> : null)).then((d) => {
      if (!d || !Array.isArray(d.terraces)) return;
      for (const row of d.terraces) {
        if (!Array.isArray(row)) continue;
        const [x, y, kind] = row as number[];
        if (Number.isFinite(x) && Number.isFinite(y)) this.places.push({ x, y, kind: kind | 0, tables: null });
      }
    }).catch(() => {});
  }

  // Where a place's tables stand: on the open ground nearest its point on the map, in a
  // row across the way out from the house.
  private lay(p: Place, view: TerraceView) {
    const room = (x: number, y: number, r: number) => view.open(x, y) && view.open(x + r, y) && view.open(x - r, y) && view.open(x, y + r) && view.open(x, y - r);
    let at: [number, number] | null = null;
    for (let r = 1; r <= TERRACES.reach && !at; r += 1) {
      const n = Math.max(8, Math.round(r * 5));
      for (let i = 0; i < n && !at; i++) {
        const a = (i / n) * Math.PI * 2 + chance(p, 1) * 6.28, x = p.x + Math.cos(a) * r, y = p.y + Math.sin(a) * r;
        if (room(x, y, 1.5)) at = [x, y];
      }
    }
    if (!at) return new Float32Array(0);
    // Away from the nearest thing in the way (the house's wall, most often).
    let ox = at[0] - p.x, oy = at[1] - p.y;
    search: for (let r = 2; r <= 5; r += 0.5) {
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * Math.PI * 2;
        if (!view.open(at[0] + Math.cos(a) * r, at[1] + Math.sin(a) * r)) { ox = -Math.cos(a); oy = -Math.sin(a); break search; }
      }
    }
    const l = Math.hypot(ox, oy) || 1, ax = -oy / l, ay = ox / l, facing = Math.atan2(oy, ox);
    // A café two or three tables, a restaurant a few more, a pub the most.
    const want = 2 + Math.floor(chance(p, 2) * (2 + p.kind * 1.5)), out: number[] = [];
    for (let k = 0; out.length < want * 4 && k < want + 4; k++) {
      // Out from the middle of the row, to one side and the other in turn.
      const along = (k % 2 ? 1 : -1) * Math.ceil(k / 2) * TERRACES.apart, x = at[0] + ax * along, y = at[1] + ay * along;
      if (room(x, y, 1.4)) out.push(x, y, view.ground(x, y), facing + (chance(p, 3 + k) - 0.5) * 0.25);
    }
    return new Float32Array(out);
  }

  update(dt: number, view: TerraceView) {
    if (view.day < TERRACES.from || view.day > TERRACES.to || !this.places.length) {
      this.mesh.visible = false;
      this.shown = '';
      return;
    }
    if ((this.wait -= dt) > 0 && this.shown) return;
    this.wait = 0.5;
    const reach = view.radius + TERRACES.beyond, near: Place[] = [];
    for (const p of this.places) {
      if (Math.abs(p.x - view.x) > reach || Math.abs(p.y - view.y) > reach) continue;
      // (Laid once the ground round it has loaded, and kept.)
      if (!p.tables && view.loaded(p.x, p.y)) p.tables = this.lay(p, view);
      if (p.tables?.length) near.push(p);
    }
    const key = near.map((p) => `${p.x},${p.y}`).join(' ') || '-';
    if (key === this.shown) return;
    this.shown = key;
    let n = 0;
    for (const p of near) {
      const colour = PALETTE[Math.floor(chance(p, 9) * PALETTE.length)], t = p.tables!;
      for (let i = 0; i < t.length && n < TERRACES.most; i += 4) {
        this.mesh.setMatrixAt(n, _m.compose(_p.set(t[i], t[i + 2], -t[i + 1]), _q.setFromAxisAngle(UP, t[i + 3]), _s));
        this.mesh.setColorAt(n++, colour);
      }
    }
    this.mesh.count = n;
    this.mesh.visible = n > 0;
    sendInstances(this.mesh);
  }
}
