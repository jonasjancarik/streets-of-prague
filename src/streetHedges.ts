// The hedges seen from the street. From above a hedge is a rounded green body
// (map/fences.ts), which is all a camera 100 m up can make out. From the pavement that
// body reads as a painted block, so there it wears the photographed face of a clipped
// hornbeam hedge, and over it stand clusters of hornbeam leaves on cards
// (webgpu/streetHedges.ts draws both), each turned and tilted its own way, some half sunk
// in the hedge and dark, some standing proud of it and catching the light. The edge of a
// hedge against the sky is then leaves, and its face has depth.
//
// The clusters are made a patch of 20 m at a time as you come within reach of it on foot
// or in a car's seat, one mesh a patch, and let go again behind you. The further off, the
// fewer of them are drawn and the larger each is. Where the hedges stand is mapped; the
// leaves are a hornbeam's whatever the hedge really is, and every cluster's place is made up.

import * as THREE from 'three';
import { fences, type FenceSection } from './fences.ts';
import { HEDGE_OUTLINE, HEDGE_W, hedgeNoise } from './map/fences.ts';

export const HEDGE_REACH = 60, HEDGE_FADE = 46; // m from the eye: where the last sprays end, and begin to shrink
export const HEDGE_THIN = 14; // m: from here on fewer sprays are drawn, each larger
export const FACE_M = 1.15; // m of hedge one copy of the face's picture covers (its leaves then about 5 cm long)
const PER_M2 = 17; // clusters to a square metre of hedge, over a body that already shows leaves
const SIZE = [0.34, 0.82]; // m: a cluster's card (its leaves then 3-5 cm, a hornbeam's)
const PATCH = 20; // m: the sprays are made a patch of hedges at a time, as you come near
const FORGET = 90; // m: a tile's sprays are let go once you are this far from them

// The two materials (webgpu/streetHedges.ts): the clusters' cards, and the hedge's photographed skin under them.
type Materials = { clusters: THREE.Material; skin: THREE.Material };
let material: (() => Materials) | null = null, ready: { value: boolean } = { value: false };
export const setHedgeMaterial = (make: () => Materials, isReady: { value: boolean }) => { material = make; ready = isReady; };

// The outline's points in metres for a hedge so wide and tall, and how far round each is.
function outline(wide: number, tall: number) {
  const pts = HEDGE_OUTLINE.map(([a, u]) => [a * wide, u * tall]), at = [0];
  for (let i = 1; i < pts.length; i++) at.push(at[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  return { pts, at, round: at[at.length - 1] };
}
// The point a share `t` of the way round, and the way out of the hedge there.
function onOutline(o: ReturnType<typeof outline>, t: number) {
  const d = t * o.round;
  let i = 1;
  while (i < o.at.length - 1 && o.at[i] < d) i++;
  const k = (d - o.at[i - 1]) / (o.at[i] - o.at[i - 1] || 1), a = o.pts[i - 1], b = o.pts[i];
  const ta = b[0] - a[0], tu = b[1] - a[1], l = Math.hypot(ta, tu) || 1;
  return { across: a[0] + ta * k, up: a[1] + tu * k, outAcross: tu / l, outUp: -ta / l };
}
// How far out the hedge reaches at a height (for its ends).
function reachAt(o: ReturnType<typeof outline>, up: number) {
  for (let i = 1; i < 5; i++) if (o.pts[i][1] >= up) {
    const a = o.pts[i - 1], b = o.pts[i];
    return a[0] + (b[0] - a[0]) * (up - a[1]) / (b[1] - a[1] || 1);
  }
  return 0;
}

interface Entry {
  sections: FenceSection[];
  ends: Map<FenceSection, [boolean, boolean]>; // whether the hedge itself ends at the section's start, its end
  x: number; y: number; r: number; // a circle round its hedges
  mesh: THREE.Mesh | null; // the clusters, and as its child the skin
  ranges: Map<FenceSection, [number, number, number, number]>; // each section's first vertex and how many, in the clusters and in the skin
}

class StreetHedges {
  readonly group = new THREE.Group();
  private tiles = new Map<string, Entry[]>();
  private made: Materials | null = null;
  private on = false;

  constructor() {
    this.group.name = 'street-hedges';
    fences.onLay = (f) => this.flatten(f);
  }

  // A tile's hedge sections, as fences.ts has them, sorted into patches.
  add(tile: string, all: FenceSection[]) {
    const hedges = all.filter((s) => s.hedge);
    if (!hedges.length) return;
    // Ends that no other section of the tile starts from are a hedge's own ends, and get leaves too.
    const meets = new Map<string, number>(), key = (x: number, y: number) => `${Math.round(x * 10)},${Math.round(y * 10)}`;
    for (const s of hedges) for (const k of [key(s.x1, s.y1), key(s.x2, s.y2)]) meets.set(k, (meets.get(k) ?? 0) + 1);
    const patches = new Map<string, FenceSection[]>();
    for (const s of hedges) {
      const k = `${Math.floor((s.x1 + s.x2) / 2 / PATCH)},${Math.floor((s.y1 + s.y2) / 2 / PATCH)}`;
      patches.has(k) ? patches.get(k)!.push(s) : patches.set(k, [s]);
    }
    const entries: Entry[] = [];
    for (const sections of patches.values()) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      const ends = new Map<FenceSection, [boolean, boolean]>();
      for (const s of sections) {
        x0 = Math.min(x0, s.x1, s.x2); x1 = Math.max(x1, s.x1, s.x2);
        y0 = Math.min(y0, s.y1, s.y2); y1 = Math.max(y1, s.y1, s.y2);
        ends.set(s, [meets.get(key(s.x1, s.y1)) === 1, meets.get(key(s.x2, s.y2)) === 1]);
      }
      entries.push({ sections, ends, x: (x0 + x1) / 2, y: (y0 + y1) / 2, r: Math.hypot(x1 - x0, y1 - y0) / 2 + 1, mesh: null, ranges: new Map() });
    }
    this.tiles.set(tile, entries);
  }

  remove(tile: string) {
    for (const e of this.tiles.get(tile) ?? []) this.drop(e);
    this.tiles.delete(tile);
  }

  private drop(e: Entry) {
    if (!e.mesh) return;
    this.group.remove(e.mesh);
    e.mesh.geometry.dispose();
    for (const c of e.mesh.children) (c as THREE.Mesh).geometry.dispose();
    e.mesh = null;
    e.ranges.clear();
  }

  // Each frame: whether the view is from the street, and where the eye is (the game's x, y).
  // One patch's sprays are made a frame, the nearest first.
  street(on: boolean, x = 0, y = 0) {
    on &&= !!material;
    if (!on && !this.on) return;
    this.on = on;
    if (on && !this.made) this.made = material!();
    const shown = on && ready.value;
    this.group.visible = shown;
    if (!shown) return;
    let next: Entry | null = null, nearest = Infinity;
    for (const list of this.tiles.values()) for (const e of list) {
      const d = Math.hypot(e.x - x, e.y - y) - e.r;
      if (e.mesh) { e.mesh.visible = d < HEDGE_REACH; if (d > FORGET) this.drop(e); }
      else if (d < HEDGE_REACH && d < nearest) { next = e; nearest = d; }
    }
    if (next) this.build(next);
  }

  // A section that a car has flattened loses its sprays.
  private flatten(f: FenceSection) {
    if (!f.hedge) return;
    for (const list of this.tiles.values()) for (const e of list) {
      const range = e.ranges.get(f);
      if (!range || !e.mesh) continue;
      const corner = e.mesh.geometry.getAttribute('corner') as THREE.BufferAttribute;
      for (let v = range[0]; v < range[0] + range[1]; v++) corner.setXYZ(v, 0, 0, 0);
      corner.needsUpdate = true;
      const skin = (e.mesh.children[0] as THREE.Mesh | undefined)?.geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
      if (skin) {
        for (let v = range[2]; v < range[2] + range[3]; v++) skin.setXYZ(v, f.x1, f.z, -f.y1);
        skin.needsUpdate = true;
      }
    }
  }

  private build(e: Entry) {
    const centre: number[] = [], corner: number[] = [], normal: number[] = [], uv: number[] = [], leaf: number[] = [], index: number[] = [];
    const skinAt: number[] = [], skinNormal: number[] = [], skinUv: number[] = [], skinShade: number[] = [];
    const N = new THREE.Vector3(), U = new THREE.Vector3(), R = new THREE.Vector3(), O = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
    e.sections.forEach((s, at) => {
      if (s.broken) return;
      const dx = s.x2 - s.x1, dy = s.y2 - s.y1, len = Math.hypot(dx, dy);
      if (len < 0.05) return;
      const ax = dx / len, ay = dy / len, nx = ay, ny = -ax; // along it, and to its right
      let seed = (Math.imul(Math.round(s.x1 * 31) ^ Math.round(s.y1 * 17), 2654435761) ^ at * 97) >>> 0 || 1;
      const rand = () => ((seed = Math.imul(seed ^ (seed >>> 15), 2246822519) + 0x9e3779b9 >>> 0) >>> 8) / 16777216;
      // How it has grown at its two ends and its middle, as the body has it.
      const grown = [0, 0.5, 1].map((f) => {
        const x = s.x1 + dx * f, y = s.y1 + dy * f;
        return [1 + (hedgeNoise(x, y, 1) - 0.5) * 0.16, (HEDGE_W / 2) * (1 + (hedgeNoise(x, y, 2) - 0.5) * 0.3)];
      });
      const grownAt = (f: number) => {
        const i = f < 0.5 ? 0 : 1, k = (f - i * 0.5) * 2;
        return [grown[i][0] + (grown[i + 1][0] - grown[i][0]) * k, grown[i][1] + (grown[i + 1][1] - grown[i][1]) * k];
      };
      const first = centre.length / 3, skinFirst = skinAt.length / 3;
      // The skin: the body's own shape (map/fences.ts), a finger's width outside it, the
      // face's picture laid on in metres along the hedge and round it.
      {
        const rings = [0, 0.5, 1].map((f) => {
          const [g, wide] = grownAt(f), o = outline(wide + 0.015, s.h * g + 0.015), x = s.x1 + dx * f, y = s.y1 + dy * f;
          return o.pts.map(([across, high], k) => {
            const a = o.pts[Math.max(0, k - 1)], b = o.pts[Math.min(o.pts.length - 1, k + 1)];
            let ta = b[0] - a[0], tu = b[1] - a[1];
            if (k === 0 || k === o.pts.length - 1) { ta = 0; tu = k === 0 ? 1 : -1; }
            const l = Math.hypot(ta, tu) || 1, na = tu / l, nu = -ta / l;
            return { p: [x + nx * across, s.z + high - 0.04, -(y + ny * across)], n: [nx * na, nu, -ny * na], u: (at * 3 + f * len) / FACE_M, v: o.at[k] / FACE_M, across, h: high / (s.h * g) };
          });
        });
        const put = (q: { p: number[]; n: number[]; h: number }, u: number, v: number, n?: number[]) => { skinAt.push(...q.p); skinNormal.push(...(n ?? q.n)); skinUv.push(u, v); skinShade.push(q.h); };
        for (let r = 0; r < 2; r++) for (let k = 0; k < rings[r].length - 1; k++) {
          const Q = [rings[r][k], rings[r + 1][k], rings[r + 1][k + 1], rings[r][k + 1]];
          for (const q of [0, 1, 2, 0, 2, 3]) put(Q[q], Q[q].u, Q[q].v);
        }
        const own = e.ends.get(s)!;
        for (const [R, sign, has] of [[rings[0], -1, own[0]], [rings[2], 1, own[1]]] as const) {
          if (!has) continue;
          const c = { p: [(R[0].p[0] + R[8].p[0]) / 2, (R[0].p[1] + R[8].p[1]) / 2, (R[0].p[2] + R[8].p[2]) / 2], n: [0, 0, 0], h: 0 };
          const n = [ax * sign, 0.25, -ay * sign];
          for (let k = 0; k < R.length - 1; k++) for (const t of sign < 0 ? [c, R[k], R[k + 1]] : [c, R[k + 1], R[k]]) {
            const full = t as typeof R[number];
            put(t, (full.across ?? 0) / FACE_M + 0.37, ((full.h ?? 0) * s.h) / FACE_M, n);
          }
        }
      }
      // A spray at a point (the game's x, y and a height), facing `out`, `depth` 0 deep inside to 1 proud of the hedge.
      const spray = (x: number, y: number, z: number, out: THREE.Vector3, depth: number, heightShare: number) => {
        // (Nearly flat to the hedge's face, as clipping leaves them: a little tilt each.)
        N.set(out.x + (rand() - 0.5) * 0.8, out.y + (rand() - 0.5) * 0.8, out.z + (rand() - 0.5) * 0.8).normalize();
        // The spray grows up the hedge's face, give or take most of a quarter turn (any way, on its top).
        U.copy(up).addScaledVector(N, -up.dot(N));
        if (U.lengthSq() < 0.08) U.set(rand() - 0.5, 0, rand() - 0.5).addScaledVector(N, -N.y * 0);
        U.normalize().applyAxisAngle(N, rand() * 6.2832); // (a cluster is round: any way up)
        R.crossVectors(U, N).normalize();
        const size = SIZE[0] + (SIZE[1] - SIZE[0]) * rand(), v = centre.length / 3, tone = rand(), rank = rand();
        for (const [cx, cy] of [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]]) {
          centre.push(x, z, -y);
          corner.push((R.x * cx + U.x * cy) * size, (R.y * cx + U.y * cy) * size, (R.z * cx + U.z * cy) * size);
          // Lit as the hedge's rounded face is, a little towards the sky, not as the card lies.
          normal.push(out.x, out.y + 0.3, out.z);
          uv.push(cx + 0.5, cy + 0.5);
          leaf.push(tone, heightShare, depth, rank);
        }
        index.push(v, v + 1, v + 2, v, v + 2, v + 3);
      };
      const tall = s.h, wideMid = grownAt(0.5)[1], round = outline(wideMid, tall).round;
      for (let i = 0, n = Math.round(len * round * PER_M2); i < n; i++) {
        // (A little past either end: round the outside of a bend, and onto a hedge's own end.)
        const past = 0.4 * HEDGE_W / len, f = -past + (1 + 2 * past) * rand(), [g, wide] = grownAt(Math.min(1, Math.max(0, f))), o = outline(wide, tall * g);
        const p = onOutline(o, 0.03 + 0.94 * rand()), depth = rand(), off = -0.03 + 0.14 * depth; // (some half sunk in the body, some standing proud of it)
        O.set(nx * p.outAcross, p.outUp, -ny * p.outAcross).normalize();
        const x = s.x1 + dx * f + nx * p.across, y = s.y1 + dy * f + ny * p.across;
        spray(x + O.x * off, y - O.z * off, s.z + p.up + O.y * off, O, depth, p.up / (tall * g));
      }
      const own = e.ends.get(s)!;
      for (const [ex, ey, sign] of [[s.x1, s.y1, -1], [s.x2, s.y2, 1]]) {
        if (!own[sign < 0 ? 0 : 1]) continue;
        const [g, wide] = grownAt(sign < 0 ? 0 : 1), o = outline(wide, tall * g);
        for (let i = 0, n = Math.round(wide * 2 * tall * PER_M2 * 3); i < n; i++) {
          const h = (0.04 + 0.96 * rand()) * tall * g, reach = reachAt(o, h), side = rand() * 2 - 1, a = side * reach, depth = rand(), off = -0.03 + 0.14 * depth;
          // The end is rounded like the sides: towards its edges the leaves face more and more sideways and up.
          const rise = (h / (tall * g) - 0.5) * 1.1;
          O.set(ax * sign + nx * side * 0.9, 0.1 + Math.max(0, rise), -(ay * sign + ny * side * 0.9)).normalize();
          spray(ex + nx * a + O.x * off, ey + ny * a - O.z * off, s.z + h, O, depth, h / (tall * g));
        }
      }
      e.ranges.set(s, [first, centre.length / 3 - first, skinFirst, skinAt.length / 3 - skinFirst]);
    });
    if (!index.length) { e.mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.made!.clusters); e.mesh.visible = false; this.group.add(e.mesh); return; }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(centre, 3));
    g.setAttribute('corner', new THREE.Float32BufferAttribute(corner, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(normal, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setAttribute('leaf', new THREE.Float32BufferAttribute(leaf, 4));
    g.setIndex(centre.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(index, 1) : new THREE.Uint16BufferAttribute(index, 1));
    g.computeBoundingSphere();
    g.boundingSphere!.radius += 1;
    const mesh = new THREE.Mesh(g, this.made!.clusters);
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.Float32BufferAttribute(skinAt, 3));
    sg.setAttribute('normal', new THREE.Float32BufferAttribute(skinNormal, 3));
    sg.setAttribute('uv', new THREE.Float32BufferAttribute(skinUv, 2));
    sg.setAttribute('height', new THREE.Float32BufferAttribute(skinShade, 1));
    sg.boundingSphere = g.boundingSphere!.clone();
    const skin = new THREE.Mesh(sg, this.made!.skin);
    skin.receiveShadow = true;
    skin.matrixAutoUpdate = false;
    mesh.add(skin);
    e.mesh = mesh;
    this.group.add(mesh);
  }
}

export const streetHedges = new StreetHedges();
