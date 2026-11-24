// Individual curled leaves under nearby broadleaf trees. One retained mesh, filled
// in short slices when the eye moves or tiles change; the overhead litter stays as it is.
import * as THREE from 'three';
import { SEASON } from './shading.ts';
import { STEM, type TreeInstances } from './map/vegetation.ts';
import { STREET_DETAIL } from './streetHedges.ts';
import { rng } from './map/geo.ts';

export const LITTER_REACH = 22, LITTER_CAPACITY = 3600;
const SLICE_MS = .75;
// Linden-like hearts and pointed maple lobes, including a narrow petiole.
const HEART = [[0,.6],[.13,.39],[.27,.23],[.38,.07],[.4,-.09],[.33,-.25],[.17,-.33],[.02,-.25],[.018,-.52],[-.018,-.52],[-.02,-.25],[-.17,-.33],[-.33,-.25],[-.4,-.09],[-.38,.07],[-.27,.23],[-.13,.39]];
const MAPLE = [[0,.62],[.12,.27],[.44,.4],[.3,.12],[.55,.02],[.3,-.15],[.31,-.38],[.035,-.27],[.018,-.55],[-.018,-.55],[-.035,-.27],[-.31,-.38],[-.3,-.15],[-.55,.02],[-.3,.12],[-.44,.4],[-.12,.27]];
const RIM = HEART.length;
export const LITTER_VERTICES = RIM+1;
export interface LitterGround {
  open(x: number, y: number): boolean;
  height(x: number, y: number): number;
}
let material: (() => THREE.Material) | null = null;
export const setLitterMaterial = (make: () => THREE.Material) => { material = make; };
type Tree = { x: number; y: number; radius: number; seed: number; distance: number };
const colours = ['#a47a32', '#b89538', '#86532d', '#b1632c', '#70583b'].map(c => new THREE.Color(c));

export class StreetLitter {
  readonly group = new THREE.Group();
  enabled = true; // For measuring the feature with bench.mjs --ab.
  private sources = new Map<string, TreeInstances>();
  private mesh: THREE.Mesh | null = null;
  private revision = 0;
  private built = -1;
  private groundRevision = -1;
  private x = Infinity;
  private y = Infinity;
  private pending: Generator<void, THREE.BufferGeometry> | null = null;
  constructor() { this.group.name = 'street-fallen-leaves'; this.group.visible = false; }

  add(key: string, data: TreeInstances) { this.sources.set(key, data); this.revision++; }
  remove(key: string) { if (this.sources.delete(key)) this.revision++; }

  street(on: boolean, x = 0, y = 0, ground?: LitterGround, revision = 0) {
    on &&= this.enabled && STREET_DETAIL.value && !!material && !!ground && SEASON.value.x > .4;
    this.group.visible = on;
    if (!on || !ground) { if (this.pending) this.built = -1; this.pending = null; return; }
    if (this.built !== this.revision || this.groundRevision !== revision || Math.hypot(x-this.x, y-this.y) > 4) {
      const stale = this.built !== this.revision || this.groundRevision !== revision || Math.hypot(x-this.x,y-this.y)>LITTER_REACH;
      this.x = x; this.y = y; this.built = this.revision; this.groundRevision = revision;
      this.pending = this.build(this.nearby(x, y), ground, x, y);
      // Never show leaves from unloaded tiles or a distant place while refilling.
      if (this.mesh && stale) this.mesh.visible = false;
    }
    if (!this.pending && this.mesh) this.mesh.visible = true;
    const until = performance.now() + SLICE_MS;
    if (this.pending) do {
      const next = this.pending.next();
      if (next.done) {
        if (!this.mesh) {
          const geometry = new THREE.BufferGeometry();
          for (const [name,attr] of Object.entries(next.value.attributes)) {
            geometry.setAttribute(name,new THREE.BufferAttribute(new Float32Array(LITTER_CAPACITY*LITTER_VERTICES*attr.itemSize),attr.itemSize));
          }
          const indices = new Uint16Array(LITTER_CAPACITY*RIM*3);
          for(let i=0;i<LITTER_CAPACITY;i++) for(let j=0;j<RIM;j++) {
            indices.set([i*LITTER_VERTICES,i*LITTER_VERTICES+1+(j+1)%RIM,i*LITTER_VERTICES+1+j],(i*RIM+j)*3);
          }
          geometry.setIndex(new THREE.BufferAttribute(indices,1));
          this.mesh = new THREE.Mesh(geometry, material!());
          this.mesh.name = 'Individual fallen leaves';
          this.mesh.receiveShadow = true;
          this.mesh.matrixAutoUpdate = false;
          this.group.add(this.mesh);
        }
        // Keep GPU buffers and shader bindings through walking and tile changes.
        const geometry = this.mesh.geometry;
        for (const [name,from] of Object.entries(next.value.attributes)) {
          const to=geometry.getAttribute(name) as THREE.BufferAttribute;
          to.array.set(from.array); to.clearUpdateRanges();
          if(from.array.length) { to.addUpdateRange(0,from.array.length); to.needsUpdate=true; }
        }
        geometry.setDrawRange(0,next.value.index!.count);
        geometry.boundingSphere=next.value.boundingSphere;
        geometry.userData.leaves=next.value.getAttribute('position').count/LITTER_VERTICES;
        next.value.dispose();
        this.mesh.visible = true; this.pending = null;
        break;
      }
    } while (performance.now() < until);
  }

  private nearby(x: number, y: number) {
    const trees: Tree[] = [];
    for (const data of this.sources.values()) {
      const n = data.count-data.shrubs-data.conifers;
      for (let i = 0; i < n; i++) {
        const year = data.yearly[i] % STEM.span;
        if (year >= .995 && year <= 1.5) continue; // Evergreen broadleaf trees.
        const at = i*16, m = data.matrices, tx = m[at+12], ty = -m[at+14];
        const radius = Math.max(Math.hypot(m[at],m[at+2]),Math.hypot(m[at+8],m[at+10]));
        const distance = Math.hypot(tx-x,ty-y);
        if (distance > LITTER_REACH + radius || radius < .3) continue;
        trees.push({x:tx,y:ty,radius:Math.min(radius,7),distance,
          seed: (Math.imul(Math.round(tx*100),73856093)^Math.imul(Math.round(ty*100),19349663)) >>> 0});
      }
    }
    return trees.sort((a,b) => a.distance-b.distance || a.seed-b.seed);
  }

  private *build(trees: Tree[], ground: LitterGround, eyeX: number, eyeY: number): Generator<void, THREE.BufferGeometry> {
    const pos: number[] = [], corner: number[] = [], normal: number[] = [], uv: number[] = [], colour: number[] = [], leaf: number[] = [], index: number[] = [];
    const a = new THREE.Vector3(), b = new THREE.Vector3(), n = new THREE.Vector3();
    let count = 0, attempts = 0;
    for (const tree of trees) {
      const all = Math.min(1400, Math.ceil(Math.PI*tree.radius**2*32));
      for (let i = 0; i < all && count < LITTER_CAPACITY; i++) {
        if (attempts++ % 24 === 0) yield;
        // Independent seeds keep surviving leaves fixed when the camera or an
        // obstacle rejects an earlier candidate during the next fill.
        const r = rng((tree.seed ^ Math.imul(i+1,2246822519)) >>> 0);
        const angle = r()*Math.PI*2, radial = Math.sqrt(r())*1.15;
        const x = tree.x+Math.cos(angle)*radial*tree.radius, y = tree.y+Math.sin(angle)*radial*tree.radius;
        // Denser beneath the crown, with gaps and overlapping clusters rather than a carpet.
        if (r() < radial*radial*.5 || Math.hypot(x-eyeX,y-eyeY) > LITTER_REACH+3 || !ground.open(x,y)) continue;
        const h = ground.height(x,y);
        // The walking sampler rounds a kerb into a short ramp, while the visible
        // granite has a vertical face. Leave that narrow transition clear.
        const across = [ground.height(x-.2,y),ground.height(x+.2,y),ground.height(x,y-.2),ground.height(x,y+.2)];
        if (across.some(z=>Math.abs(z-h)>.08) || Math.abs(across[0]+across[1]-2*h)>.035 || Math.abs(across[2]+across[3]-2*h)>.035) continue;
        const turn = r()*Math.PI*2, size = .085+r()*.085;
        const cs = Math.cos(turn), sn = Math.sin(turn), lobed = r() < .45, tone = r(), rank = r();
        const curl = .003+r()*.012, tint = colours[Math.floor(r()*colours.length)], first = pos.length/3;
        const points: [number,number,number][] = [[0,0,.006+curl*.35]];
        for (const [u,v] of lobed ? MAPLE : HEART) {
          points.push([u,v,curl*(.3+Math.abs(u)*1.8)+.002]);
        }
        // Check every edge against walls, water and abrupt steps, not just its centre.
        const vertices = points.map(([u,v,z]) => {
          const dx=(u*cs-v*sn)*size, dy=(u*sn+v*cs)*size;
          return {u,v,dx,dy,h:ground.height(x+dx,y+dy),z,nx:0,ny:0,nz:0};
        });
        if (vertices.some(p => Math.abs(p.h-h)>.06 || !ground.open(x+p.dx,y+p.dy))) continue;
        for (let j=0; j<RIM; j++) {
          const ids = [0,1+(j+1)%RIM,1+j], p=vertices[ids[0]], q=vertices[ids[1]], s=vertices[ids[2]];
          a.set(q.dx-p.dx,q.h+q.z-p.h-p.z,p.dy-q.dy);
          b.set(s.dx-p.dx,s.h+s.z-p.h-p.z,p.dy-s.dy); n.crossVectors(a,b);
          for (const id of ids) { vertices[id].nx+=n.x; vertices[id].ny+=n.y; vertices[id].nz+=n.z; }
          index.push(...ids.map(id=>first+id));
        }
        for (const p of vertices) {
          pos.push(x,h+.006,-y); corner.push(p.dx,p.h-h+p.z,-p.dy);
          n.set(p.nx,p.ny,p.nz).normalize(); normal.push(n.x,n.y,n.z);
          uv.push(p.u,p.v); colour.push(tint.r,tint.g,tint.b); leaf.push(tone,rank);
        }
        count++;
      }
      if (count >= LITTER_CAPACITY) break;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position',new THREE.Float32BufferAttribute(pos,3));
    g.setAttribute('corner',new THREE.Float32BufferAttribute(corner,3));
    g.setAttribute('normal',new THREE.Float32BufferAttribute(normal,3));
    g.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));
    g.setAttribute('color',new THREE.Float32BufferAttribute(colour,3));
    g.setAttribute('leaf',new THREE.Float32BufferAttribute(leaf,2));
    g.setIndex(new THREE.Uint16BufferAttribute(index,1));
    g.computeBoundingSphere(); if (g.boundingSphere) g.boundingSphere.radius += .2;
    return g;
  }

  dispose() {
    this.pending = null; this.sources.clear();
    this.mesh?.geometry.dispose(); (this.mesh?.material as THREE.Material | undefined)?.dispose();
    this.group.removeFromParent(); this.mesh = null;
  }
}
