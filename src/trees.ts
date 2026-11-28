import * as THREE from 'three';
import { STREET_QUALITY } from './streetQuality.ts';
import { inStreetCone } from './streetView.ts';
import { send } from './gpu.ts';
import { distantTreeCrown, treePageFactory, OUTLINE, type TreeInstances } from './map/vegetation.ts';
import { streetTreeGeometry, canopyGeometry, coniferGeometry } from './map/streetTree.ts';
import { StreetLitter, type LitterGround } from './streetLitter.ts';

export const TREE_PAGE_CAPACITY = [1200, 128, 128, 256] as const;
export type TreeKind = 0 | 1 | 2 | 3; // broadleaf, shrub, conifer, big broadleaf (vegetation.ts, BIG_CROWN)
type PerKind = readonly [number, number, number, number];
const KINDS = [0, 1, 2, 3] as const;
const OUTLINE_ATTRIBUTES = ['outlineA', 'outlineB'] as const; // (OUTLINE = 8: four in each)
type Source = { trees: TreeInstances; from: number; count: number };
type Selection = { mask: Uint8Array; x: number; z: number; individual: boolean; view: number };
type Page = {
  mesh: THREE.InstancedMesh; kind: TreeKind; owner: string | null;
  street?: THREE.InstancedMesh; canopy?: THREE.InstancedMesh;
  source?: Source; selection?: Selection; packed?: boolean; grown?: boolean;
};

// The ground uses ranks 1–200. Draw crowns after the other solid meshes so only
// foliage in front of them marks pixels for the player's car outline.
export const CROWN_STENCIL = 255;
function markCrown(mesh: THREE.InstancedMesh<THREE.BufferGeometry, THREE.Material>) {
  mesh.renderOrder = 1;
  Object.assign(mesh.material, {
    stencilWrite: true, stencilRef: CROWN_STENCIL, stencilZPass: THREE.ReplaceStencilOp,
  });
}

// The trees seen from the street (map/streetTree.ts): their material comes from the WebGPU
// side (webgpu/streetTrees.ts), which also says when their pictures have loaded.
let streetMaterial: (() => THREE.Material) | null = null, streetReady: { value: boolean } = { value: false };
export const setStreetTreeMaterial = (make: () => THREE.Material, ready: { value: boolean }) => { streetMaterial = make; streetReady = ready; };
// Metres from the eye to the tree crown. A tile's sphere only answers whether
// there might be a nearby tree in it.
const STREET_REACH = 150;
// (For measuring: false keeps the top-down crowns in first person too.)
export const STREET_TREES = { value: true, individual: true, farRims: true, directional: true };
// Whether crowns seen from above get their sprays of leaves (High and Ultra).
export const CANOPY_LEAVES = { value: false };
// 1 while they are drawn (from above, on Ultra, their pictures loaded): the tufts under them
// are then the crown's shaded inside, and are drawn darker (webgpu/trees.ts).
export const CANOPY_SHOWN = { value: 0 };

// Copy a contiguous run in its original order. The two outline attributes are
// the eight surveyed radii, packed together in the worker's source buffer.
function copyTrees(to: THREE.InstancedMesh, slot: number, trees: TreeInstances, from: number, count: number) {
  to.instanceMatrix.array.set(trees.matrices.subarray(from * 16, (from + count) * 16), slot * 16);
  to.instanceColor!.array.set(trees.colours.subarray(from * 3, (from + count) * 3), slot * 3);
  to.geometry.getAttribute('yearly').array.set(trees.yearly.subarray(from, from + count), slot);
  const a = to.geometry.getAttribute('outlineA').array, b = to.geometry.getAttribute('outlineB').array;
  for (let n = 0; n < count; n++) {
    const input = (from + n) * OUTLINE, output = (slot + n) * 4;
    for (let j = 0; j < 4; j++) {
      a[output + j] = trees.outlines[input + j]; b[output + j] = trees.outlines[input + 4 + j];
    }
  }
}

function uploadTrees(mesh: THREE.InstancedMesh, count: number) {
  mesh.count = count;
  send(mesh.instanceMatrix, count); send(mesh.instanceColor!, count);
  send(mesh.geometry.getAttribute('yearly') as THREE.InstancedBufferAttribute, count);
  for (const name of OUTLINE_ATTRIBUTES) send(mesh.geometry.getAttribute(name) as THREE.InstancedBufferAttribute, count);
}

// Every page belongs to at most one tile. It keeps its mesh, attributes and shader
// binding when that tile leaves; only the used ranges and bounds change on reuse.
export class TreePool {
  readonly group = new THREE.Group();
  readonly litter = new StreetLitter();
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
    this.group.add(this.litter.group);
  }

  private create(kind: TreeKind, overflow: boolean) {
    const mesh = this.factory.create(kind, this.capacity[kind]);
    markCrown(mesh);
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
        page.source = { trees: instances, from, count: n };
        copyTrees(mesh, 0, instances, from, n);
        uploadTrees(mesh, n);
        mesh.computeBoundingBox();
        mesh.computeBoundingSphere();
        mesh.visible = true;
      }
      this.leases.set(tileKey, acquired);
      this.litter.add(tileKey, instances);
      return acquired;
    } catch (error) {
      for (const page of acquired) this.release(page);
      throw error;
    }
  }

  // A tile's tree matrices changed in its instances (a tree snapped and falling,
  // treeFalls.ts): copied into its pages again, and the pages' bounds grown once to take a
  // tree lying where it fell.
  refresh(tileKey: string) {
    for (const page of this.leases.get(tileKey) ?? []) {
      const source = page.source;
      if (!source) continue;
      if (!page.grown) {
        page.grown = true;
        const s = page.mesh.boundingSphere;
        if (s) { s.radius += 16; if (page.street) page.street.boundingSphere = s; }
      }
      // (Close up, the street trees and the far crowns are sorted again next frame.)
      if (page.packed && page.selection) { page.selection.x = Infinity; continue; }
      copyTrees(page.mesh, 0, source.trees, source.from, source.count);
      uploadTrees(page.mesh, source.count);
    }
  }

  private release(page: Page) {
    page.owner = null;
    distantTreeCrown(page.mesh, false);
    page.source = undefined;
    page.packed = false;
    page.grown = false;
    if (page.selection) page.selection.x = Infinity;
    page.mesh.count = 0;
    page.mesh.visible = false;
    page.mesh.boundingBox = null;
    page.mesh.boundingSphere = null;
    if (page.street) { page.street.visible = false; page.street.count = 0; }
    if (page.canopy) { page.canopy.visible = false; page.canopy.count = 0; }
  }

  // First person: each leased page can hold nearby street trees and distant
  // crowns. The source arrays stay with the tile so returning overhead restores
  // the original batch, order and surveyed attributes.
  private streetShapes: THREE.BufferGeometry[] | null = null;
  private streetLods = new Map<number, THREE.BufferGeometry[]>();
  private streetMade: THREE.Material | null = null;
  private streetOn = false;
  private facing = new THREE.Vector3();
  private treeView = { active:false, x:0, z:0, half:0, sin:0, cos:0, revision:0 };

  private aimTrees(camera?: THREE.PerspectiveCamera) {
    const view=this.treeView;
    if (camera && STREET_TREES.directional && STREET_TREES.individual) {
      camera.getWorldDirection(this.facing);
      // At a steep pitch crowns above or below the player can fill the screen.
      // Use the complete circle there, and in the free camera and headset.
      if (Math.abs(this.facing.y)<.42) {
        const length=Math.hypot(this.facing.x,this.facing.z), x=this.facing.x/length, z=this.facing.z/length;
        const half=Math.min(Math.PI*.5,Math.atan(Math.tan(camera.fov*Math.PI/360)*camera.aspect)+.23);
        if (view.active && x*view.x+z*view.z>.986 && Math.abs(half-view.half)<.025) return;
        Object.assign(view,{active:true,x,z,half,sin:Math.sin(half),cos:Math.cos(half)});
        view.revision++; return;
      }
    }
    if (view.active) { view.active=false; view.revision++; }
  }

  street(on: boolean, x = 0, z = 0, camera?: THREE.PerspectiveCamera, ground?: LitterGround, revision = 0) {
    on &&= STREET_TREES.value;
    this.litter.street(on, x, -z, ground, revision);
    if (!on && !this.streetOn) return;
    this.streetOn = on;
    if (on && !this.streetMade && streetMaterial) {
      this.streetMade = streetMaterial();
    }
    const detail = STREET_QUALITY.treeWood;
    if (on && !this.streetLods.has(detail)) this.streetLods.set(detail, [streetTreeGeometry(5, 9, 3, detail), streetTreeGeometry(9, 13, 3, detail)]);
    if (on) this.streetShapes = this.streetLods.get(detail)!;
    const ready = on && !!this.streetMade && streetReady.value;
    this.aimTrees(ready ? camera : undefined);
    for (const page of this.pages) {
      if (page.kind !== 0 && page.kind !== 3) continue;
      distantTreeCrown(page.mesh, ready && !!page.source && STREET_TREES.individual && STREET_TREES.farRims);
      const sphere = page.mesh.boundingSphere;
      const range = STREET_REACH + (STREET_TREES.individual ? 8 : 0);
      if (!ready || !page.source || !sphere || Math.hypot(sphere.center.x - x, sphere.center.z - z) - sphere.radius >= range) {
        this.allCrowns(page);
        if (page.selection) page.selection.x = Infinity;
        continue;
      }
      this.selectStreetTrees(page, page.source, x, z);
      if (page.street?.visible) {
        const shape = this.streetShapes?.[page.kind === 3 ? 1 : 0];
        if (shape && page.street.geometry.index !== shape.index) {
          page.street.geometry.setIndex(shape.index);
          for (const [name, attr] of Object.entries(shape.attributes)) page.street.geometry.setAttribute(name, attr);
        }
      }
    }
  }

  private allCrowns(page: Page) {
    const source = page.source;
    if (source && page.packed) {
      copyTrees(page.mesh, 0, source.trees, source.from, source.count);
      uploadTrees(page.mesh, source.count);
      page.packed = false;
    }
    page.mesh.visible = !!source && source.count > 0;
    if (page.street) { page.street.visible = false; page.street.count = 0; }
  }

  private selectStreetTrees(page: Page, source: Source, x: number, z: number) {
    const pick = page.selection ??= { mask: new Uint8Array(this.capacity[page.kind]), x: Infinity, z: 0, individual: true, view: -1 };
    const individual = STREET_TREES.individual;
    const reuse = Number.isFinite(pick.x) && pick.individual === individual;
    const view=this.treeView;
    if (reuse && pick.view===view.revision && (pick.x - x) ** 2 + (pick.z - z) ** 2 < 36) return;
    pick.x = x; pick.z = z; pick.individual = individual;
    pick.view = view.revision;
    const matrices = source.trees.matrices;
    let near = 0, changed = !reuse;
    for (let i = 0; i < source.count; i++) {
      const at = (source.from + i) * 16;
      const dx = matrices[at + 12] - x, dz = matrices[at + 14] - z;
      const radius = Math.sqrt(Math.max(matrices[at] ** 2 + matrices[at + 2] ** 2, matrices[at + 8] ** 2 + matrices[at + 10] ** 2));
      const limit = STREET_REACH + radius + (reuse && pick.mask[i] ? 6 : 0);
      const d2=dx*dx+dz*dz;
      // Nearby off-screen boughs can cast into view. More distant trees behind
      // the camera still draw their ordinary surveyed crown and its shadow.
      const detailed = !view.active || d2 <= (58+radius)**2 ||
        inStreetCone(dx,dz,view.x,view.z,view.sin,view.cos,22+radius+(pick.mask[i]?6:0));
      const close = !individual || (d2 <= limit*limit && detailed) ? 1 : 0;
      if (pick.mask[i] !== close) changed = true;
      pick.mask[i] = close; near += close;
    }
    if (!changed) return;
    if (!near) { this.allCrowns(page); return; }
    const street = page.street ??= this.streetMesh(page, this.streetShapes![page.kind === 3 ? 1 : 0], true, true);
    let closeCount = 0, farCount = 0;
    for (let from = 0; from < source.count;) {
      let end = from + 1;
      while (end < source.count && pick.mask[end] === pick.mask[from]) end++;
      const n = end - from;
      if (pick.mask[from]) { copyTrees(street, closeCount, source.trees, source.from + from, n); closeCount += n; }
      else { copyTrees(page.mesh, farCount, source.trees, source.from + from, n); farCount += n; }
      from = end;
    }
    uploadTrees(street, closeCount); uploadTrees(page.mesh, farCount);
    page.packed = true;
    page.mesh.visible = farCount > 0; street.visible = true;
    // The canonical bounds include every tree in either batch, with the shader's
    // extra crown width and trunk height, and work for the sun's camera too.
    street.boundingSphere = page.mesh.boundingSphere; street.boundingBox = page.mesh.boundingBox;
  }

  private streetMesh(page: Page, shape = this.streetShapes![page.kind === 3 ? 1 : 0], shadows = true, ownInstances = false) {
    const from = page.mesh;
    const geom = new THREE.BufferGeometry();
    geom.setIndex(shape.index);
    for (const [name, attr] of Object.entries(shape.attributes)) geom.setAttribute(name, attr);
    const capacity = this.capacity[page.kind];
    for (const name of ['yearly', ...OUTLINE_ATTRIBUTES]) {
      const attr = from.geometry.getAttribute(name);
      geom.setAttribute(name, ownInstances ? new THREE.InstancedBufferAttribute(new Float32Array(capacity * attr.itemSize), attr.itemSize) : attr);
    }
    const mesh = new THREE.InstancedMesh(geom, this.streetMade!, this.capacity[page.kind]);
    markCrown(mesh);
    if (ownInstances) mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    else { mesh.instanceMatrix = from.instanceMatrix; mesh.instanceColor = from.instanceColor; }
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

  // From above (High and Ultra): sprays of leaves laid over every broadleaf crown and shrub in view
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
    if (shrubs && !this.canopyShapes) this.canopyShapes = [canopyGeometry(21, [1, 6, 11, 15]), canopyGeometry(23, [2, 8, 14, 20, 24]), canopyGeometry(27, [2, 6, 11], [15, 18, 18, 18, 15]), coniferGeometry(31)];
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
    this.litter.remove(tileKey);
  }

  stats() {
    const active = [0, 0, 0, 0], free = [0, 0, 0, 0], trees = [0, 0, 0, 0];
    for (const page of this.pages) {
      if (page.owner === null) free[page.kind]++;
      else { active[page.kind]++; trees[page.kind] += page.source?.count ?? 0; }
    }
    return { capacity: [...this.capacity], active, free, trees, growth: [...this.growth],
      matrixColourEvergreenBytes: this.pages.reduce((n, p) =>
        n + this.capacity[p.kind] * (16 + 3 + 1 + OUTLINE) * 4 * (p.street ? 2 : 1), 0) };
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.group.removeFromParent();
    this.litter.dispose();
    for (const page of this.pages) {
      page.mesh.geometry.dispose();
      page.mesh.dispose();
      if (page.street) { page.street.geometry.dispose(); page.street.dispose(); }
      if (page.canopy) { page.canopy.geometry.dispose(); page.canopy.dispose(); }
    }
    this.streetMade?.dispose();
    for (const shape of [...[...this.streetLods.values()].flat(), ...(this.canopyShapes ?? [])]) {
      for (const a of [shape.index, ...Object.values(shape.attributes)]) if (a) (a as { shared?: boolean }).shared = false;
      shape.dispose();
    }
    this.factory.dispose();
    this.pages.length = 0;
    this.leases.clear();
  }
}
