import * as THREE from 'three';

type Tower = [x: number, y: number, elevation: number, height: number, bearing: number];
type Span = [from: number, to: number, start: number, end: number];
interface PowerTile { t: number[]; w: Span[] }
export interface PowerGrid { towers: Tower[]; tiles: Record<string, PowerTile> }
type Vec = [number, number, number];

const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const tuple = (v: unknown, n: number): v is number[] => Array.isArray(v) && v.length === n && v.every(Number.isFinite);
export function readPowerGrid(value: unknown, area: string, built?: string): PowerGrid | null {
  if (!record(value) || value.area !== area || value.built !== built || !Array.isArray(value.towers) || !record(value.tiles)) return null;
  if (!value.towers.every((t) => tuple(t, 5) && t[3] >= 8 && t[3] <= 85)) return null;
  const count = value.towers.length;
  const towerId = (i: unknown): i is number => typeof i === 'number' && Number.isInteger(i) && i >= 0 && i < count;
  for (const t of Object.values(value.tiles)) {
    if (!record(t) || !Array.isArray(t.t) || !Array.isArray(t.w) || !t.t.every(towerId) ||
        !t.w.every((w) => tuple(w, 4) && towerId(w[0]) && towerId(w[1]) && w[0] !== w[1] && w[2] >= 0 && w[3] <= 1 && w[2] < w[3])) return null;
  }
  return { towers: value.towers as Tower[], tiles: value.tiles as Record<string, PowerTile> };
}

// One mesh per tile. Towers use tapered lattice legs and three points of
// attachment. Wire heights come from the same two towers even at tile seams.
export function powerMesh(map: PowerGrid, key: string, ref: number, ground?: (x: number, y: number) => number): THREE.Mesh | null {
  const tile = map.tiles[key];
  if (!tile || !tile.t.length && !tile.w.length) return null;
  const position: number[] = [], index: number[] = [];
  const axis = new THREE.Vector3(), u = new THREE.Vector3(), v = new THREE.Vector3();
  const rod = (a: Vec, b: Vec, thickness: number) => {
    axis.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]).normalize();
    if (!axis.lengthSq()) return;
    u.set(Math.abs(axis.y) < 0.9 ? 0 : 1, Math.abs(axis.y) < 0.9 ? 1 : 0, 0).cross(axis).normalize().multiplyScalar(thickness);
    v.crossVectors(axis, u);
    const first = position.length / 3;
    for (const p of [a, b]) {
      for (const [s, t] of [[1, 1], [-1, 1], [-1, -1], [1, -1]]) {
        position.push(p[0] + s*u.x + t*v.x, p[1] + s*u.y + t*v.y, p[2] + s*u.z + t*v.z);
      }
    }
    for (let k = 0; k < 4; k++) {
      const a = first + k, b = first + (k + 1) % 4;
      index.push(a, b, b + 4, a, b + 4, a + 4);
    }
  };
  const arm = (h: number) => Math.min(6, h * 0.18);
  const point = ([x, y, z, , angle]: Tower, along: number, across: number, h: number): Vec => {
    const c = Math.cos(angle), s = Math.sin(angle);
    return [x + c*along - s*across, z - ref + h, -(y + s*along + c*across)];
  };
  const corners = [[1, 1], [-1, 1], [-1, -1], [1, -1]];
  for (const id of tile.t) {
    const tower = map.towers[id], h = tower[3];
    const ring = (t: number) => corners.map(([s, q]) => {
      const half = h * (0.10 * (1 - t) + 0.026);
      return point(tower, s*half, q*half, t*h);
    });
    let below = ring(0);
    // Set each leg on the local slope without moving the wire attachments.
    if (ground) for (const p of below) {
      const h = ground(p[0], -p[2]);
      if (Number.isFinite(h)) p[1] = h;
    }
    const stages = Math.ceil(h / 5);
    for (let i = 1; i <= stages; i++) {
      const top = ring(0.88 * i / stages);
      for (let k = 0; k < 4; k++) {
        const next = (k+1) % 4;
        rod(below[k], top[k], 0.075);
        rod(top[k], top[next], 0.045);
        rod(below[k], top[next], 0.036);
        rod(below[next], top[k], 0.036);
      }
      below = top;
    }
    const left = point(tower, 0, -arm(h), h * 0.86), right = point(tower, 0, arm(h), h * 0.86);
    const head = point(tower, 0, 0, h);
    rod(left, right, 0.09);
    rod(left, head, 0.055);
    rod(right, head, 0.055);
    below.forEach((p) => rod(p, head, 0.055));
    for (const side of [-1, 0, 1]) {
      rod(point(tower, 0, side*arm(h), h * 0.86), point(tower, 0, side*arm(h), h * 0.81), 0.04);
    }
  }
  for (const [a, b, start, end] of tile.w) {
    const from = map.towers[a], to = map.towers[b];
    const dx = to[0] - from[0], dy = to[1] - from[1], length = Math.hypot(dx, dy);
    const sag = Math.min(14, length * 0.034), divisions = Math.max(1, Math.ceil(length * (end - start) / 9));
    const attachment = (tower: Tower, side: number) => {
      const h = tower[3], angle = tower[4];
      const sign = Math.cos(angle)*dx + Math.sin(angle)*dy >= 0 ? 1 : -1;
      return point(tower, 0, sign * side * arm(h), h * 0.81);
    };
    for (const side of [-1, 0, 1]) {
      const p = attachment(from, side), q = attachment(to, side);
      const at = (t: number): Vec => [p[0] + (q[0]-p[0])*t, p[1] + (q[1]-p[1])*t - 4*sag*t*(1-t), p[2] + (q[2]-p[2])*t];
      let prev = at(start);
      for (let k = 1; k <= divisions; k++) {
        const next = at(start + (end - start) * k / divisions);
        rod(prev, next, 0.033);
        prev = next;
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
  geometry.setIndex(index);
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry, new THREE.MeshLambertMaterial({ color: '#767c7c' }));
  mesh.name = 'transmission';
  mesh.receiveShadow = true;
  return mesh;
}
