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

const FENCE_VERTS = 6;
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
    for (let i = 0; i < line.pts.length - 1; i++) {
      const [ax, ay] = line.pts[i], [bx, by] = line.pts[i + 1];
      const len = Math.hypot(bx - ax, by - ay);
      if (len < 0.05) continue;
      const n = Math.ceil(len / SECTION);
      for (let s = 0; s < n; s++) {
        const x1 = ax + (bx - ax) * s / n, y1 = ay + (by - ay) * s / n;
        const x2 = ax + (bx - ax) * (s + 1) / n, y2 = ay + (by - ay) * (s + 1) / n;
        const z1 = height(x1, y1), z2 = height(x2, y2);
        const u1 = (along + len * s / n) / repeat, u2 = (along + len * (s + 1) / n) / repeat;
        sections.push(x1, y1, x2, y2, (z1 + z2) / 2, h, hedge ? 1 : rail ? 2 : 0, m.pos.length / 3);
        const nx = (y2 - y1) / (len / n), ny = -(x2 - x1) / (len / n);
        // A quad from the bottom edge (x1,y1,z1)-(x2,y2,z2) up by `up`, pushed out by (ox, oy).
        const quad = (ox1: number, oy1: number, ox2: number, oy2: number, up1: number, up2: number, zb1: number, zb2: number, n3: number[], uv: number[], flip = false) => {
          const P = [[x1 + ox1, zb1, -(y1 + oy1)], [x2 + ox2, zb2, -(y2 + oy2)], [x2 + ox2, zb2 + up2, -(y2 + oy2)], [x1 + ox1, zb1 + up1, -(y1 + oy1)]];
          const U = [[uv[0], 0], [uv[1], 0], [uv[1], 1], [uv[0], 1]];
          for (const k of flip ? [0, 2, 1, 0, 3, 2] : [0, 1, 2, 0, 2, 3]) {
            m.pos.push(...P[k]);
            m.nor.push(n3[0], n3[2], -n3[1]);
            m.uv.push(...U[k]);
          }
        };
        const sink = -0.05;
        if (!hedge) {
          quad(0, 0, 0, 0, h - sink, h - sink, z1 + sink, z2 + sink, [nx, ny, 0], [u1, u2]);
        } else {
          const w = HEDGE_W / 2, wx = nx * w, wy = ny * w;
          quad(wx, wy, wx, wy, h - sink, h - sink, z1 + sink, z2 + sink, [nx, ny, 0], [u1, u2]);
          quad(-wx, -wy, -wx, -wy, h - sink, h - sink, z1 + sink, z2 + sink, [-nx, -ny, 0], [u2, u1], true);
          // The top, a strip of the two sides' top edges.
          const T = [[x1 + wx, z1 + h, -(y1 + wy)], [x2 + wx, z2 + h, -(y2 + wy)], [x2 - wx, z2 + h, -(y2 - wy)], [x1 - wx, z1 + h, -(y1 - wy)]];
          const V = [[u1, 0.2], [u2, 0.2], [u2, 0.8], [u1, 0.8]];
          for (const k of [0, 1, 2, 0, 2, 3]) { m.pos.push(...T[k]); m.nor.push(0, 1, 0); m.uv.push(...V[k]); }
          // The two ends, so a hedge's last section isn't hollow.
          for (const [ex, ey, ez, sgn] of [[x1, y1, z1, -1], [x2, y2, z2, 1]] as const) {
            const dx = (x2 - x1) / (len / n) * sgn, dy = (y2 - y1) / (len / n) * sgn;
            const P = [[ex - wx, ez + sink, -(ey - wy)], [ex + wx, ez + sink, -(ey + wy)], [ex + wx, ez + h, -(ey + wy)], [ex - wx, ez + h, -(ey - wy)]];
            for (const k of sgn > 0 ? [1, 0, 3, 1, 3, 2] : [0, 1, 2, 0, 2, 3]) {
              m.pos.push(...P[k]);
              m.nor.push(dx, 0, -dy);
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
    fence: make(fence, new THREE.MeshLambertMaterial({ map: pickets(), alphaTest: 0.5, side: THREE.DoubleSide }), false),
    hedge: make(hedge, hedgeMaterial, true),
    rail: make(rail, new THREE.MeshLambertMaterial({ map: barrier(), alphaTest: 0.5, side: THREE.DoubleSide }), false),
  };
}

export const VERTS = { fence: FENCE_VERTS, hedge: HEDGE_VERTS, rail: FENCE_VERTS };
