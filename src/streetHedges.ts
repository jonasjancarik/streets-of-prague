// The hedges seen from the street. From above a hedge is a rounded green body
// (map/fences.ts), which is all a camera 100 m up can make out. From the pavement that
// body reads as a painted block, so there it only fills the inside: over it stands a
// shell of leaf sprays, the photographed ones the street trees wear (webgpu/streetHedges.ts
// draws them), a few dozen to a metre, each turned and tilted its own way, some deep in
// the hedge and dark, some standing proud of it and catching the light. The edge of a
// hedge against the sky is then leaves, and you can see into it between them.
//
// The sprays are made a patch of 20 m at a time as you come within reach of it on foot or
// in a car's seat, one mesh a patch, and let go again behind you. The further off, the
// fewer of them are drawn and the larger each is (webgpu/streetHedges.ts). Where the hedges stand is mapped; every spray's place is made up.

import * as THREE from 'three';
import { fences, type FenceSection } from './fences.ts';
import { HEDGE_OUTLINE, HEDGE_W, hedgeNoise } from './map/fences.ts';

export const HEDGE_REACH = 60, HEDGE_FADE = 46; // m from the eye: where the last sprays end, and begin to shrink
export const HEDGE_THIN = 14; // m: from here on fewer sprays are drawn, each larger
// 1 while the sprays are drawn: the body under them is then darkened near the eye (webgpu.ts).
export const HEDGE_STREET = { value: 0 };
const PER_M2 = 44; // sprays to a square metre of hedge: a clipped hedge is a dense skin of small leaves
const SIZE = [0.26, 0.42]; // m: a spray's card (its leaves then 2-3 cm, as a hornbeam's or a privet's)
const PATCH = 20; // m: the sprays are made a patch of hedges at a time, as you come near
const FORGET = 90; // m: a tile's sprays are let go once you are this far from them

let material: (() => THREE.Material) | null = null, ready: { value: boolean } = { value: false };
export const setHedgeMaterial = (make: () => THREE.Material, isReady: { value: boolean }) => { material = make; ready = isReady; };

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
  mesh: THREE.Mesh | null;
  ranges: Map<FenceSection, [number, number]>; // each section's first vertex and how many
}

class StreetHedges {
  readonly group = new THREE.Group();
  private tiles = new Map<string, Entry[]>();
  private made: THREE.Material | null = null;
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
    HEDGE_STREET.value = shown ? 1 : 0;
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
    }
  }

  private build(e: Entry) {
    const centre: number[] = [], corner: number[] = [], normal: number[] = [], uv: number[] = [], leaf: number[] = [], index: number[] = [];
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
      const first = centre.length / 3;
      // A spray at a point (the game's x, y and a height), facing `out`, `depth` 0 deep inside to 1 proud of the hedge.
      const spray = (x: number, y: number, z: number, out: THREE.Vector3, depth: number, heightShare: number) => {
        // (Nearly flat to the hedge's face, as clipping leaves them: a little tilt each.)
        N.set(out.x + (rand() - 0.5) * 0.5, out.y + (rand() - 0.5) * 0.5, out.z + (rand() - 0.5) * 0.5).normalize();
        // The spray grows up the hedge's face, give or take most of a quarter turn (any way, on its top).
        U.copy(up).addScaledVector(N, -up.dot(N));
        if (U.lengthSq() < 0.08) U.set(rand() - 0.5, 0, rand() - 0.5).addScaledVector(N, -N.y * 0);
        U.normalize().applyAxisAngle(N, (rand() - 0.5) * 2.2);
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
        const p = onOutline(o, 0.03 + 0.94 * rand()), depth = rand(), off = 0.035 + 0.12 * depth; // (clear of the body, which would hide what dips into it)
        O.set(nx * p.outAcross, p.outUp, -ny * p.outAcross).normalize();
        const x = s.x1 + dx * f + nx * p.across, y = s.y1 + dy * f + ny * p.across;
        spray(x + O.x * off, y - O.z * off, s.z + p.up + O.y * off, O, depth, p.up / (tall * g));
      }
      const own = e.ends.get(s)!;
      for (const [ex, ey, sign] of [[s.x1, s.y1, -1], [s.x2, s.y2, 1]]) {
        if (!own[sign < 0 ? 0 : 1]) continue;
        const [g, wide] = grownAt(sign < 0 ? 0 : 1), o = outline(wide, tall * g);
        for (let i = 0, n = Math.round(wide * 2 * tall * PER_M2 * 2); i < n; i++) {
          const h = (0.04 + 0.96 * rand()) * tall * g, reach = reachAt(o, h), side = rand() * 2 - 1, a = side * reach, depth = rand(), off = 0.035 + 0.12 * depth;
          // The end is rounded like the sides: towards its edges the leaves face more and more sideways and up.
          const rise = (h / (tall * g) - 0.5) * 1.1;
          O.set(ax * sign + nx * side * 0.9, 0.1 + Math.max(0, rise), -(ay * sign + ny * side * 0.9)).normalize();
          spray(ex + nx * a + O.x * off, ey + ny * a - O.z * off, s.z + h, O, depth, h / (tall * g));
        }
      }
      e.ranges.set(s, [first, centre.length / 3 - first]);
    });
    if (!index.length) { e.mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.made!); e.mesh.visible = false; this.group.add(e.mesh); return; }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(centre, 3));
    g.setAttribute('corner', new THREE.Float32BufferAttribute(corner, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(normal, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setAttribute('leaf', new THREE.Float32BufferAttribute(leaf, 4));
    g.setIndex(centre.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(index, 1) : new THREE.Uint16BufferAttribute(index, 1));
    g.computeBoundingSphere();
    g.boundingSphere!.radius += 1;
    const mesh = new THREE.Mesh(g, this.made!);
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    e.mesh = mesh;
    this.group.add(mesh);
  }
}

export const streetHedges = new StreetHedges();
