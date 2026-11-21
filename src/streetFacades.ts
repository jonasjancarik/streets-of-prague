import * as THREE from 'three';
import type { Tier } from './graphics.ts';
import type { TileWorkers } from './tileWorkers.ts';
import type { FacadeGeometry } from './map/streetFacade.ts';
import { FACADE_ON, STREET_FACADE } from './facades.ts';
import type { StreetPlates } from './streetPlates.ts';
import { mirrored } from './mirror.ts';

const budgets = { lowest: [0, 0], low: [20, 8], medium: [27, 12], high: [34, 18], ultra: [40, 24] } as const;
interface Source { base: THREE.Mesh; groups: Uint32Array; box: readonly number[]; walls?: Wall[]; index?: THREE.BufferAttribute }
interface Wall { src: Source; tris: Uint32Array; x0: number; x1: number; z0: number; z1: number; y0: number; y1: number; nx: number; nz: number; mesh?: THREE.Mesh; pending?: boolean; cancel?: () => void; empty?: boolean; retry?: number }
const material = new THREE.MeshLambertMaterial({ vertexColors: true });
material.customProgramCacheKey = () => 'street-facade';
export { material as streetFacadeMaterial };

function ranges(src: Source) {
  const walls: Wall[] = [], p = src.base.geometry.attributes.position, n = src.base.geometry.attributes.normal;
  for (let at = 0; at < src.groups.length;) {
    const len = src.groups[at++], tris = src.groups.subarray(at, at + len); at += len;
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const t of tris) for (let j = t * 3; j < t * 3 + 3; j++) {
      x0 = Math.min(x0, p.getX(j)); x1 = Math.max(x1, p.getX(j)); z0 = Math.min(z0, p.getZ(j)); z1 = Math.max(z1, p.getZ(j));
      y0 = Math.min(y0, p.getY(j)); y1 = Math.max(y1, p.getY(j));
    }
    if (y1 - y0 < 2) continue;
    walls.push({ src, tris, x0, x1, z0, z1, y0, y1, nx: n.getX(tris[0] * 3), nz: n.getZ(tris[0] * 3) });
  }
  return walls;
}

function copyWall(w: Wall) {
  const at = w.src.base.geometry.attributes;
  function copy(name: string, size: number) {
    const src = at[name].array as Float32Array, out = new Float32Array(w.tris.length * size * 3);
    w.tris.forEach((t, i) => out.set(src.subarray(t * 3 * size, (t + 1) * 3 * size), i * 3 * size));
    return out;
  }
  return { position: copy('position', 3), color: copy('color', 3), facade: copy('facade', 4), sky: copy('sky', 1) };
}
function mask(w: Wall, hide: boolean) {
  const src = w.src, geom = src.base.geometry;
  if (!src.index) {
    const n = geom.attributes.position.count;
    const ids = n > 65535 ? new Uint32Array(n) : new Uint16Array(n);
    for (let i = 0; i < n; i++)ids[i] = i;
    src.index = new THREE.BufferAttribute(ids, 1).setUsage(THREE.DynamicDrawUsage);
    geom.setIndex(src.index);
  }
  const index = src.index, ids = index.array;
  for (const t of w.tris) {
    const i = t * 3; ids[i + 1] = hide ? i : i + 1; ids[i + 2] = hide ? i : i + 2;
    index.addUpdateRange(i + 1, 2);
  }
  index.needsUpdate = true;
}

export class StreetFacades {
  plates?: StreetPlates;
  private sources = new Map<THREE.Mesh, Source>();
  private wanted = new Set<Wall>();
  private live = new Set<Wall>();
  private queue: Wall[] = [];
  private running = 0;
  private dirty = true;
  private active = false;
  private last = new THREE.Vector3(Infinity, Infinity, Infinity);
  private tier: Tier = 'high';
  private retryAt = Infinity;
  private scene: THREE.Scene;
  private workers: TileWorkers;
  constructor(scene: THREE.Scene, workers: TileWorkers) { this.scene = scene; this.workers = workers; }
  register(base: THREE.Mesh, groups: Uint32Array | undefined, box: readonly number[]) {
    if (!groups?.length) return;
    this.sources.set(base, { base, groups, box }); this.dirty = true;
  }
  drop(base: THREE.Mesh) {
    const src = this.sources.get(base); if (!src) return;
    for (const w of src.walls || []) { this.wanted.delete(w); w.cancel?.(); this.remove(w); }
    this.sources.delete(base); this.dirty = true;
  }
  private remove(w: Wall) {
    if (!w.mesh) return;
    this.plates?.remove(w.mesh);
    mask(w, false); this.scene.remove(w.mesh); w.mesh.dispose(); w.mesh.geometry.dispose(); w.mesh = undefined; this.live.delete(w);
  }
  update(street: boolean, x: number, y: number, z: number, tier: Tier = 'high', finishesReady = true) {
    const [reach, limit] = budgets[tier], keep = reach + 8;
    const layout = street && FACADE_ON.value > 0, active = layout && limit > 0 && finishesReady;
    STREET_FACADE.value = layout ? 1 : 0;
    if (!active && !this.active) return;
    if (!this.dirty && this.tier === tier && performance.now() < this.retryAt && this.active === active && Math.hypot(this.last.x - x, this.last.y - y, this.last.z - z) < 3) return;
    this.dirty = false; this.active = active; this.tier = tier; this.retryAt = Infinity; this.last.set(x, y, z);
    const near: { w: Wall; distance: number }[] = [];
    if (active) for (const src of this.sources.values()) {
      const [x0, y0, x1, y1] = src.box;
      if (x < x0 - keep || x > x1 + keep || -z < y0 - keep || -z > y1 + keep) continue;
      for (const w of src.walls ??= ranges(src)) {
        if (w.empty) continue;
        const dx = Math.max(w.x0 - x, 0, x - w.x1), dz = Math.max(w.z0 - z, 0, z - w.z1);
        const facing = (x - (w.x0 + w.x1) / 2) * w.nx + (z - (w.z0 + w.z1) / 2) * w.nz;
        const dist = Math.hypot(Math.max(Math.hypot(dx, dz), facing), Math.max(w.y0 - y, 0, y - w.y1));
        if (facing < -.3 || dist > (w.mesh ? keep : reach)) continue;
        if (w.retry && w.retry > performance.now()) { this.retryAt = Math.min(this.retryAt, w.retry); continue; }
        near.push({ w, distance: dist - (w.mesh ? 3 : 0) });
      }
    }
    near.sort((a, b) => a.distance - b.distance);
    const wanted = new Set(near.slice(0, limit).map(p => p.w));
    for (const w of this.wanted) if (!wanted.has(w)) w.cancel?.();
    this.wanted = wanted;
    for (const w of this.live) if (!this.wanted.has(w)) this.remove(w);
    this.queue = [...this.wanted].filter(w => !w.mesh && !w.pending && (!w.retry || w.retry < performance.now()));
    this.pump();
  }
  private pump() {
    while (this.running < 2 && this.queue.length) {
      const w = this.queue.shift()!;
      if (!this.wanted.has(w) || w.pending || w.mesh) continue;
      w.pending = true; this.running++;
      const data = copyWall(w);
      const job = this.workers.submit('streetFacade', data, Object.values(data).map(a => a.buffer), 'optional');
      let cancelled = false;
      w.cancel = () => { cancelled = true; job.cancel(); };
      job.promise.then(result => {
        if (cancelled || !this.wanted.has(w)) return;
        if (!result) { w.empty = true; this.dirty = true; return; }
        this.show(w, result);
      }).catch(() => {
        if (!cancelled && this.wanted.has(w)) { w.retry = performance.now() + 5000; this.retryAt = Math.min(this.retryAt, w.retry); }
      }).finally(() => { w.pending = false; w.cancel = undefined; this.running--; if (cancelled && this.wanted.has(w)) this.dirty = true; this.pump(); });
    }
  }
  private show(w: Wall, data: FacadeGeometry) {
    const g = new THREE.BufferGeometry();
    for (const [k, size] of Object.entries({ position: 3, normal: 3, color: 3, facade: 4, sky: 1, detail: 4 }))
      g.setAttribute(k, new THREE.BufferAttribute(data[k as keyof FacadeGeometry], size));
    g.computeBoundingSphere();
    const mesh = mirrored(new THREE.Mesh(g, material)); mesh.castShadow = mesh.receiveShadow = true;
    mesh.name = 'Street façade'; mesh.userData.streetFacade = true; mesh.matrixAutoUpdate = false;
    this.scene.add(mesh);
    this.plates?.add(mesh, data.plateMounts, w.nx, w.nz);
    mask(w, true); w.mesh = mesh; this.live.add(w);
  }
}
