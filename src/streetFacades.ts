import * as THREE from 'three';
import type { TileWorkers } from './tileWorkers.ts';
import type { FacadeGeometry } from './map/streetFacade.ts';
import { FACADE_ON, STREET_FACADE } from './facades.ts';
import type { StreetPlates } from './streetPlates.ts';
import { mirrored } from './mirror.ts';
import { STREET_QUALITY } from './streetQuality.ts';
import { MappedFrontages } from './mappedFrontages.ts';

// How far off walls get their depth, and how many of the nearest do, are the tier's
// (STREET_QUALITY.wallReach and walls); one that has it keeps it 8 m further.
interface Source { base: THREE.Mesh; groups: Uint32Array; box: readonly number[]; walls?: Wall[]; index?: THREE.BufferAttribute }
interface Wall { src: Source; tris: Uint32Array; x0: number; x1: number; z0: number; z1: number; y0: number; y1: number; nx: number; nz: number; mesh?: THREE.Mesh; flights?: Flight[]; pending?: boolean; cancel?: () => void; empty?: boolean; retry?: number }
// The steps up to a raised doorway (FacadeGeometry.steps) in the game's x and y: from the
// foot at a, along the wall to b and out by o; the key of each cell of FLIGHT_CELL it
// touches.
interface Flight { ax: number; ay: number; bx: number; by: number; ox: number; oy: number; cells: number[] }
const FLIGHT_CELL = 2; // m
const flightKey = (cx: number, cy: number) => (cx + 32768) * 65536 + cy + 32768;
// The ground (game x, y), NaN where no tile is loaded.
type GroundAt = (x: number, y: number) => number;
const material = new THREE.MeshLambertMaterial({ vertexColors: true });
material.customProgramCacheKey = () => 'street-facade';
export { material as streetFacadeMaterial };
// The shade on the pavement along a wall's foot (buildStreetWall): black, as dark as each corner says.
const footShade = new THREE.MeshBasicMaterial({ color: 0, transparent: true, vertexColors: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, side: THREE.DoubleSide });

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
    src.index = new THREE.BufferAttribute(ids, 1);
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
  private budget = '';
  private retryAt = Infinity;
  private scene: THREE.Scene;
  private workers: TileWorkers;
  private frontages: MappedFrontages;
  private groundAt: GroundAt;
  private flights = new Map<number, Flight[]>();
  // `shops`: the area's shops.json, which says which bays are shops (none without it).
  constructor(scene: THREE.Scene, workers: TileWorkers, shops?: string, groundAt: GroundAt = () => NaN) {
    this.scene = scene; this.workers = workers; this.groundAt = groundAt;
    this.frontages = new MappedFrontages(shops);
    // Walls queued while the shops were still on their way go out once they're here.
    void this.frontages.ready.then(() => this.pump());
  }
  // Whether (x, y) is on the steps up to a doorway of a wall drawn close up: they stop
  // cars as the wall does (World.cellAt).
  stepAt(x: number, y: number) {
    const list = this.flights.get(flightKey(Math.floor(x / FLIGHT_CELL), Math.floor(y / FLIGHT_CELL)));
    if (list) for (const f of list) {
      const px = x - f.ax, py = y - f.ay, ux = f.bx - f.ax, uy = f.by - f.ay;
      const along = (px * ux + py * uy) / (ux * ux + uy * uy), out = (px * f.ox + py * f.oy) / (f.ox * f.ox + f.oy * f.oy);
      if (along >= 0 && along <= 1 && out >= 0 && out <= 1) return true;
    }
    return false;
  }
  // A wall is measured against the ground of the tile its building is in (facadeCoords in
  // the tile worker), and that ground stops at the tile's edge: the edge's heights carry on
  // level beyond it. A building across the edge had its wall's foot, and the steps to its
  // doors with it, up to a metre above the pavement in front, and the plain wall below the
  // foot showing as a pale band along the pavement (Vinohradská, November 2026). Here the
  // world's ground covers the tiles round it as well: the wall is measured again before it
  // is drawn close up, and its building's own model (the same facade coordinates) moves with it.
  private refoot(w: Wall) {
    const at = w.src.base.geometry.attributes, p = at.position, f = at.facade as THREE.BufferAttribute;
    let moved = false;
    for (const t of w.tris) {
      let ground = Infinity;
      for (let v = t * 3; v < t * 3 + 3; v++) ground = Math.min(ground, this.groundAt(p.getX(v), -p.getZ(v)));
      if (!Number.isFinite(ground)) continue;
      // The ground the worker used: the same for the triangle's three corners.
      const shift = p.getY(t * 3) - f.getY(t * 3) - ground;
      if (!(Math.abs(shift) > .02)) continue;
      for (let v = t * 3; v < t * 3 + 3; v++) f.setY(v, f.getY(v) + shift);
      f.addUpdateRange(t * 12, 12);
      moved = true;
    }
    if (moved) f.needsUpdate = true;
  }
  private addFlights(w: Wall, steps: Float32Array) {
    w.flights = [];
    for (let i = 0; i + 8 <= steps.length; i += 8) {
      const f: Flight = { ax: steps[i], ay: -steps[i + 1], bx: steps[i + 2], by: -steps[i + 3], ox: steps[i + 4], oy: -steps[i + 5], cells: [] };
      const xs = [f.ax, f.bx, f.ax + f.ox, f.bx + f.ox], ys = [f.ay, f.by, f.ay + f.oy, f.by + f.oy];
      for (let cx = Math.floor(Math.min(...xs) / FLIGHT_CELL); cx <= Math.floor(Math.max(...xs) / FLIGHT_CELL); cx++)
        for (let cy = Math.floor(Math.min(...ys) / FLIGHT_CELL); cy <= Math.floor(Math.max(...ys) / FLIGHT_CELL); cy++) {
          const k = flightKey(cx, cy), list = this.flights.get(k);
          if (list) list.push(f); else this.flights.set(k, [f]);
          f.cells.push(k);
        }
      w.flights.push(f);
    }
  }
  private dropFlights(w: Wall) {
    for (const f of w.flights ?? []) for (const k of f.cells) {
      const list = this.flights.get(k), i = list ? list.indexOf(f) : -1;
      if (list && i >= 0) { list.splice(i, 1); if (!list.length) this.flights.delete(k); }
    }
    w.flights = undefined;
  }
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
    this.dropFlights(w);
    mask(w, false); this.scene.remove(w.mesh); w.mesh.dispose(); w.mesh.geometry.dispose(); for (const child of w.mesh.children) (child as THREE.Mesh).geometry?.dispose(); w.mesh = undefined; this.live.delete(w);
  }
  update(street: boolean, x: number, y: number, z: number, finishesReady = true) {
    const reach = STREET_QUALITY.wallReach, limit = STREET_QUALITY.walls, keep = reach + 8, budget = reach + '/' + limit;
    const layout = street && FACADE_ON.value > 0, active = layout && limit > 0 && finishesReady;
    STREET_FACADE.value = layout ? 1 : 0;
    if (!active && !this.active) return;
    if (!this.dirty && this.budget === budget && performance.now() < this.retryAt && this.active === active && Math.hypot(this.last.x - x, this.last.y - y, this.last.z - z) < 3) return;
    this.dirty = false; this.active = active; this.budget = budget; this.retryAt = Infinity; this.last.set(x, y, z);
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
    // (A wall built before the shops arrived would keep its made-up shopfronts.)
    while (this.frontages.settled && this.running < 2 && this.queue.length) {
      const w = this.queue.shift()!;
      if (!this.wanted.has(w) || w.pending || w.mesh) continue;
      w.pending = true; this.running++;
      this.refoot(w);
      const wall = copyWall(w);
      const data = { ...wall, shops:this.frontages.onWall(w,wall.position,wall.facade) };
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
    if (data.footShade.length) {
      const n = data.footShade.length / 4, at = new Float32Array(n * 3), dark = new Float32Array(n * 4);
      for (let i = 0; i < n; i++) { at.set(data.footShade.subarray(i * 4, i * 4 + 3), i * 3); dark[i * 4 + 3] = data.footShade[i * 4 + 3]; }
      const shade = new THREE.BufferGeometry();
      shade.setAttribute('position', new THREE.BufferAttribute(at, 3)); shade.setAttribute('color', new THREE.BufferAttribute(dark, 4));
      const strip = new THREE.Mesh(shade, footShade); strip.name = 'Shade at the wall foot'; strip.matrixAutoUpdate = false; strip.renderOrder = 2;
      mesh.add(strip);
    }
    this.scene.add(mesh);
    this.addFlights(w, data.steps);
    this.plates?.add(mesh, data.plateMounts, w.nx, w.nz);
    mask(w, true); w.mesh = mesh; this.live.add(w);
  }
}
