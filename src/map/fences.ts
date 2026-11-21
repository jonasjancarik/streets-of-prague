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
const FENCE_REPEAT = 2.4; // m of fence the fence texture repeats over (a post at each end)
// The fence looks, rows of one texture from the bottom up: a wire mesh on posts, wooden
// boards, metal bars. How often each is put up, in a garden suburb.
const LOOKS = 3;
const ATLAS_ROWS = LOOKS + 1;
const SLATTED_GATE = LOOKS;
const LOOK_SHARE = [0.55, 0.25, 0.2];
const LOOK_AREA = 20; // m: fences within one square of this size look the same
// Which look a fence starting at (x, y) has: the same for the pieces of one plot's fence
// (the survey gives them one by one), changing from one stretch of street to the next.
function fenceLook(x: number, y: number) {
  const i = Math.floor(x / LOOK_AREA), j = Math.floor(y / LOOK_AREA);
  const h = Math.abs(Math.imul(i, 73856093) ^ Math.imul(j, 19349663)) % 1000 / 1000;
  let k = 0, sum = LOOK_SHARE[0];
  while (h >= sum && k < LOOKS - 1) sum += LOOK_SHARE[++k];
  return k;
}

const FENCE_VERTS = 12; // a face each way
const LEAN = 0.45; // how far a fence's two faces lean apart from straight up, for its light
// A hedge's outline across it, from the right foot over the top to the left: how far out
// (in half widths) and how far up (in heights).
const HEDGE_OUTLINE: [number, number][] = [[0.8, 0], [1, 0.3], [0.97, 0.72], [0.62, 0.96], [0, 1.04], [-0.62, 0.96], [-0.97, 0.72], [-1, 0.3], [-0.8, 0]];
// How far round the outline each of its points is from the foot, for a hedge 1.5 m tall.
const HEDGE_ROUND = HEDGE_OUTLINE.map((_, k) => {
  let d = 0;
  for (let i = 1; i <= k; i++) d += Math.hypot((HEDGE_OUTLINE[i][0] - HEDGE_OUTLINE[i - 1][0]) * HEDGE_W / 2 / HEDGE_H, HEDGE_OUTLINE[i][1] - HEDGE_OUTLINE[i - 1][1]);
  return d;
});
const HEDGE_VERTS = (HEDGE_OUTLINE.length - 1) * 6 * 2 + (HEDGE_OUTLINE.length - 1) * 3 * 2; // two slices round, and the two ends
// How a hedge has grown at a place (0-1), the same from whichever section asks.
function hedgeNoise(x: number, y: number, salt: number) {
  const s = Math.sin(Math.round(x * 4) * 12.9898 + Math.round(y * 4) * 78.233 + salt * 37.719) * 43758.5453;
  return s - Math.floor(s);
}
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
    const repeat = hedge ? 2 : rail ? RAIL_POSTS : FENCE_REPEAT;
    // The texture rows a fence's faces take (a small gap left either side of each).
    const look = line.kind === 'slatted_gate' ? SLATTED_GATE
      : !hedge && !rail ? fenceLook(line.pts[0][0], line.pts[0][1]) : 0;
    const rows: [number, number] = rail ? [0, 1] : [(look + 0.03) / ATLAS_ROWS, (look + 0.97) / ATLAS_ROWS];
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
          const [v0, v1] = hedge ? [0, 1] : rows;
          const U = [[uv[0], v0], [uv[1], v0], [uv[1], v1], [uv[0], v1]];
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
          // A clipped hedge is not a box: its sides belly out a little over a narrower foot,
          // its shoulders are round and its top is slightly crowned, and no two stretches
          // are quite as tall or as wide (it grows between cuts). Rings of the outline
          // stand at the section's two ends and its middle; where sections meet they
          // agree, as the unevenness goes by the place.
          const o1 = s === 0 ? startOff : [nx, ny], o2 = s === n - 1 ? endOff : [nx, ny];
          const ring = (f: number) => {
            const cx = x1 + (x2 - x1) * f, cy = y1 + (y2 - y1) * f, cz = f === 0 ? z1 : f === 1 ? z2 : height(cx, cy);
            const o = f === 0 ? o1 : f === 1 ? o2 : [nx, ny];
            const grown = 1 + (hedgeNoise(cx, cy, 1) - 0.5) * 0.16, wide = (HEDGE_W / 2) * (1 + (hedgeNoise(cx, cy, 2) - 0.5) * 0.3);
            const top = cz + h * grown;
            const foot = (side: number) => Math.min(height(cx + o[0] * wide * side, cy + o[1] * wide * side), cz) + sink;
            const feet = [foot(1), cz + sink, foot(-1)];
            return HEDGE_OUTLINE.map(([across, up], k) => {
              const base = feet[across > 0 ? 0 : across < 0 ? 2 : 1];
              // The outline's own normal, from its neighbours (rounded, not faceted).
              const a = HEDGE_OUTLINE[Math.max(0, k - 1)], b = HEDGE_OUTLINE[Math.min(HEDGE_OUTLINE.length - 1, k + 1)];
              let ta = (b[0] - a[0]) * wide, tu = (b[1] - a[1]) * h;
              if (k === 0 || k === HEDGE_OUTLINE.length - 1) { ta = 0; tu = k === 0 ? 1 : -1; } // (the foot faces straight out)
              const l = Math.hypot(ta, tu) || 1, na = tu / l, nu = -ta / l;
              return {
                p: [cx + o[0] * wide * across, base + (top - base) * up, -(cy + o[1] * wide * across)],
                // (v: how far round the outline from the foot, in heights, so the leaves are as
                // big on the shoulders and the top as on the sides; it also shades the foot darker.)
                n: [nx * na, nu, -ny * na], v: HEDGE_ROUND[Math.min(k, HEDGE_OUTLINE.length - 1 - k)], across: across * wide,
              };
            });
          };
          const rings = [ring(0), ring(0.5), ring(1)], us = [u1, (u1 + u2) / 2, u2];
          for (let r = 0; r < 2; r++) for (let k = 0; k < HEDGE_OUTLINE.length - 1; k++) {
            const Q = [rings[r][k], rings[r + 1][k], rings[r + 1][k + 1], rings[r][k + 1]], U = [us[r], us[r + 1], us[r + 1], us[r]];
            for (const q of [0, 1, 2, 0, 2, 3]) { m.pos.push(...Q[q].p); m.nor.push(...Q[q].n); m.uv.push(U[q], Q[q].v); }
          }
          // The two ends, so a hedge's last section isn't hollow: a fan from the foot's middle.
          for (const [R, sgn] of [[rings[0], -1], [rings[2], 1]] as const) {
            const c = [(R[0].p[0] + R[8].p[0]) / 2, (R[0].p[1] + R[8].p[1]) / 2, (R[0].p[2] + R[8].p[2]) / 2];
            for (let k = 0; k < HEDGE_OUTLINE.length - 1; k++) {
              const T = sgn < 0 ? [null, R[k], R[k + 1]] : [null, R[k + 1], R[k]];
              for (const t of T) {
                m.pos.push(...(t ? t.p : c));
                m.nor.push(dir[0] * sgn, 0.25, -dir[1] * sgn);
                m.uv.push(us[sgn < 0 ? 0 : 2] + (t ? t.across : 0) / 2, t ? t.v : 0);
              }
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

// How light a hedge is by its texture's v (`v`): the sides darker towards the ground,
// where the inside of the hedge shows through and the light doesn't reach; the top
// (v from 2.2 to 2.8) darker along its two edges, so from above it has a rounded look.
export const HEDGE_SHADE_GLSL = '(vUv.y < 1.5 ? mix(0.55, 1.0, smoothstep(0.0, 1.0, vUv.y)) : 1.0 - 0.3 * smoothstep(0.12, 0.3, abs(fract(vUv.y) - 0.5)))';

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

// The fence looks (see LOOKS), one row each, see-through where nothing is drawn: a wire
// mesh on dark green posts, which hardly shows from above; weathered wooden boards;
// anthracite bars. Each row's width is FENCE_REPEAT of fence with a post at its ends.
function pickets() {
  if (picketMap) return picketMap;
  const W = 128, H = 64, c = document.createElement('canvas');
  c.width = W; c.height = H * ATLAS_ROWS;
  const g = c.getContext('2d')!;
  let seed = 11;
  const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  // Row k of the texture is the k-th from the bottom (the canvas is flipped onto it).
  const top = (k: number) => (ATLAS_ROWS - 1 - k) * H;
  // A wire mesh: diamonds of thin wire between posts, a tension wire along the top.
  let y0 = top(0) + 2;
  g.fillStyle = '#4f5b52';
  for (let d = -H; d < W + H; d += 9) {
    for (let y = 0; y < H - 6; y++) {
      g.fillRect(d + y * 0.7, y0 + 3 + y, 1.6, 1);
      g.fillRect(d - y * 0.7, y0 + 3 + y, 1.6, 1);
    }
  }
  g.fillStyle = '#39443b';
  g.fillRect(0, y0, W, 3);
  g.fillRect(0, y0 + 0, 4, H - 4);
  g.fillRect(W - 4, y0, 4, H - 4);
  // Boards: weathered planks, a finger's gap between them, on two battens.
  y0 = top(1) + 2;
  for (let x = 0; x < W; x += 9) {
    const l = 26 + rand() * 12;
    g.fillStyle = `hsl(${24 + rand() * 10},${22 + rand() * 12}%,${l}%)`;
    g.fillRect(x, y0 + rand() * 2, 8, H - 6);
  }
  g.fillStyle = '#4a3a2b';
  g.fillRect(0, y0 + 10, W, 4);
  g.fillRect(0, y0 + H - 18, W, 4);
  // Bars: thin uprights between a top and a bottom rail, posts at the ends.
  y0 = top(2) + 2;
  g.fillStyle = '#2f3234';
  for (let x = 6; x < W - 4; x += 7) g.fillRect(x, y0 + 2, 2, H - 8);
  g.fillRect(0, y0 + 4, W, 3);
  g.fillRect(0, y0 + H - 12, W, 3);
  g.fillRect(0, y0, 5, H - 4);
  g.fillRect(W - 5, y0, 5, H - 4);
  // Dark horizontal slats and square steel posts on the Morávkova gates.
  y0 = top(SLATTED_GATE) + 2;
  for (let y = 0; y < H - 5; y += 7) {
    g.fillStyle = '#393438';
    g.fillRect(0, y0 + y, W, 6);
    g.fillStyle = '#51484e';
    g.fillRect(0, y0 + y, W, 1);
  }
  g.fillStyle = '#29272a';
  g.fillRect(0, y0, 5, H - 4);
  g.fillRect(W - 5, y0, 5, H - 4);
  picketMap = new THREE.CanvasTexture(c);
  picketMap.wrapS = THREE.RepeatWrapping;
  picketMap.colorSpace = THREE.SRGBColorSpace;
  picketMap.anisotropy = 4;
  return picketMap;
}

// Blotchy foliage, about as dark as the lawn beside it: small leaves in clumps.
function leaves() {
  if (leafMap) return leafMap;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = '#34502a';
  g.fillRect(0, 0, 64, 64);
  let seed = 7;
  const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 260; i++) {
    const l = 16 + rand() * 20;
    g.fillStyle = `hsl(${80 + rand() * 35},${30 + rand() * 18}%,${l}%)`;
    const x = rand() * 64, y = rand() * 64, r = 1 + rand() * 2.5;
    // Drawn again across the edges, so the texture tiles without a seam.
    for (const dx of [-64, 0, 64]) for (const dy of [-64, 0, 64]) {
      g.beginPath();
      g.arc(x + dx, y + dy, r, 0, 6.3);
      g.fill();
    }
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
  hedgeMaterial.defines = { USE_UV: '' };
  hedgeMaterial.customProgramCacheKey = () => 'hedge-season';
  hedgeMaterial.onBeforeCompile = (sh) => {
    sh.uniforms.uHedgeSeason = HEDGE_SEASON;
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uHedgeSeason;')
      .replace('#include <color_fragment>', `#include <color_fragment>
diffuseColor.rgb *= uHedgeSeason * ${HEDGE_SHADE_GLSL};`);
  };
  return {
    fence: make(fence, new THREE.MeshLambertMaterial({ map: pickets(), alphaTest: 0.5 }), false),
    hedge: make(hedge, hedgeMaterial, true),
    rail: make(rail, new THREE.MeshLambertMaterial({ map: barrier(), alphaTest: 0.5 }), false),
  };
}

export const VERTS = { fence: FENCE_VERTS, hedge: HEDGE_VERTS, rail: FENCE_VERTS };
