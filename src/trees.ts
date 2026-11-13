import * as THREE from 'three';
import { send } from './gpu.ts';
import { treePageFactory, OUTLINE, type TreeInstances } from './map/vegetation.ts';
import { streetTreeGeometry, canopyGeometry, coniferGeometry } from './map/streetTree.ts';

export const TREE_PAGE_CAPACITY = [1200, 128, 128, 256] as const;
export type TreeKind = 0 | 1 | 2 | 3; // broadleaf, shrub, conifer, big broadleaf (vegetation.ts, BIG_CROWN)
type PerKind = readonly [number, number, number, number];
const KINDS = [0, 1, 2, 3] as const;
const OUTLINE_ATTRIBUTES = ['outlineA', 'outlineB'] as const; // (OUTLINE = 8: four in each)
type Page = { mesh: THREE.InstancedMesh; kind: TreeKind; owner: string | null; street?: THREE.InstancedMesh; canopy?: THREE.InstancedMesh };

// The trees seen from the street (map/streetTree.ts): their material comes from the WebGPU
// side (webgpu/streetTrees.ts), which also says when their pictures have loaded.
let streetMaterial: (() => THREE.Material) | null = null, streetReady: { value: boolean } = { value: false };
export const setStreetTreeMaterial = (make: () => THREE.Material, ready: { value: boolean }) => { streetMaterial = make; streetReady = ready; };
// How near a page of trees has to come (the nearest point of its sphere, m) to be drawn as
// street trees; beyond, the crowns made for the view from above do.
const STREET_REACH = 150;
// (For measuring: false keeps the top-down crowns in first person too.)
export const STREET_TREES = { value: true };
// Whether the crowns seen from above get their sprays of leaves (graphics.ts: Ultra).
export const CANOPY_LEAVES = { value: false };
// 1 while they are drawn (from above, on Ultra, their pictures loaded): the tufts under them
// are then the crown's shaded inside, and are drawn darker (webgpu/trees.ts).
export const CANOPY_SHOWN = { value: 0 };

// Every page belongs to at most one tile. It keeps its mesh, attributes and shader
// binding when that tile leaves; only the used ranges and bounds change on reuse.
export class TreePool {
  readonly group = new THREE.Group();
  readonly pages: Page[] = [];
  readonly leases = new Map<string, Page[]>();
  readonly growth = [0, 0, 0, 0];
  private readonly factory = treePageFactory();
  private readonly capacity: PerKind;
  private disposed = false;
  private prepared = false;

  constructor(scene: THREE.Scene, capacity: number | PerKind = TREE_PAGE_CAPACITY) {
    const sizes = typeof capacity === 'number' ? [capacity, capacity, capacity, capacity] as const : capacity;
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
  prepare(reserve: PerKind) {
    if (this.disposed) throw new Error('Tree pool disposed');
    const prepared: Page[] = [];
    for (const kind of KINDS) {
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
    const { matrices, colours, yearly, outlines, count, big, shrubs, conifers } = instances;
    if (count < 0 || big < 0 || shrubs < 0 || conifers < 0 || big + shrubs + conifers > count ||
        matrices.length !== count * 16 || colours.length !== count * 3 || yearly.length !== count || outlines.length !== count * OUTLINE) {
      throw new Error(`Invalid tree instances for ${tileKey}`);
    }
    const broadleaf = count - big - shrubs - conifers, small = broadleaf + big;
    const parts: [TreeKind, number, number][] = [
      [0, 0, broadleaf], [3, broadleaf, small], [1, small, small + shrubs], [2, small + shrubs, count],
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
    if (page.street) { page.street.visible = false; page.street.count = 0; }
    if (page.canopy) { page.canopy.visible = false; page.canopy.count = 0; }
  }

  // First person: the broadleaf trees near (x, z) are drawn as street trees, each page's
  // second mesh over the same instances (made when first wanted); `on` false puts every
  // page back to its top-down crowns.
  private streetShapes: THREE.BufferGeometry[] | null = null;
  private streetMade: THREE.Material | null = null;
  private streetOn = false;
  street(on: boolean, x = 0, z = 0) {
    on &&= STREET_TREES.value;
    if (!on && !this.streetOn) return;
    this.streetOn = on;
    if (on && !this.streetMade && streetMaterial) {
      this.streetMade = streetMaterial();
    }
    if (on && !this.streetShapes) this.streetShapes = [streetTreeGeometry(5, 9, 3), streetTreeGeometry(9, 13, 3)];
    const ready = on && !!this.streetMade && streetReady.value;
    for (const page of this.pages) {
      const mesh = page.mesh, used = page.owner !== null && mesh.count > 0;
      if (page.kind !== 0 && page.kind !== 3) continue;
      const sphere = mesh.boundingSphere;
      const near = ready && used && !!sphere && Math.hypot(sphere.center.x - x, sphere.center.z - z) - sphere.radius < STREET_REACH;
      if (near && !page.street) page.street = this.streetMesh(page);
      if (page.street) {
        page.street.visible = near;
        if (near) { page.street.count = mesh.count; page.street.boundingSphere = mesh.boundingSphere; page.street.boundingBox = mesh.boundingBox; }
      }
      mesh.visible = used && !near;
    }
  }

  private streetMesh(page: Page, shape = this.streetShapes![page.kind === 3 ? 1 : 0], shadows = true) {
    const from = page.mesh;
    const geom = new THREE.BufferGeometry();
    geom.setIndex(shape.index);
    for (const [name, attr] of Object.entries(shape.attributes)) geom.setAttribute(name, attr);
    // The instances are the page's own: one set of numbers for both meshes.
    for (const name of ['yearly', ...OUTLINE_ATTRIBUTES]) geom.setAttribute(name, from.geometry.getAttribute(name));
    const mesh = new THREE.InstancedMesh(geom, this.streetMade!, this.capacity[page.kind]);
    mesh.instanceMatrix = from.instanceMatrix;
    mesh.instanceColor = from.instanceColor;
    mesh.userData.sharedMatrices = true; // (see configureRenderer in webgpu.ts)
    mesh.count = from.count;
    mesh.castShadow = shadows;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    this.group.add(mesh);
    mesh.updateMatrixWorld(true);
    return mesh;
  }

  // From above (Ultra): sprays of leaves laid over every broadleaf crown and shrub in view
  // (canopyGeometry), another mesh over the page's instances; the tufts stay under them.
  // `street`: the view is from the street, where the trees have their own models and only
  // the shrubs get sprays.
  private canopyShapes: THREE.BufferGeometry[] | null = null;
  private canopyOn = false;
  canopy(on: boolean, street = false) {
    on &&= CANOPY_LEAVES.value;
    // (From the street the shrubs and conifers have theirs at every tier, as the trees have their own models there.)
    const shrubs = (on || (street && STREET_TREES.value)) && !!streetMaterial;
    if (!shrubs && !this.canopyOn) { CANOPY_SHOWN.value = 0; return; }
    this.canopyOn = shrubs;
    if (shrubs && !this.streetMade && streetMaterial) this.streetMade = streetMaterial();
    if (shrubs && !this.canopyShapes) this.canopyShapes = [canopyGeometry(21, [1, 6, 11, 15]), canopyGeometry(23, [2, 8, 14, 20, 24]), canopyGeometry(27, [1, 5, 9], [12, 12, 12, 10]), coniferGeometry(31)];
    const ready = !!this.streetMade && streetReady.value;
    CANOPY_SHOWN.value = ready && on && !street ? 1 : 0;
    for (const page of this.pages) {
      // (Shrubs and conifers keep theirs from the street; a broadleaf tree has its own model there.)
      const mesh = page.mesh, show = ready && (page.kind === 1 || page.kind === 2 ? shrubs : on && !street) && page.owner !== null && mesh.count > 0;
      if (show && !page.canopy) page.canopy = this.streetMesh(page, this.canopyShapes![[0, 2, 3, 1][page.kind]], false);
      if (page.canopy) {
        page.canopy.visible = show;
        if (show) { page.canopy.count = mesh.count; page.canopy.boundingSphere = mesh.boundingSphere; page.canopy.boundingBox = mesh.boundingBox; }
      }
      // (From the street a shrub is its sprays alone: its tufts' rim showed under them as a dark faceted skirt.)
      if (page.kind === 1) {
        mesh.visible = page.owner !== null && mesh.count > 0 && !(street && show);
        if (page.canopy) page.canopy.castShadow = street;
      }
    }
  }

  remove(tileKey: string) {
    const pages = this.leases.get(tileKey);
    if (!pages) return;
    for (const page of pages) this.release(page);
    this.leases.delete(tileKey);
  }

  stats() {
    const active = [0, 0, 0, 0], free = [0, 0, 0, 0], trees = [0, 0, 0, 0];
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
      if (page.street) { page.street.geometry.dispose(); page.street.dispose(); }
      if (page.canopy) { page.canopy.geometry.dispose(); page.canopy.dispose(); }
    }
    this.streetMade?.dispose();
    for (const shape of [...(this.streetShapes ?? []), ...(this.canopyShapes ?? [])]) {
      for (const a of [shape.index, ...Object.values(shape.attributes)]) if (a) (a as { shared?: boolean }).shared = false;
      shape.dispose();
    }
    this.factory.dispose();
    this.pages.length = 0;
    this.leases.clear();
  }
}
