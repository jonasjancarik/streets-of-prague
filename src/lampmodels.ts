import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// Prague's street lamps as small models, drawn instanced (lamps.ts). Each is built
// facing +X, that being the way its arm points, towards the street; y is up, metres.
// Colours are in the vertices, so one material serves them all.
//
// From photographs: the Old Town's gas lamps stand in dark green cast iron, a fluted
// post with an acorn knob and, at the top, one or two hexagonal glass lanterns with a
// pointed cap and a finial, the pair on arms with scrolled brackets. Smaller single
// lanterns sit on shorter posts and on wall brackets. The everyday street lamp is a
// tapering grey steel pole with a curved arm reaching over the road and a flat "cobra"
// head; parks and squares have a round opal globe on a slim post.

const IRON = '#1f342b', IRON_LIGHT = '#2b4438', GLASS = '#a9bbb2', STEEL = '#6d7274', STEEL_DARK = '#4a4e50';
const HEAD_GREY = '#8a8e8f', LENS = '#d9d6c8', OPAL = '#e8e4d6';

type Part = THREE.BufferGeometry;
const part = (g: Part, colour: string, at: [number, number, number] = [0, 0, 0], scale?: [number, number, number], rotate?: [number, number, number]) => {
  if (scale) g.scale(...scale);
  if (rotate) { g.rotateX(rotate[0]); g.rotateY(rotate[1]); g.rotateZ(rotate[2]); }
  g.translate(...at);
  const c = new THREE.Color(colour), n = g.getAttribute('position').count, col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g.index ? g.toNonIndexed() : g;
};
const merge = (parts: Part[]) => {
  const g = mergeGeometries(parts.map((p) => { p.deleteAttribute('uv'); return p; }), false);
  parts.forEach((p) => p.dispose());
  return g;
};
const cyl = (rt: number, rb: number, h: number, seg = 8) => new THREE.CylinderGeometry(rt, rb, h, seg);
const box = (x: number, y: number, z: number) => new THREE.BoxGeometry(x, y, z);
const ball = (r: number) => new THREE.SphereGeometry(r, 8, 6);

// A hexagonal glass lantern standing on `y`, its middle over (x, z): a base, six corner
// bars round glass, a cap and a finial. `s` scales the whole.
function lantern(x: number, y: number, z: number, s = 1): Part[] {
  const out: Part[] = [];
  const h = 0.5 * s, rb = 0.115 * s, rt = 0.165 * s;
  out.push(part(cyl(rb * 1.1, rb * 0.8, 0.05 * s, 6), IRON, [x, y + 0.025 * s, z]));
  out.push(part(cyl(rt, rb, h, 6), GLASS, [x, y + 0.05 * s + h / 2, z]));
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2, f = 0.98;
    const bx = Math.cos(a), bz = Math.sin(a);
    // The corner bar leans from the narrow base to the wide top.
    const bar = box(0.014 * s, h, 0.014 * s);
    bar.rotateZ(Math.atan2(rt - rb, h) * -Math.sign(bx));
    out.push(part(bar, IRON, [x + bx * (rb + rt) / 2 * f, y + 0.05 * s + h / 2, z + bz * (rb + rt) / 2 * f]));
  }
  out.push(part(cyl(rt * 1.25, rt * 1.05, 0.04 * s, 6), IRON, [x, y + 0.07 * s + h, z]));
  out.push(part(new THREE.ConeGeometry(rt * 1.2, 0.17 * s, 6), IRON, [x, y + 0.175 * s + h, z]));
  out.push(part(cyl(0.02 * s, 0.03 * s, 0.05 * s, 6), IRON, [x, y + 0.29 * s + h, z]));
  out.push(part(ball(0.022 * s), IRON, [x, y + 0.33 * s + h, z]));
  return out;
}

// A strut under an arm, from the post out to the arm's end (the arm along +z).
function strut(top: number, reach: number, flip: number): Part {
  const drop = 0.32, len = Math.hypot(reach, drop), g = box(0.03, 0.03, len);
  g.rotateX(flip * Math.atan2(drop, reach));
  return part(g, IRON_LIGHT, [0, top - drop / 2, flip * reach / 2]);
}

// The post of a cast-iron gas lamp up to `top`: plinth, fluted shaft with collars,
// and the acorn knob.
function ironPost(top: number, r = 0.075): Part[] {
  const out: Part[] = [];
  out.push(part(cyl(0.2, 0.24, 0.16, 8), IRON, [0, 0.08, 0]));
  out.push(part(cyl(0.15, 0.2, 0.42, 8), IRON, [0, 0.37, 0]));
  out.push(part(cyl(0.1, 0.13, 0.08, 8), IRON_LIGHT, [0, 0.62, 0]));
  out.push(part(cyl(r * 0.9, r * 1.2, top - 0.6, 12), IRON, [0, (top + 0.6) / 2, 0]));
  out.push(part(cyl(0.1, 0.1, 0.05, 8), IRON_LIGHT, [0, top - 0.55, 0]));
  out.push(part(cyl(0.085, 0.085, 0.04, 8), IRON_LIGHT, [0, top - 0.1, 0]));
  return out;
}

// Two lanterns on arms across the top of an iron post (the arms lie along z, over the
// street's edge). Light at the lanterns' middles.
export function gasPair(): Part {
  const top = 3.3, out = ironPost(top);
  out.push(part(new THREE.CapsuleGeometry(0.05, 0.06, 2, 6), IRON, [0, top + 0.06, 0]));
  out.push(part(ball(0.07), IRON, [0, top + 0.19, 0], [0.85, 1.25, 0.85]));
  out.push(part(box(0.13, 0.18, 0.1), IRON_LIGHT, [0, top - 0.02, 0]));
  out.push(part(box(0.04, 0.05, 1.3), IRON, [0, top + 0.03, 0]));
  for (const f of [-1, 1]) {
    out.push(strut(top, 0.6, f));
    out.push(...lantern(0, top + 0.05, 0.6 * f, 1.2));
    out.push(part(cyl(0.02, 0.02, 0.1, 6), IRON, [0, top + 0.02, 0.6 * f]));
  }
  return merge(out);
}

// A single lantern on a shorter iron post, the lantern above the post's head.
export function gasSingle(): Part {
  const top = 3.0, out = ironPost(top, 0.06);
  out.push(part(ball(0.06), IRON_LIGHT, [0, top + 0.02, 0], [1.2, 0.9, 1.2]));
  out.push(part(cyl(0.05, 0.08, 0.09, 8), IRON, [0, top + 0.09, 0]));
  out.push(...lantern(0, top + 0.13, 0, 1.3));
  return merge(out);
}

// A lantern on a slim iron post standing on a bridge's parapet (its top `lift` m up), as
// on Charles Bridge. Light at the lantern's middle, `lift` + 3.1 m up.
export function parapetLantern(lift: number): Part {
  const top = 2.6, out: Part[] = [];
  out.push(part(cyl(0.13, 0.15, 0.12, 8), IRON, [0, 0.06, 0]));
  out.push(part(cyl(0.08, 0.11, 0.5, 8), IRON, [0, 0.37, 0]));
  out.push(part(cyl(0.05, 0.065, top - 0.6, 10), IRON, [0, (top + 0.6) / 2, 0]));
  out.push(part(cyl(0.085, 0.085, 0.04, 8), IRON_LIGHT, [0, top - 0.1, 0]));
  out.push(part(cyl(0.05, 0.08, 0.09, 8), IRON, [0, top + 0.04, 0]));
  out.push(...lantern(0, top + 0.08, 0, 1.4));
  out.forEach((p) => p.translate(0, lift, 0));
  return merge(out);
}

// A lantern on a scrolled bracket sticking out of a wall (the wall at x = 0), 4.5 m up.
export function wallLantern(): Part {
  const out: Part[] = [];
  out.push(part(box(0.05, 0.4, 0.12), IRON, [0.025, 0, 0]));
  out.push(part(box(0.55, 0.035, 0.035), IRON, [0.3, 0.06, 0]));
  const brace = box(0.4, 0.03, 0.03);
  brace.rotateZ(Math.PI / 4);
  out.push(part(brace, IRON_LIGHT, [0.2, -0.12, 0]));
  out.push(part(cyl(0.02, 0.02, 0.12, 6), IRON, [0.55, 0.12, 0]));
  out.push(...lantern(0.55, 0.18, 0, 1.2));
  out.forEach((p) => p.translate(0, 4.2, 0));
  return merge(out);
}

// The everyday street lamp: a tapering steel pole, a curved arm and a flat lamp head
// over the road (the head near x = 1.6). `h` is the pole's height.
export function armLamp(h: number): Part {
  const out: Part[] = [];
  out.push(part(cyl(0.075, 0.11, 0.55, 8), STEEL_DARK, [0, 0.275, 0]));
  out.push(part(cyl(0.055, 0.095, h - 0.5, 8), STEEL, [0, 0.5 + (h - 0.5) / 2, 0]));
  // The arm: up and over in three pieces.
  const seg = (ax: number, ay: number, bx: number, by: number) => {
    const len = Math.hypot(bx - ax, by - ay), g = cyl(0.035, 0.04, len, 6);
    g.rotateZ(-Math.atan2(bx - ax, by - ay));
    return part(g, STEEL, [(ax + bx) / 2, (ay + by) / 2, 0]);
  };
  out.push(seg(0, h - 0.15, 0.35, h + 0.2), seg(0.35, h + 0.2, 0.95, h + 0.32), seg(0.95, h + 0.32, 1.45, h + 0.28));
  // The head: a shallow shell (a squashed ball) with its lens beneath, fitted to the arm.
  out.push(part(ball(0.5), HEAD_GREY, [1.65, h + 0.26, 0], [0.7, 0.2, 0.34]));
  out.push(part(cyl(0.3, 0.3, 0.04, 10), LENS, [1.68, h + 0.16, 0], [1, 1, 0.75]));
  return merge(out);
}

// A slim post ending in a round opal globe (what parks and squares have), the globe's
// middle at `h`.
export function globeLamp(h: number): Part {
  const out: Part[] = [];
  out.push(part(cyl(0.11, 0.14, 0.4, 8), STEEL_DARK, [0, 0.2, 0]));
  out.push(part(cyl(0.05, 0.08, h - 0.5, 8), STEEL, [0, 0.4 + (h - 0.5) / 2, 0]));
  out.push(part(cyl(0.11, 0.05, 0.1, 8), STEEL_DARK, [0, h - 0.27, 0]));
  out.push(part(ball(0.27), OPAL, [0, h, 0]));
  out.push(part(cyl(0.12, 0.2, 0.05, 8), STEEL_DARK, [0, h + 0.25, 0]));
  return merge(out);
}

// What hangs from the cables over a side street (its top at `h` + 0.1): a shade over
// a lens.
export function hungLamp(h: number): Part {
  const out: Part[] = [];
  out.push(part(cyl(0.012, 0.012, 0.3, 4), STEEL_DARK, [0, h + 0.2, 0]));
  out.push(part(new THREE.ConeGeometry(0.34, 0.16, 10), HEAD_GREY, [0, h + 0.03, 0]));
  out.push(part(cyl(0.2, 0.2, 0.03, 10), LENS, [0, h - 0.06, 0]));
  return merge(out);
}
