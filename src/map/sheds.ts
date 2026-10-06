import * as THREE from 'three';
import type { Point2 } from './geo.ts';

// Garden sheds (pipeline/plots.py): a plain box under a low ridged roof, all of a
// tile's in one mesh with the colours in its vertices, so a suburb's sheds cost one
// draw a tile. They are solid (tileWorker.ts).

// x, y, the way its long side runs (radians), length, width, height of the eaves.
export type Shed = number[];
export interface ShedBuffers { position: Float32Array; normal: Float32Array; color: Float32Array }

// Creosoted boards, green and grey paint, bare larch; the roof is felt or old tin.
const WALLS = [[0.36, 0.25, 0.17], [0.3, 0.38, 0.27], [0.55, 0.53, 0.48], [0.62, 0.5, 0.34], [0.45, 0.3, 0.2]];
const ROOFS = [[0.2, 0.2, 0.21], [0.33, 0.3, 0.28], [0.42, 0.25, 0.2]];
const RIDGE = 0.45; // m the ridge stands above the eaves
const EAVES = 0.15; // m the roof reaches past the walls

export function shedCorners([x, y, heading, length, width]: Shed, grow = 0): Point2[] {
  const c = Math.cos(heading), s = Math.sin(heading), l = length / 2 + grow, w = width / 2 + grow;
  return [[-l, -w], [l, -w], [l, w], [-l, w]].map(([u, v]): Point2 => [x + u * c - v * s, y + u * s + v * c]);
}

// Ready to run in the tile workers: `height(x, y)` is the terrain.
export function shedArrays(sheds: Shed[] | undefined, height: (x: number, y: number) => number = () => 0): ShedBuffers {
  const pos: number[] = [], nor: number[] = [], col: number[] = [];
  // (Map coordinates in, three's out: x, up, -y.)
  const tri = (a: number[], b: number[], c: number[], rgb: number[]) => {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, len = Math.hypot(nx, ny, nz) || 1;
    for (const p of [a, b, c]) {
      pos.push(p[0], p[2], -p[1]);
      nor.push(nx / len, nz / len, -ny / len);
      col.push(...rgb);
    }
  };
  const quad = (a: number[], b: number[], c: number[], d: number[], rgb: number[]) => { tri(a, b, c, rgb); tri(a, c, d, rgb); };
  for (const shed of sheds ?? []) {
    const pick = Math.abs(Math.floor(shed[0] * 7.3 + shed[1] * 3.1));
    const wall = WALLS[pick % WALLS.length], roof = ROOFS[(pick >> 2) % ROOFS.length];
    const P = shedCorners(shed), E = shedCorners(shed, EAVES);
    const zs = P.map(([px, py]) => height(px, py));
    const base = Math.min(...zs) - 0.1, top = Math.max(...zs) + shed[5], ridge = top + RIDGE;
    // The ridge runs along the long side: its two ends over the middles of the short walls.
    const mid = (a: Point2, b: Point2) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const r0 = mid(P[3], P[0]), r1 = mid(P[1], P[2]), e0 = mid(E[3], E[0]), e1 = mid(E[1], E[2]);
    for (let k = 0; k < 4; k++) {
      const a = P[k], b = P[(k + 1) % 4];
      quad([a[0], a[1], base], [b[0], b[1], base], [b[0], b[1], top], [a[0], a[1], top], wall);
    }
    tri([P[1][0], P[1][1], top], [P[2][0], P[2][1], top], [r1[0], r1[1], ridge], wall);
    tri([P[3][0], P[3][1], top], [P[0][0], P[0][1], top], [r0[0], r0[1], ridge], wall);
    const low = top - EAVES * RIDGE / (shed[4] / 2);
    quad([E[0][0], E[0][1], low], [E[1][0], E[1][1], low], [e1[0], e1[1], ridge], [e0[0], e0[1], ridge], roof);
    quad([E[2][0], E[2][1], low], [E[3][0], E[3][1], low], [e0[0], e0[1], ridge], [e1[0], e1[1], ridge], roof);
  }
  return { position: new Float32Array(pos), normal: new Float32Array(nor), color: new Float32Array(col) };
}

// The tile's sheds as one mesh, or null where it has none.
export function shedMesh({ position, normal, color }: ShedBuffers) {
  if (!position.length) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(position, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  g.setAttribute('color', new THREE.BufferAttribute(color, 3));
  // (Both sides: a roof seen from under its eaves, and no care needed about winding.)
  const mesh = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}
