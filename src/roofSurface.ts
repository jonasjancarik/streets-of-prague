import * as THREE from 'three';

// Distinct from the numbered transport levels in map tiles.
export const ROOFTOP = 10000;

// Bin upward-facing triangles in map coordinates. Use the same vertices as the
// rendered roofs, so ridges, courtyards and neighbouring houses keep their shape.
class RoofSurface {
  private bins = new Map<number, number[]>();
  constructor(private p: Float32Array, end: number) {
    for (let i = 0; i < end; i += 9) {
      const ax = p[i], bx = p[i + 3], cx = p[i + 6];
      const ay = -p[i + 2], by = -p[i + 5], cy = -p[i + 8];
      if ((bx - ax) * (cy - ay) - (by - ay) * (cx - ax) <= 1e-7) continue;
      for (let u = Math.floor(Math.min(ax, bx, cx) / 12); u <= Math.floor(Math.max(ax, bx, cx) / 12); u++) {
        for (let v = Math.floor(Math.min(ay, by, cy) / 12); v <= Math.floor(Math.max(ay, by, cy) / 12); v++) {
          const key = u * 65536 + v;
          const bin = this.bins.get(key);
          if (bin) bin.push(i); else this.bins.set(key, [i]);
        }
      }
    }
  }

  at(x: number, y: number) {
    let h = -Infinity;
    const bin = this.bins.get(Math.floor(x / 12) * 65536 + Math.floor(y / 12));
    if (!bin) return h;
    const p = this.p;
    for (const i of bin) {
      const dx = x - p[i], dy = y + p[i + 2];
      const ux = p[i + 3] - p[i], uy = p[i + 2] - p[i + 5];
      const vx = p[i + 6] - p[i], vy = p[i + 2] - p[i + 8];
      const det = ux * vy - uy * vx;
      if (Math.abs(det) < 1e-7) continue;
      const u = (dx * vy - dy * vx) / det, v = (ux * dy - uy * dx) / det;
      if (u >= 0 && v >= 0 && u + v <= 1) h = Math.max(h, p[i + 1] + u * (p[i + 4] - p[i + 1]) + v * (p[i + 7] - p[i + 1]));
    }
    return h;
  }
}

// Meshes can cross their home tile's edge. Check their world-space boxes before
// indexing any triangles. Landmark GLBs can have indexed, transformed meshes.
export function roofLookup(mesh: THREE.Mesh, vertices = Infinity) {
  let bounds: THREE.Box3 | undefined, surface: RoofSurface | undefined;
  return (x: number, y: number) => {
    const geometry = mesh.geometry;
    if (!bounds) {
      if (!geometry.boundingBox) geometry.computeBoundingBox();
      bounds = geometry.boundingBox!.clone().applyMatrix4(mesh.matrixWorld);
    }
    if (x < bounds.min.x || x > bounds.max.x || -y < bounds.min.z || -y > bounds.max.z) return -Infinity;
    if (!surface) {
      const positions = geometry.attributes.position;
      const n = Math.min(vertices, geometry.index?.count ?? positions.count);
      let p: Float32Array;
      if (!geometry.index && positions instanceof THREE.BufferAttribute && positions.array instanceof Float32Array
        && mesh.matrixWorld.equals(identity)) p = positions.array;
      else {
        p = new Float32Array(n * 3);
        const vertex = new THREE.Vector3();
        for (let i = 0; i < n; i++) vertex.fromBufferAttribute(positions, geometry.index?.getX(i) ?? i)
          .applyMatrix4(mesh.matrixWorld).toArray(p, i * 3);
      }
      surface = new RoofSurface(p, n * 3);
    }
    return surface.at(x, y);
  };
}
const identity = new THREE.Matrix4();
