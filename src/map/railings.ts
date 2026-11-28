import * as THREE from 'three';

// Prague's street railings and the chains hung between bollards, modelled rather than
// painted on a card (map/fences.ts cuts their lines into sections, as for a fence).
// - A street railing (zábradlí): steel tube, a post at each end of a section (2 m at
//   most), a top rail at the railing's height and a second one a little under half way.
//   The old ones are painted in red and white bands, the newer ones (and all of them in
//   the historic core) a near-black anthracite. `look` 0 and 1.
// - A chain between bollards (round the Hus memorial, on the Old Town's squares): cast
//   iron posts 0.76 m tall with a domed top, a chain sagging from one to the next.
// Each section is a fixed number of vertices, so a car can knock it down (fences.ts).

export const RAILING_SECTION = 2; // m: the longest section, and so the post spacing
export const CHAIN_H = 0.76; // m: a bollard's height
export const CHAIN_SPAN = 2.8; // m: the longest span between two bollards
export const RAILING_LOOKS = 2;
const STRIPE = 2; // m: one red and one white band, a metre each
const ROWS = 4; // texture rows, see ironwork()
const TUBE = 6; // sides of a tube
const BOLLARD = 8; // sides of a bollard

type Out = { pos: number[]; nor: number[]; uv: number[] };
type V3 = [number, number, number]; // map x, y and up

// Into the game's axes (x, up, -y): a proper rotation, so the winding stays.
function vert(o: Out, p: V3, n: V3, u: number, v: number) {
  o.pos.push(p[0], p[2], -p[1]);
  o.nor.push(n[0], n[2], -n[1]);
  o.uv.push(u, v);
}

// A frame across the axis a→b: two unit vectors at right angles to it and each other.
function frame(a: V3, b: V3): [V3, V3, V3] {
  const d: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const l = Math.hypot(...d) || 1;
  d[0] /= l; d[1] /= l; d[2] /= l;
  const ref: V3 = Math.abs(d[2]) > 0.9 ? [1, 0, 0] : [0, 0, 1];
  let e1: V3 = [d[1] * ref[2] - d[2] * ref[1], d[2] * ref[0] - d[0] * ref[2], d[0] * ref[1] - d[1] * ref[0]];
  const m = Math.hypot(...e1) || 1;
  e1 = [e1[0] / m, e1[1] / m, e1[2] / m];
  const e2: V3 = [d[1] * e1[2] - d[2] * e1[1], d[2] * e1[0] - d[0] * e1[2], d[0] * e1[1] - d[1] * e1[0]];
  return [d, e1, e2];
}

// A tube from a (radius ra) to b (radius rb), round-shaded, open at its ends:
// sides × 6 vertices. `ua`, `ub`: the texture's u at its two ends.
function tube(o: Out, a: V3, b: V3, ra: number, rb: number, sides: number, ua: number, ub: number, v: number) {
  const [, e1, e2] = frame(a, b);
  const dir = (k: number): V3 => {
    const t = (k / sides) * Math.PI * 2, c = Math.cos(t), s = Math.sin(t);
    return [e1[0] * c + e2[0] * s, e1[1] * c + e2[1] * s, e1[2] * c + e2[2] * s];
  };
  const at = (p: V3, r: number, n: V3): V3 => [p[0] + n[0] * r, p[1] + n[1] * r, p[2] + n[2] * r];
  for (let k = 0; k < sides; k++) {
    const n0 = dir(k), n1 = dir(k + 1);
    const A0 = at(a, ra, n0), A1 = at(a, ra, n1), B0 = at(b, rb, n0), B1 = at(b, rb, n1);
    vert(o, A0, n0, ua, v); vert(o, A1, n1, ua, v); vert(o, B1, n1, ub, v);
    vert(o, A0, n0, ua, v); vert(o, B1, n1, ub, v); vert(o, B0, n0, ub, v);
  }
}

// A cone from a ring round `a` (radius r, the axis straight up) to `apex`: sides × 3.
function cone(o: Out, a: V3, r: number, apex: number, sides: number, v: number, flat = false) {
  const h = apex - a[2];
  for (let k = 0; k < sides; k++) {
    const t0 = (k / sides) * Math.PI * 2, t1 = ((k + 1) / sides) * Math.PI * 2;
    const n = (t: number): V3 => { const l = Math.hypot(h, r); return flat ? [0, 0, 1] : [Math.cos(t) * h / l, Math.sin(t) * h / l, r / l]; };
    vert(o, [a[0] + Math.cos(t0) * r, a[1] + Math.sin(t0) * r, a[2]], n(t0), 0.5, v);
    vert(o, [a[0] + Math.cos(t1) * r, a[1] + Math.sin(t1) * r, a[2]], n(t1), 0.5, v);
    vert(o, [a[0], a[1], apex], [0, 0, 1], 0.5, v);
  }
}

const row = (r: number) => (r + 0.5) / ROWS;

export const RAILING_VERTS = 4 * TUBE * 6 + 2 * TUBE * 3;
// A railing section from (x1, y1) on ground z1 to (x2, y2) on z2, `h` tall; `along`: m
// of the railing before it, so the bands run on from one section to the next.
export function railingSection(o: Out, x1: number, y1: number, z1: number, x2: number, y2: number, z2: number, h: number, along: number, look: number) {
  const v = row(look === 1 ? 1 : 0), len = Math.hypot(x2 - x1, y2 - y1);
  const u1 = along / STRIPE, u2 = (along + len) / STRIPE;
  for (const [x, y, z, at] of [[x1, y1, z1, along], [x2, y2, z2, along + len]]) {
    // A post is one colour, red and white by turns.
    const u = Math.round(at / RAILING_SECTION) % 2 ? 0.75 : 0.25;
    tube(o, [x, y, z - 0.05], [x, y, z + h + 0.02], 0.03, 0.03, TUBE, u, u, v);
    cone(o, [x, y, z + h + 0.02], 0.03, z + h + 0.025, TUBE, v, true);
  }
  tube(o, [x1, y1, z1 + h - 0.01], [x2, y2, z2 + h - 0.01], 0.03, 0.03, TUBE, u1, u2, v);
  tube(o, [x1, y1, z1 + h * 0.45], [x2, y2, z2 + h * 0.45], 0.024, 0.024, TUBE, u1, u2, v);
}

const CHAIN_LINKS = 8; // pieces of the chain's curve
const LINK = 0.12; // m: one link face on and one edge on
const BOLLARD_VERTS = BOLLARD * 6 * 3 + BOLLARD * 3;
export const CHAIN_VERTS = 2 * BOLLARD_VERTS + CHAIN_LINKS * 2 * 6;
// A chain section: a bollard at each end and the chain between them.
export function chainSection(o: Out, x1: number, y1: number, z1: number, x2: number, y2: number, z2: number, along: number) {
  const iron = row(2), links = row(3);
  for (const [x, y, z] of [[x1, y1, z1], [x2, y2, z2]]) {
    // A tapering shaft, a collar under the top, and a dome.
    tube(o, [x, y, z - 0.05], [x, y, z + 0.6], 0.075, 0.058, BOLLARD, 0, 0.6, iron);
    tube(o, [x, y, z + 0.6], [x, y, z + 0.645], 0.072, 0.072, BOLLARD, 0.6, 0.65, iron);
    tube(o, [x, y, z + 0.645], [x, y, z + 0.705], 0.064, 0.05, BOLLARD, 0.65, 0.7, iron);
    cone(o, [x, y, z + 0.705], 0.05, z + CHAIN_H, BOLLARD, iron);
  }
  // The chain, as two strips crossed along its curve: one standing, the links of every
  // other pair face on to someone beside it, one lying, the rest face on from above.
  const len = Math.hypot(x2 - x1, y2 - y1), dx = (x2 - x1) / (len || 1), dy = (y2 - y1) / (len || 1);
  const hang = 0.56, sag = Math.min(0.16, 0.055 * len), w = 0.02;
  const p = (t: number): V3 => [x1 + (x2 - x1) * t, y1 + (y2 - y1) * t, z1 + (z2 - z1) * t + hang - sag * 4 * t * (1 - t)];
  for (let k = 0; k < CHAIN_LINKS; k++) {
    const t0 = k / CHAIN_LINKS, t1 = (k + 1) / CHAIN_LINKS, a = p(t0), b = p(t1);
    const ua = (along + len * t0) / LINK, ub = (along + len * t1) / LINK;
    const up: V3 = [0, 0, w], side: V3 = [-dy * w, dx * w, 0];
    for (const [off, n, shift] of [[up, [dy, -dx, 0], 0], [side, [0, 0, 1], 0.5]] as [V3, V3, number][]) {
      const A0: V3 = [a[0] - off[0], a[1] - off[1], a[2] - off[2]], A1: V3 = [a[0] + off[0], a[1] + off[1], a[2] + off[2]];
      const B0: V3 = [b[0] - off[0], b[1] - off[1], b[2] - off[2]], B1: V3 = [b[0] + off[0], b[1] + off[1], b[2] + off[2]];
      const lo = links - 0.5 / ROWS * 0.9, hi = links + 0.5 / ROWS * 0.9;
      vert(o, A0, n, ua + shift, lo); vert(o, B0, n, ub + shift, lo); vert(o, B1, n, ub + shift, hi);
      vert(o, A0, n, ua + shift, lo); vert(o, B1, n, ub + shift, hi); vert(o, A1, n, ua + shift, hi);
    }
  }
}

let railMap: THREE.CanvasTexture | null = null;
let chainMap: THREE.CanvasTexture | null = null;

// The paint, one row each from the bottom: red and white bands (a band of each across
// the width, so STRIPE m of railing), anthracite, the bollards' dark green-black cast
// iron, and the chain's links (one face on with the light through it, one edge on).
function ironwork(chain: boolean) {
  const W = 128, R = 16, c = document.createElement('canvas');
  c.width = W; c.height = R * ROWS;
  const g = c.getContext('2d')!;
  const top = (r: number) => (ROWS - 1 - r) * R; // row r from the bottom (the canvas is flipped onto it)
  g.fillStyle = '#b4282b'; g.fillRect(0, top(0), W / 2, R);
  g.fillStyle = '#e9e6dc'; g.fillRect(W / 2, top(0), W / 2, R);
  g.fillStyle = '#9c2427'; g.fillRect(W / 2 - 1, top(0), 2, R); g.fillRect(0, top(0), 1, R);
  g.fillStyle = '#2a2d2f'; g.fillRect(0, top(1), W, R);
  g.fillStyle = '#272b29'; g.fillRect(0, top(2), W, R);
  if (chain) {
    const y = top(3);
    g.strokeStyle = '#3d403f'; g.lineWidth = 3.5;
    g.beginPath(); g.ellipse(W * 0.27, y + R / 2, W * 0.25, R * 0.36, 0, 0, Math.PI * 2); g.stroke();
    g.fillStyle = '#3d403f'; g.fillRect(W * 0.48, y + R / 2 - 2, W * 0.56, 4);
    g.fillStyle = '#6c706e'; g.fillRect(W * 0.5, y + R / 2 - 2, W * 0.5, 1);
  }
  const map = new THREE.CanvasTexture(c);
  map.wrapS = THREE.RepeatWrapping;
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 4;
  return map;
}

export function railingMaterial() {
  railMap ??= ironwork(false);
  return new THREE.MeshLambertMaterial({ map: railMap });
}

export function chainMaterial() {
  chainMap ??= ironwork(true);
  return new THREE.MeshLambertMaterial({ map: chainMap, alphaTest: 0.5, side: THREE.DoubleSide });
}
