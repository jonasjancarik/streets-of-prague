// Close versions of the utility marks already painted into the ground. The
// survey positions stay fixed. Only a few metres around the street camera use
// cast relief and a grate with actual slots.
import * as THREE from 'three';
import type { TileWorld } from './tiles.ts';
import type { Tier } from './graphics.ts';
import { DRAIN, HYDRANT_COVER, MANHOLE, streetAngle } from './map/utility.ts';
import { lampLit } from './lamps.ts';

const LIMIT = 32;
const reach = { lowest: 0, low: 9, medium: 15, high: 20, ultra: 24 } as const;
type Tile = NonNullable<ReturnType<TileWorld['tileAt']>>;
type Mark = { x: number; y: number; kind: number; d: number; tile: Tile };

function casting(kind: number) {
  const pos: number[] = [], uv: number[] = [], indices: number[] = [];
  const width = kind === 3 ? .35 : kind === 2 ? .54 : .71;
  const depth = kind === 3 ? .25 : width;
  const point = (x: number, y: number, z: number, dark = false) => {
    pos.push(x, y, z);
    // +z is down the printed lid. Leave a gutter for filtered edge pixels.
    const u = dark ? .46 : THREE.MathUtils.clamp(.5 + x / width, .006, .994);
    const v = dark ? .54 : THREE.MathUtils.clamp(.5 - z / depth, .006, .994);
    uv.push((kind % 2 + u) / 2, (1 - Math.floor(kind / 2) + v) / 2);
    return pos.length / 3 - 1;
  };
  if (kind !== 2) {
    const sides = kind === 3 ? 24 : 32;
    const disc = point(0, .013, 0);
    for (let k = 0; k < sides; k++) {
      const a = k * 2 * Math.PI / sides, b = (k + 1) * 2 * Math.PI / sides;
      const rim = (a: number, scale: number, h: number) =>
        point(Math.cos(a) * width * .5 * scale, h, Math.sin(a) * depth * .5 * scale);
      const a1 = rim(a, .986, .013), b1 = rim(b, .986, .013);
      const a0 = rim(a, 1, .003), b0 = rim(b, 1, .003);
      indices.push(disc, b1, a1, a1, b1, b0, a1, b0, a0);
    }
  } else {
    const quad = (a: number, b: number, c: number, d: number) => indices.push(a, b, c, a, c, d);
    // The iron frame and rib tops sit just above the road, the well below
    // them is dark, so paving cannot show through the five drainage slots.
    quad(
      point(-.27, .001, .27, true),
      point(.27, .001, .27, true),
      point(.27, .001, -.27, true),
      point(-.27, .001, -.27, true),
    );
    const rib = (x0: number, x1: number, z0: number, z1: number) => {
      const top = [[x0 + .003, z0 + .003], [x1 - .003, z0 + .003], [x1 - .003, z1 - .003], [x0 + .003, z1 - .003]];
      const base = [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];
      const ids = top.map(([x, z]) => point(x, .022, z));
      quad(ids[3], ids[2], ids[1], ids[0]);
      for (let i = 0; i < 4; i++) {
        const j = (i + 1) % 4;
        quad(point(base[j][0], .002, base[j][1]), point(base[i][0], .002, base[i][1]), ids[i], ids[j]);
      }
    };
    rib(-.27, .27, -.27, -.229);
    rib(-.27, .27, .229, .27);
    rib(-.27, -.229, -.229, .229);
    rib(.229, .27, -.229, .229);
    for (let i = 0; i < 5; i++) {
      const z = (i - 2) * .085;
      rib(-.229, .229, z - .020, z + .020);
    }
    rib(-.013, .013, -.229, .229);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(indices);
  g.computeVertexNormals();
  return g;
}

export class StreetIronwork {
  private meshes: THREE.InstancedMesh[] = [];
  private angles = new WeakMap<Tile, ReturnType<typeof streetAngle>>();
  private last = new THREE.Vector3(Infinity, Infinity, -1);
  private tier?: Tier;
  private material?: THREE.MeshStandardMaterial;
  private loading = false;
  private retryAt = 0;
  private basis = new THREE.Matrix4();
  private axis = new THREE.Vector3();
  private normal = new THREE.Vector3();
  private across = new THREE.Vector3();
  constructor(private scene: THREE.Scene, private world: TileWorld) {}

  update(street: boolean, eye: THREE.Vector3, tier: Tier, wet: number) {
    const radius = street ? reach[tier] : 0;
    if (!radius) {
      if (this.last.z !== -1) {
        for (const mesh of this.meshes) mesh.visible = false;
        this.last.z = -1;
      }
      return;
    }
    if (this.material) this.material.roughness = .77 - wet * .38;
    const x = eye.x, y = -eye.z, revision = this.world.terrainRevision + this.world.joined;
    if (
      this.last.z === revision && this.tier === tier && Math.hypot(x - this.last.x, y - this.last.y) < 1.5 &&
      (!this.retryAt || this.loading || performance.now() < this.retryAt)
    ) return;
    this.tier = tier;
    this.last.set(x, y, revision);
    const here = this.world.tileAt(x, y), marks: Mark[] = [];
    if (here) {
      for (let i = here.i - 1; i <= here.i + 1; i++) {
        for (let j = here.j - 1; j <= here.j + 1; j++) {
          const tile = this.world.byIndex.get(i * 65536 + j);
          if (!tile?.drawn) continue;
          const [x0, y0, x1, y1] = tile.box;
          if (x < x0 - radius || x > x1 + radius || y < y0 - radius || y > y1 + radius) continue;
          for (const [px, py, kind] of tile.source.t.utility ?? []) {
            if (kind !== MANHOLE && kind !== DRAIN && kind !== HYDRANT_COVER) continue;
            const d = (px - x) ** 2 + (py - y) ** 2;
            if (d < radius * radius) marks.push({ x: px, y: py, kind, d, tile });
          }
        }
      }
    }
    if (!this.material) {
      if (marks.length) this.load(); else this.retryAt = 0;
      return;
    }
    for (const mesh of this.meshes) mesh.count = 0;
    marks.sort((a, b) => a.d - b.d);
    for (const m of marks.slice(0, LIMIT)) {
      const hash = Math.imul(Math.round(m.x * 10), 73856093) ^ Math.imul(Math.round(m.y * 10), 19349663);
      const kind = m.kind === DRAIN ? 2 : m.kind === HYDRANT_COVER ? 3 : hash & 1;
      let angle = (hash >>> 0) / 4294967296 * 2 * Math.PI;
      if (m.kind !== MANHOLE) {
        let angles = this.angles.get(m.tile);
        if (!angles) {
          angles = streetAngle(m.tile.source.clipped.filter((e) => !e.bridge && !e.tunnel).map((e) => e.pts));
          this.angles.set(m.tile, angles);
        }
        angle = angles(m.x, m.y);
      }
      const h = this.world.terrainAt(m.x, m.y);
      if (Math.abs(eye.y - h) > 8) continue;
      const r = .25, dx = (this.world.terrainAt(m.x + r, m.y) - this.world.terrainAt(m.x - r, m.y)) / (2 * r);
      const dy = (this.world.terrainAt(m.x, m.y + r) - this.world.terrainAt(m.x, m.y - r)) / (2 * r);
      if (Math.hypot(dx, dy) > .48) continue;
      this.normal.set(-dx, 1, dy).normalize();
      const c = Math.cos(angle), s = Math.sin(angle);
      this.axis.set(c, c * dx + s * dy, -s).normalize();
      this.across.crossVectors(this.axis, this.normal).normalize();
      this.basis.makeBasis(this.axis, this.normal, this.across).setPosition(m.x, h + .006, -m.y);
      const mesh = this.meshes[kind];
      mesh.setMatrixAt(mesh.count++, this.basis);
    }
    for (const mesh of this.meshes) {
      mesh.visible = mesh.count > 0;
      if (mesh.visible) {
        mesh.instanceMatrix.clearUpdateRanges();
        mesh.instanceMatrix.addUpdateRange(0, mesh.count * 16);
        mesh.instanceMatrix.needsUpdate = true;
      }
    }
  }
  private load() {
    if (this.loading || performance.now() < this.retryAt) return;
    this.loading = true;
    const loader = new THREE.TextureLoader();
    void Promise.allSettled(
      ['ironwork.webp', 'ironwork-normal.webp'].map((file) => loader.loadAsync(import.meta.env.BASE_URL + file)),
    ).then(([base, normal]) => {
      if (base.status === 'rejected' || normal.status === 'rejected') {
        if (base.status === 'fulfilled') base.value.dispose();
        if (normal.status === 'fulfilled') normal.value.dispose();
        this.retryAt = performance.now() + 60000;
        return;
      }
      base.value.colorSpace = THREE.SRGBColorSpace;
      base.value.anisotropy = normal.value.anisotropy = 4;
      this.material = new THREE.MeshStandardMaterial({
        map: base.value,
        normalMap: normal.value,
        metalness: .18,
        roughness: .77,
      });
      this.material.customProgramCacheKey = () => 'street-ironwork';
      this.material.onBeforeCompile = (sh) => lampLit(sh);
      for (let k = 0; k < 4; k++) {
        const mesh = new THREE.InstancedMesh(casting(k), this.material, LIMIT);
        mesh.name = 'Street ironwork';
        mesh.userData.casting = k;
        mesh.count = 0;
        mesh.visible = false;
        mesh.receiveShadow = true;
        mesh.frustumCulled = false;
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        this.scene.add(mesh);
        this.meshes.push(mesh);
      }
      this.retryAt = 0; this.last.z = -1;
    }).finally(() => {
      this.loading = false;
    });
  }
}
