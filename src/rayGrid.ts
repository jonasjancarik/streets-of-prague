// Rays from a street to a mapped point inside a building (a shop, an address), and which
// street wall each one crosses on its way in. A ray, rather than the point alone, avoids
// the back of the building or the house across the street.
export interface WallBox { x0: number; x1: number; z0: number; z1: number; nx: number; nz: number }
interface Ray<T> { x: number; z: number; dx: number; dz: number; length: number; data: T }
export interface RayHit<T> { x: number; z: number; data: T }
const CELL = 64;

export class RayGrid<T> {
  private cells = new Map<string, Ray<T>[]>();
  private depth: number;
  // `depth`: how far behind the wall the point may lie (m).
  constructor(depth = 10) { this.depth = depth; }
  // From the street at (sx, sy) to the point (px, py), in the area's local metres (+y north).
  add(sx: number, sy: number, px: number, py: number, data: T) {
    if (![sx, sy, px, py].every(Number.isFinite)) return;
    // The game's z runs south.
    const dx = px - sx, dz = sy - py, length = Math.hypot(dx, dz);
    if (!(length > 0)) return;
    const ray: Ray<T> = { x: sx, z: -sy, dx: dx / length, dz: dz / length, length, data };
    const xs = [sx, px], zs = [-sy, -py];
    for (let cx = Math.floor(Math.min(...xs) / CELL); cx <= Math.floor(Math.max(...xs) / CELL); cx++)
      for (let cz = Math.floor(Math.min(...zs) / CELL); cz <= Math.floor(Math.max(...zs) / CELL); cz++) {
        const key = cx + ',' + cz, list = this.cells.get(key);
        if (list) list.push(ray); else this.cells.set(key, [ray]);
      }
  }
  // Where each ray that meets this wall from the street side crosses it (game x, z).
  hits(w: WallBox) {
    const out: RayHit<T>[] = [];
    const mx = (w.x0 + w.x1) / 2, mz = (w.z0 + w.z1) / 2;
    const seen = new Set<Ray<T>>();
    for (let cx = Math.floor((w.x0 - 20) / CELL); cx <= Math.floor((w.x1 + 20) / CELL); cx++)
      for (let cz = Math.floor((w.z0 - 20) / CELL); cz <= Math.floor((w.z1 + 20) / CELL); cz++) {
        for (const r of this.cells.get(cx + ',' + cz) ?? []) {
          if (seen.has(r)) continue;
          seen.add(r);
          if (r.x < w.x0 - 20 || r.x > w.x1 + 20 || r.z < w.z0 - 20 || r.z > w.z1 + 20) continue;
          const facing = r.dx * w.nx + r.dz * w.nz;
          if (facing > -.65) continue;
          const reach = ((mx - r.x) * w.nx + (mz - r.z) * w.nz) / facing;
          if (reach < 2 || reach > r.length + 3 || r.length - reach > this.depth) continue;
          const x = r.x + r.dx * reach, z = r.z + r.dz * reach;
          if (x < w.x0 - .15 || x > w.x1 + .15 || z < w.z0 - .15 || z > w.z1 + .15) continue;
          out.push({ x, z, data: r.data });
        }
      }
    return out;
  }
}
