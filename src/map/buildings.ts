import * as THREE from 'three';
import * as SS from 'straight-skeleton';
import { signedArea, hash } from './geo.ts';
import type { GeoData, Point2 } from './geo.ts';
import { TENEMENT_PLASTER } from '../facades.ts';
import { ROOF_TILES } from './roofPalette.ts';

// Some package builds expose the builder on a default export at runtime.
const skeletonModule = SS as typeof SS & { default?: { SkeletonBuilder?: typeof SS.SkeletonBuilder } };
const SkeletonBuilder = skeletonModule.SkeletonBuilder ?? skeletonModule.default?.SkeletonBuilder;

export interface BuildingTile extends GeoData {
  // cover: what the roof is covered with, where OSM or pipeline/roofs.py says.
  buildings: { id: string; name?: string | null; kind: string; h: number; minh: number; church?: boolean; roof?: string | null; cover?: 'tiles' | 'slate' | 'copper'; rings: Point2[][] }[];
}
interface WallTile { walls: { kind: string; pts: Point2[] }[] }
interface WallBuffers { position: Float32Array; normal: Float32Array }

const ROOF_SLATE = ['#6c6d70', '#5e6064', '#77746f'];
const ROOF_COPPER = '#6f9483';
const WALLS = TENEMENT_PLASTER;

const PITCH = 0.8; // rise per metre of inset (~39°)
const MAX_ROOF = 7.5;

export async function initRoofs() {
  if (!SkeletonBuilder) throw new Error('Straight skeleton builder is unavailable');
  await SkeletonBuilder.init();
}

// Builds one merged mesh for all buildings: walls + straight-skeleton roofs.
export function buildBuildings(data: BuildingTile) {
  if (!SkeletonBuilder) throw new Error('Straight skeleton builder is unavailable');
  const pos: number[] = [], nor: number[] = [], col: number[] = [], uv: number[] = [];
  const [W, H] = data.size, [ox, oy] = data.origin;
  const stats = { skeleton: 0, gabled: 0, flat: 0, failed: 0 };
  const cWall = new THREE.Color(), cRoof = new THREE.Color(), tmp = new THREE.Color();

  // local (x, y, z-up) → three (X, Y-up, Z)
  const push = (p: number[], n: number[], c: THREE.Color) => {
    pos.push(p[0], p[2], -p[1]);
    nor.push(n[0], n[2], -n[1]);
    col.push(c.r, c.g, c.b);
    uv.push((p[0] + ox) / W, (p[1] + oy) / H); // top-down projection, same as the ground
  };
  const tri = (a: number[], b: number[], c: number[], color: THREE.Color | THREE.Color[], want: number[]) => {
    // Flat normal; flip winding if it disagrees with the expected direction.
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let n = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
    const len = Math.hypot(...n) || 1;
    n = n.map((v) => v / len);
    if (n[0] * want[0] + n[1] * want[1] + n[2] * want[2] < 0) {
      [b, c] = [c, b];
      n = n.map((v) => -v);
    }
    const cols = Array.isArray(color) ? color : [color, color, color];
    push(a, n, cols[0]);
    push(b, n, cols[1]);
    push(c, n, cols[2]);
  };

  for (const b of data.buildings) {
    const hv = hash(b.id + b.rings[0].length);
    const isWall = /zeď/i.test(b.name || '');
    // Kiosks and canopies are flat; garages, sheds and service buildings half and half,
    // so a row of them isn't all flat.
    const small = ['kiosk', 'roof'].includes(b.kind)
      || (['garage', 'shed', 'service'].includes(b.kind) && hash(b.id + 'roof') < 0.5);
    const eaves = isWall ? 5 : Math.max(b.h, b.minh + 3);
    const base = isWall ? 0 : b.minh;

    cWall.set(WALLS[Math.floor(hv * WALLS.length)]);
    // Pitched roofs in Prague are nearly all red tiles; unless OSM says otherwise, only
    // churches get slate or copper.
    const cover = b.cover ?? (b.church ? (b.roof === 'onion' || b.roof === 'dome' ? 'copper' : 'slate') : 'tiles');
    if (cover === 'copper') cRoof.set(ROOF_COPPER);
    else if (cover === 'slate') cRoof.set(ROOF_SLATE[Math.floor(hv * 10) % ROOF_SLATE.length]);
    else cRoof.set(ROOF_TILES[Math.floor(hv * 997) % ROOF_TILES.length]);
    tmp.copy(cRoof).offsetHSL(0, 0, (hash(b.id) - 0.5) * 0.06);
    cRoof.copy(tmp);

    // Normalise orientation: outer CCW, holes CW (x east / y north).
    const rings = b.rings.map((r, i) => {
      const rr = r.slice();
      if ((signedArea(rr) > 0) !== (i === 0)) rr.reverse();
      return rr;
    });

    // Walls, darkened towards the ground for a bit of ambient occlusion.
    const dark = cWall.clone().multiplyScalar(0.62);
    for (const ring of rings) {
      for (let i = 0; i < ring.length; i++) {
        const [x1, y1] = ring[i];
        const [x2, y2] = ring[(i + 1) % ring.length];
        const out = [y2 - y1, -(x2 - x1), 0];
        const a0 = [x1, y1, base], b0 = [x2, y2, base], a1 = [x1, y1, eaves], b1 = [x2, y2, eaves];
        tri(a0, b0, b1, [dark, dark, cWall], out);
        tri(a0, b1, a1, [dark, cWall, cWall], out);
      }
    }

    let roofShape = b.roof;
    if (!roofShape) {
      if (small || isWall) roofShape = 'flat';
      else if (rings.length === 1 && rings[0].length === 4) roofShape = 'gabled';
      else roofShape = 'hipped';
    }

    const flatRoof = () => {
      const pts = rings[0].map(([x, y]) => new THREE.Vector2(x, y));
      const holes = rings.slice(1).map((r) => r.map(([x, y]) => new THREE.Vector2(x, y)));
      const all = [...rings[0], ...rings.slice(1).flat()];
      const flatCol = isWall ? cWall : cRoof.clone().lerp(new THREE.Color('#8a8580'), 0.6);
      for (const [i, j, k] of THREE.ShapeUtils.triangulateShape(pts, holes)) {
        tri([...all[i], eaves], [...all[j], eaves], [...all[k], eaves], flatCol, [0, 0, 1]);
      }
      stats.flat++;
    };

    if (roofShape === 'flat') {
      flatRoof();
      continue;
    }

    let sk = null;
    try {
      sk = SkeletonBuilder.buildFromPolygon(rings.map((r) => [...r, r[0]]));
    } catch {
      sk = null;
    }
    if (!sk || !sk.polygons.length) {
      stats.failed++;
      flatRoof();
      continue;
    }

    const maxT = Math.max(...sk.vertices.map((v) => v[2])) || 1;
    const k = Math.min(PITCH, MAX_ROOF / maxT);
    const verts = sk.vertices.map((v) => [v[0], v[1], eaves + v[2] * k]);
    const gableFaces = new Set<number>();

    if (roofShape === 'gabled' && rings.length === 1 && rings[0].length === 4) {
      // Turn the two hip triangles into vertical gable ends by sliding each ridge
      // end out to the midpoint of its short edge.
      sk.polygons.forEach((face, fi) => {
        if (face.length !== 3) return;
        const apex = face.find((i) => sk.vertices[i][2] > 1e-6);
        const baseIdx = face.filter((i) => i !== apex);
        if (apex === undefined || baseIdx.length !== 2) return;
        const [p, q] = baseIdx.map((i) => sk.vertices[i]);
        verts[apex][0] = (p[0] + q[0]) / 2;
        verts[apex][1] = (p[1] + q[1]) / 2;
        gableFaces.add(fi);
      });
      if (gableFaces.size) stats.gabled++;
    }
    stats.skeleton++;

    sk.polygons.forEach((face, fi) => {
      const pts = face.map((i) => verts[i]);
      if (gableFaces.has(fi)) {
        const [p, q] = face.filter((i) => sk.vertices[i][2] <= 1e-6).map((i) => verts[i]);
        const apex = pts.find((v) => v[2] > eaves + 1e-6);
        if (!apex) return;
        const cx = rings[0].reduce((s, v) => s + v[0], 0) / 4, cy = rings[0].reduce((s, v) => s + v[1], 0) / 4;
        let out = [q[1] - p[1], -(q[0] - p[0]), 0];
        if (out[0] * ((p[0] + q[0]) / 2 - cx) + out[1] * ((p[1] + q[1]) / 2 - cy) < 0) out = out.map((v) => -v);
        tri(p, q, apex, cWall, out);
        return;
      }
      const tris = THREE.ShapeUtils.triangulateShape(
        face.map((i) => new THREE.Vector2(sk.vertices[i][0], sk.vertices[i][1])),
        [],
      );
      // Subtle per-face shade variation, like tiles weathered differently.
      const fc = cRoof.clone().offsetHSL(0, 0, (hash(b.id + fi) - 0.5) * 0.04);
      for (const [i, j, l] of tris) tri(pts[i], pts[j], pts[l], fc, [0, 0, 1]);
    });
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('drapeUv', new THREE.Float32BufferAttribute(uv, 2));
  const mesh = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true }));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return { mesh, stats };
}

// Garden walls, city walls, the Hunger Wall: thin extruded strips, standing on the
// terrain (`height(x, y)`). The arrays for wallMesh; runs in the tile workers.
export function wallArrays(data: WallTile, height: (x: number, y: number) => number = () => 0): WallBuffers {
  const pos: number[] = [], nor: number[] = [];
  const quad = (a: number[], b: number[], c: number[], d: number[], n: number[]) => {
    for (const p of [a, b, c, a, c, d]) {
      pos.push(p[0], p[2], -p[1]);
      nor.push(n[0], n[2], -n[1]);
    }
  };
  for (const w of data.walls) {
    const big = w.kind === 'city_wall' || w.kind === 'castle_wall';
    const hw = big ? 1.4 : 0.35, h = big ? 5 : 2.6;
    for (let i = 0; i < w.pts.length - 1; i++) {
      const [x1, y1] = w.pts[i], [x2, y2] = w.pts[i + 1];
      const len = Math.hypot(x2 - x1, y2 - y1) || 1;
      const nx = (y2 - y1) / len * hw, ny = -(x2 - x1) / len * hw;
      const L1 = [x1 - nx, y1 - ny], L2 = [x2 - nx, y2 - ny], R1 = [x1 + nx, y1 + ny], R2 = [x2 + nx, y2 + ny];
      const N = [nx / hw, ny / hw, 0];
      quad([...R1, 0], [...R2, 0], [...R2, h], [...R1, h], N);
      quad([...L2, 0], [...L1, 0], [...L1, h], [...L2, h], N.map((v) => -v));
      quad([...R1, h], [...R2, h], [...L2, h], [...L1, h], [0, 0, 1]);
    }
  }
  const position = new Float32Array(pos);
  for (let i = 0; i < position.length; i += 3) position[i + 1] += height(position[i], -position[i + 2]);
  return { position, normal: new Float32Array(nor) };
}

export function wallMesh({ position, normal }: WallBuffers) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(position, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  const mesh = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color: '#cbbd9f', side: THREE.DoubleSide }));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

// Optional top-down texture draped over roofs (walls keep their colours).
// Used for the AI-painted tile experiment.
export function drapeRoofs(mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshLambertMaterial>, texture: THREE.Texture) {
  const u = { roofMap: { value: texture }, roofMix: { value: 0 } };
  const m = mesh.material;
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 drapeUv;\nvarying vec2 vDrapeUv; varying float vUp;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vDrapeUv = drapeUv; vUp = normal.y;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D roofMap; uniform float roofMix; varying vec2 vDrapeUv; varying float vUp;')
      .replace('#include <color_fragment>', `#include <color_fragment>
  vec4 drape = texture2D(roofMap, vDrapeUv);
  diffuseColor.rgb = mix(diffuseColor.rgb, drape.rgb, roofMix * drape.a * smoothstep(0.35, 0.6, vUp));`);
  };
  m.needsUpdate = true;
  return u;
}
