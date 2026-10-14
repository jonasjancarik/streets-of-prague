import * as THREE from 'three';
import { send } from './gpu.ts';
import { treePageFactory, OUTLINE, type TreeInstances } from './map/vegetation.ts';

export const TREE_PAGE_CAPACITY = [1200, 128, 128] as const;
export type TreeKind = 0 | 1 | 2; // broadleaf, shrub, conifer
const OUTLINE_ATTRIBUTES = ['outlineA', 'outlineB'] as const; // (OUTLINE = 8: four in each)
type Page = { mesh: THREE.InstancedMesh; kind: TreeKind; owner: string | null };

// Every page belongs to at most one tile. It keeps its mesh, attributes and shader
// binding when that tile leaves; only the used ranges and bounds change on reuse.
export class TreePool {
  readonly group = new THREE.Group();
  readonly pages: Page[] = [];
  readonly leases = new Map<string, Page[]>();
  readonly growth = [0, 0, 0];
  private readonly factory = treePageFactory();
  private readonly capacity: readonly [number, number, number];
  private disposed = false;
  private prepared = false;

  constructor(scene: THREE.Scene, capacity: number | readonly [number, number, number] = TREE_PAGE_CAPACITY) {
    const sizes = typeof capacity === 'number' ? [capacity, capacity, capacity] as const : capacity;
    if (sizes.some((n) => !Number.isInteger(n) || n < 1)) throw new Error('Invalid tree page capacity');
    this.capacity = sizes;
    this.group.name = 'Retained tree pages';
    this.group.matrixAutoUpdate = false;
    this.group.updateMatrix();
    this.group.updateMatrixWorld(true);
    scene.add(this.group);
  }

  private create(kind: TreeKind, overflow: boolean) {
    const mesh = this.factory.create(kind, this.capacity[kind]);
    const page: Page = { mesh, kind, owner: null };
    this.pages.push(page);
    this.group.add(mesh);
    // These matrices already contain world coordinates, so the persistent parent
    // and its children must remain at the identity transform.
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    mesh.updateMatrixWorld(true);
    if (overflow && this.prepared) this.growth[kind]++;
    return page;
  }

  // Allocate a finite total page envelope at startup. During compileAsync a single harmless
  // instance makes each page's actual shader variant visible; restore it afterward.
  prepare(reserve: readonly [number, number, number]) {
    if (this.disposed) throw new Error('Tree pool disposed');
    const prepared: Page[] = [];
    for (const kind of [0, 1, 2] as const) {
      const free = this.pages.filter((p) => p.kind === kind && p.owner === null);
      const total = this.pages.filter((p) => p.kind === kind).length;
      for (let i = total; i < reserve[kind]; i++) free.push(this.create(kind, false));
      prepared.push(...free);
    }
    // The already-leased pages may lie outside the starting camera. Compile them
    // too, so driving toward an initially off-screen tile does not build its shader.
    const culling = this.pages.map((page) => [page, page.mesh.frustumCulled] as const);
    for (const [page] of culling) page.mesh.frustumCulled = false;
    const identity = new THREE.Matrix4();
    for (const page of prepared) {
      const mesh = page.mesh;
      mesh.setMatrixAt(0, identity);
      mesh.instanceColor!.setXYZ(0, 1, 1, 1);
      (mesh.geometry.getAttribute('yearly') as THREE.InstancedBufferAttribute).setX(0, 0);
      for (const name of OUTLINE_ATTRIBUTES) (mesh.geometry.getAttribute(name) as THREE.InstancedBufferAttribute).setXYZW(0, 1, 1, 1, 1);
      mesh.count = 1;
      mesh.visible = true;
      send(mesh.instanceMatrix, 1);
      send(mesh.instanceColor!, 1);
      send(mesh.geometry.getAttribute('yearly') as THREE.InstancedBufferAttribute, 1);
      for (const name of OUTLINE_ATTRIBUTES) send(mesh.geometry.getAttribute(name) as THREE.InstancedBufferAttribute, 1);
    }
    this.prepared = true;
    return () => {
      for (const page of prepared) {
        page.mesh.count = 0;
        page.mesh.visible = false;
      }
      for (const [page, wasCulled] of culling) page.mesh.frustumCulled = wasCulled;
    };
  }

  add(tileKey: string, instances: TreeInstances) {
    if (this.disposed) throw new Error('Tree pool disposed');
    if (this.leases.has(tileKey)) return this.leases.get(tileKey)!;
    const { matrices, colours, yearly, outlines, count, shrubs, conifers } = instances;
    if (count < 0 || shrubs < 0 || conifers < 0 || shrubs + conifers > count ||
        matrices.length !== count * 16 || colours.length !== count * 3 || yearly.length !== count || outlines.length !== count * OUTLINE) {
      throw new Error(`Invalid tree instances for ${tileKey}`);
    }
    const broadleaf = count - shrubs - conifers;
    const parts: [TreeKind, number, number][] = [
      [0, 0, broadleaf], [1, broadleaf, broadleaf + shrubs], [2, broadleaf + shrubs, count],
    ];
    const acquired: Page[] = [];
    try {
      for (const [kind, first, end] of parts) for (let from = first; from < end; from += this.capacity[kind]) {
        const n = Math.min(this.capacity[kind], end - from);
        const page = this.pages.find((p) => p.kind === kind && p.owner === null) ?? this.create(kind, true);
        page.owner = tileKey;
        acquired.push(page);
        const mesh = page.mesh;
        (mesh.instanceMatrix.array as Float32Array).set(matrices.subarray(from * 16, (from + n) * 16));
        (mesh.instanceColor!.array as Float32Array).set(colours.subarray(from * 3, (from + n) * 3));
        (mesh.geometry.getAttribute('yearly').array as Float32Array).set(yearly.subarray(from, from + n));
        const [a, b] = OUTLINE_ATTRIBUTES.map((name) => mesh.geometry.getAttribute(name).array as Float32Array);
        for (let k = 0; k < n; k++) {
          const o = (from + k) * OUTLINE;
          a.set(outlines.subarray(o, o + 4), k * 4);
          b.set(outlines.subarray(o + 4, o + 8), k * 4);
        }
        mesh.count = n;
        mesh.computeBoundingBox();
        mesh.computeBoundingSphere();
        send(mesh.instanceMatrix, n);
        send(mesh.instanceColor!, n);
        send(mesh.geometry.getAttribute('yearly') as THREE.InstancedBufferAttribute, n);
        for (const name of OUTLINE_ATTRIBUTES) send(mesh.geometry.getAttribute(name) as THREE.InstancedBufferAttribute, n);
        mesh.visible = true;
      }
      this.leases.set(tileKey, acquired);
      return acquired;
    } catch (error) {
      for (const page of acquired) this.release(page);
      throw error;
    }
  }

  private release(page: Page) {
    page.owner = null;
    page.mesh.count = 0;
    page.mesh.visible = false;
    page.mesh.boundingBox = null;
    page.mesh.boundingSphere = null;
  }

  remove(tileKey: string) {
    const pages = this.leases.get(tileKey);
    if (!pages) return;
    for (const page of pages) this.release(page);
    this.leases.delete(tileKey);
  }

  stats() {
    const active = [0, 0, 0], free = [0, 0, 0], trees = [0, 0, 0];
    for (const page of this.pages) {
      if (page.owner === null) free[page.kind]++;
      else { active[page.kind]++; trees[page.kind] += page.mesh.count; }
    }
    return { capacity: [...this.capacity], active, free, trees, growth: [...this.growth],
      matrixColourEvergreenBytes: this.pages.reduce((n, p) => n + this.capacity[p.kind] * (16 + 3 + 1 + OUTLINE) * 4, 0) };
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.group.removeFromParent();
    for (const page of this.pages) {
      page.mesh.geometry.dispose();
      page.mesh.dispose();
    }
    this.factory.dispose();
    this.pages.length = 0;
    this.leases.clear();
  }
}
