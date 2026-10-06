import * as THREE from 'three';
import type { Point2 } from './geo.ts';
import { HEDGE_SEASON } from '../groundSeason.ts';

// Fences, hedges and crash barriers as a row of short sections (a car breaks one at a
// time, see fences.ts).
// Each section is a fixed number of vertices in its mesh, so the game can find it again.

export interface FenceTile { fences?: { kind: string; h?: number; pts: Point2[] }[] }

export const FENCE_H = 1.2; // m: a fence no one tagged a height on
export const HEDGE_H = 1.5;
export const HEDGE_W = 0.8; // m
export const RAIL_H = 0.75; // m: a crash barrier's beam is at bumper height
const RAIL_POSTS = 4; // m of barrier the post-and-beam texture repeats over (a post every 2 m)
const SECTION = 3; // m: the longest piece a line is cut into
const PICKET = 1.6; // m of fence the picket texture repeats over

const FENCE_VERTS = 12; // a face each way
const LEAN = 0.45; // how far a fence's two faces lean apart from straight up, for its light
const HEDGE_VERTS = 30;
export const SECTION_STRIDE = 8;

export interface FenceBuffers {
  fence: { position: Float32Array; normal: Float32Array; uv: Float32Array };
  hedge: { position: Float32Array; normal: Float32Array; uv: Float32Array };
  rail: { position: Float32Array; normal: Float32Array; uv: Float32Array };
  // Per section: x1, y1, x2, y2, ground, height, fence (0), hedge (1) or crash barrier (2),
  // first vertex in its mesh.
  sections: Float32Array;
}

// Ready to run in the tile workers: `height(x, y)` is the terrain.
export function fenceArrays(data: FenceTile, height: (x: number, y: number) => number = () => 0): FenceBuffers {
  const out = {
    fence: { pos: [] as number[], nor: [] as number[], uv: [] as number[] },
    hedge: { pos: [] as number[], nor: [] as number[], uv: [] as number[] },
    rail: { pos: [] as number[], nor: [] as number[], uv: [] as number[] },
  };
  const sections: number[] = [];
  for (const line of data.fences ?? []) {
    const hedge = line.kind === 'hedge';
    const rail = line.kind === 'guard_rail';
    const h = rail ? RAIL_H : line.h ?? (hedge ? HEDGE_H : FENCE_H);
    const m = hedge ? out.hedge : rail ? out.rail : out.fence;
    const repeat = hedge ? 2 : rail ? RAIL_POSTS : PICKET;
    let along = 0;
    // Where the line bends, a hedge's two sides meet on the bisector of the bend, so no
    // wedge is left open on the outside of a plot's corner: `mitre(i)` is the offset of
    // the right-hand side at point i, as a multiple of half the hedge's width.
    const pts = line.pts;
    const unit = (i: number): Point2 | null => {
      const dx = pts[i + 1][0] - pts[i][0], dy = pts[i + 1][1] - pts[i][1], len = Math.hypot(dx, dy);
      return len < 0.05 ? null : [dx / len, dy / len];
    };
    const mitre = (i: number, own: Point2): Point2 => {
      const before = i > 0 ? unit(i - 1) : null, after = i < pts.length - 1 ? unit(i) : null;
      const a = before ?? own, b = after ?? own;
      // Along the bisector of the two right-hand normals, lengthened so both sides stay
      // parallel to their own stretch; a turn sharper than 120° is left square.
      const d = 1 + a[0] * b[0] + a[1] * b[1];
      if (d < 0.5) return [own[1], -own[0]];
      return [(a[1] + b[1]) / d, (-a[0] - b[0]) / d];
    };
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, ay] = pts[i], [bx, by] = pts[i + 1];
      const len = Math.hypot(bx - ax, by - ay);
      if (len < 0.05) continue;
      const dir: Point2 = [(bx - ax) / len, (by - ay) / len];
      const n = Math.ceil(len / SECTION);
      const startOff = mitre(i, dir), endOff = mitre(i + 1, dir);
      for (let s = 0; s < n; s++) {
        const x1 = ax + (bx - ax) * s / n, y1 = ay + (by - ay) * s / n;
        const x2 = ax + (bx - ax) * (s + 1) / n, y2 = ay + (by - ay) * (s + 1) / n;
        const z1 = height(x1, y1), z2 = height(x2, y2);
        const u1 = (along + len * s / n) / repeat, u2 = (along + len * (s + 1) / n) / repeat;
        sections.push(x1, y1, x2, y2, (z1 + z2) / 2, h, hedge ? 1 : rail ? 2 : 0, m.pos.length / 3);
        const nx = dir[1], ny = -dir[0];
        // A quad from the bottom edge (x1,y1,zb1)-(x2,y2,zb2) up to the heights t1 and t2, pushed out by (ox, oy).
        const quad = (ox1: number, oy1: number, ox2: number, oy2: number, t1: number, t2: number, zb1: number, zb2: number, n3: number[], uv: number[], flip = false) => {
          const P = [[x1 + ox1, zb1, -(y1 + oy1)], [x2 + ox2, zb2, -(y2 + oy2)], [x2 + ox2, t2, -(y2 + oy2)], [x1 + ox1, t1, -(y1 + oy1)]];
          const U = [[uv[0], 0], [uv[1], 0], [uv[1], 1], [uv[0], 1]];
          for (const k of flip ? [0, 2, 1, 0, 3, 2] : [0, 1, 2, 0, 2, 3]) {
            m.pos.push(...P[k]);
            m.nor.push(n3[0], n3[2], -n3[1]);
            m.uv.push(...U[k]);
          }
        };
        const sink = -0.05;
        if (!hedge) {
          // A face each way, both leaning towards the sky: a fence is a row of pickets with
          // light between them, so the side away from the sun is nearly as bright as the
          // other, where a single upright plane would be black from that side.
          quad(0, 0, 0, 0, z1 + h, z2 + h, z1 + sink, z2 + sink, [nx * LEAN, ny * LEAN, 1], [u1, u2]);
          quad(0, 0, 0, 0, z1 + h, z2 + h, z1 + sink, z2 + sink, [-nx * LEAN, -ny * LEAN, 1], [u1, u2], true);
        } else {
          const w = HEDGE_W / 2;
          const o1 = s === 0 ? startOff : [nx, ny], o2 = s === n - 1 ? endOff : [nx, ny];
          // Each side stands on the ground under it and the top is level across the hedge,
          // so on a slope the downhill side doesn't hang in the air.
          const R1 = [x1 + o1[0] * w, y1 + o1[1] * w], R2 = [x2 + o2[0] * w, y2 + o2[1] * w];
          const L1 = [x1 - o1[0] * w, y1 - o1[1] * w], L2 = [x2 - o2[0] * w, y2 - o2[1] * w];
          const t1 = z1 + h, t2 = z2 + h;
          const foot = (p: number[], z: number) => Math.min(height(p[0], p[1]), z) + sink;
          const zr1 = foot(R1, z1), zr2 = foot(R2, z2), zl1 = foot(L1, z1), zl2 = foot(L2, z2);
          quad(o1[0] * w, o1[1] * w, o2[0] * w, o2[1] * w, t1, t2, zr1, zr2, [nx, ny, 0], [u1, u2]);
          quad(-o1[0] * w, -o1[1] * w, -o2[0] * w, -o2[1] * w, t1, t2, zl1, zl2, [-nx, -ny, 0], [u2, u1], true);
          // The top, a strip of the two sides' top edges.
          const T = [[R1[0], t1, -R1[1]], [R2[0], t2, -R2[1]], [L2[0], t2, -L2[1]], [L1[0], t1, -L1[1]]];
          const V = [[u1, 0.2], [u2, 0.2], [u2, 0.8], [u1, 0.8]];
          for (const k of [0, 1, 2, 0, 2, 3]) { m.pos.push(...T[k]); m.nor.push(0, 1, 0); m.uv.push(...V[k]); }
          // The two ends, so a hedge's last section isn't hollow.
          for (const [A, B, za, zb, top, sgn] of [[L1, R1, zl1, zr1, t1, -1], [L2, R2, zl2, zr2, t2, 1]] as const) {
            const P = [[A[0], za, -A[1]], [B[0], zb, -B[1]], [B[0], top, -B[1]], [A[0], top, -A[1]]];
            for (const k of sgn > 0 ? [1, 0, 3, 1, 3, 2] : [0, 1, 2, 0, 2, 3]) {
              m.pos.push(...P[k]);
              m.nor.push(dir[0] * sgn, 0, -dir[1] * sgn);
              m.uv.push(k === 1 || k === 2 ? 1 : 0, k > 1 ? 1 : 0);
            }
          }
        }
      }
      along += len;
    }
  }
  const pack = (m: { pos: number[]; nor: number[]; uv: number[] }) =>
    ({ position: new Float32Array(m.pos), normal: new Float32Array(m.nor), uv: new Float32Array(m.uv) });
  return { fence: pack(out.fence), hedge: pack(out.hedge), rail: pack(out.rail), sections: new Float32Array(sections) };
}

let picketMap: THREE.CanvasTexture | null = null;
let leafMap: THREE.CanvasTexture | null = null;
let railMap: THREE.CanvasTexture | null = null;

// A crash barrier: a galvanised beam along the top on a post every 2 m, clear below it.
function barrier() {
  if (railMap) return railMap;
  const c = document.createElement('canvas');
  c.width = 128; c.height = 32;
  const g = c.getContext('2d')!;
  g.fillStyle = '#6f7478';
  for (const x of [28, 92]) g.fillRect(x, 10, 6, 22);
  // The beam's two ridges, lit above and shaded below.
  g.fillStyle = '#b4babd'; g.fillRect(0, 1, 128, 13);
  g.fillStyle = '#d2d7d9'; g.fillRect(0, 2, 128, 3); g.fillRect(0, 9, 128, 2);
  g.fillStyle = '#8b9296'; g.fillRect(0, 6, 128, 2); g.fillRect(0, 12, 128, 2);
  railMap = new THREE.CanvasTexture(c);
  railMap.wrapS = THREE.RepeatWrapping;
  railMap.colorSpace = THREE.SRGBColorSpace;
  railMap.anisotropy = 4;
  return railMap;
}

// Pickets between two rails, on clear ground: see-through between the pickets.
function pickets() {
  if (picketMap) return picketMap;
  const c = document.createElement('canvas');
  c.width = 128; c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = '#b9ad94';
  g.fillRect(0, 12, 128, 5);
  g.fillRect(0, 42, 128, 5);
  for (let i = 0; i < 8; i++) {
    const shade = 218 + ((i * 37) % 5) * 5;
    g.fillStyle = `rgb(${shade},${shade - 6},${shade - 24})`;
    g.fillRect(i * 16 + 2, 2, 12, 62);
  }
  picketMap = new THREE.CanvasTexture(c);
  picketMap.wrapS = THREE.RepeatWrapping;
  picketMap.colorSpace = THREE.SRGBColorSpace;
  picketMap.anisotropy = 4;
  return picketMap;
}

// Blotchy foliage.
function leaves() {
  if (leafMap) return leafMap;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = '#4d7534';
  g.fillRect(0, 0, 64, 64);
  let seed = 7;
  const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 90; i++) {
    const l = 30 + rand() * 22;
    g.fillStyle = `hsl(${88 + rand() * 25},${38 + rand() * 20}%,${l}%)`;
    g.beginPath();
    g.arc(rand() * 64, rand() * 64, 2 + rand() * 4, 0, 6.3);
    g.fill();
  }
  leafMap = new THREE.CanvasTexture(c);
  leafMap.wrapS = leafMap.wrapT = THREE.RepeatWrapping;
  leafMap.colorSpace = THREE.SRGBColorSpace;
  return leafMap;
}

export function fenceMeshes({ fence, hedge, rail }: FenceBuffers) {
  const make = (a: FenceBuffers['fence'], material: THREE.Material, shadow: boolean) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(a.position, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(a.normal, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(a.uv, 2));
    const mesh = new THREE.Mesh(g, material);
    mesh.castShadow = shadow;
    mesh.receiveShadow = true;
    return mesh;
  };
  const hedgeMaterial = new THREE.MeshLambertMaterial({ map: leaves() });
  hedgeMaterial.customProgramCacheKey = () => 'hedge-season';
  hedgeMaterial.onBeforeCompile = (sh) => {
    sh.uniforms.uHedgeSeason = HEDGE_SEASON;
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uHedgeSeason;')
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb *= uHedgeSeason;');
  };
  return {
    fence: make(fence, new THREE.MeshLambertMaterial({ map: pickets(), alphaTest: 0.5 }), false),
    hedge: make(hedge, hedgeMaterial, true),
    rail: make(rail, new THREE.MeshLambertMaterial({ map: barrier(), alphaTest: 0.5 }), false),
  };
}

export const VERTS = { fence: FENCE_VERTS, hedge: HEDGE_VERTS, rail: FENCE_VERTS };
