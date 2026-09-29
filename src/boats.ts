import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { clamp } from './network.ts';
import type { Point2 } from './map/geo.ts';

// Boats on the Vltava: a few white tourist cruise boats going slowly up and down the
// river, and pedal boats (some of them swans) paddling about round the islands. The
// river is only a ground layer, so the water polygons of the loaded tiles are the
// area they can move in: each boat looks ahead along its course and turns towards
// the side with more open water. Where nothing is loaded they don't go (it doesn't
// count as water), and one that falls far behind the player is taken away and put
// back on the water nearer you. They keep to the water's height, so they pass under
// bridges (which are levels of their own).

export interface Waters {
  waterAt: (x: number, y: number) => boolean | null;
  terrainAt: (x: number, y: number) => number;
}

type Kind = 'cruise' | 'pedal' | 'swan';
interface Spec { len: number; beam: number; speed: number; turn: number; look: number; bob: number }
const SPECS: Record<Kind, Spec> = {
  cruise: { len: 34, beam: 6.4, speed: 2.6, turn: 0.1, look: 45, bob: 0.05 },
  pedal: { len: 3.2, beam: 1.8, speed: 0.8, turn: 0.45, look: 7, bob: 0.07 },
  swan: { len: 3.4, beam: 1.9, speed: 0.7, turn: 0.4, look: 7, bob: 0.07 },
};
const CRUISE = 4, PEDALS = 9;
const NEAR = 60, SPAWN = 420, FAR = 700; // m from the player: where boats are put, and taken away
const ISLANDS = 520; // pedal boats keep within this many metres of Slovanský ostrov
const PAINTS = ['#e8c534', '#d8402f', '#2f7fc4', '#3aa55a', '#f08a2c'];

interface Boat {
  kind: Kind; s: Spec; mesh: THREE.Mesh; live: boolean;
  x: number; y: number; h: number; v: number; w: number; phase: number; wander: number; side: number;
  next: number; turn: number; ahead: number; // when to look round again, and what it found
}

// Boxes and extrusions with a colour per vertex, merged into one body. Forward is +x,
// right +z, the waterline y = 0, as for the cars.
function body(kind: Kind, paint: string) {
  const parts: THREE.BufferGeometry[] = [];
  const colour = (g: THREE.BufferGeometry, color: string) => {
    const c = new THREE.Color(color), n = g.attributes.position.count, col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.deleteAttribute('uv');
    g.deleteAttribute('normal');
    parts.push(g.index ? g.toNonIndexed() : g);
  };
  const box = (sx: number, sy: number, sz: number, x: number, y: number, z: number, color: string) =>
    colour(new THREE.BoxGeometry(sx, sy, sz).translate(x, y, z), color);
  // A hull seen from above: square stern, pointed bow, `len` by `beam`, from y0 to y1.
  const hull = (len: number, beam: number, bow: number, y0: number, y1: number, color: string, z = 0) => {
    const s = new THREE.Shape(), l = len / 2, b = beam / 2;
    s.moveTo(-l, -b * 0.9);
    s.lineTo(l - bow, -b);
    s.quadraticCurveTo(l - bow * 0.2, -b * 0.7, l, 0);
    s.quadraticCurveTo(l - bow * 0.2, b * 0.7, l - bow, b);
    s.lineTo(-l, b * 0.9);
    s.closePath();
    const g = new THREE.ExtrudeGeometry(s, { depth: y1 - y0, bevelEnabled: false, curveSegments: 5 });
    g.rotateX(-Math.PI / 2).translate(0, y0, z);
    colour(g, color);
  };
  const ball = (sx: number, sy: number, sz: number, x: number, y: number, z: number, color: string) => {
    colour(new THREE.SphereGeometry(1, 10, 7).scale(sx, sy, sz).translate(x, y, z), color);
  };
  if (kind === 'cruise') {
    const L = SPECS.cruise.len, B = SPECS.cruise.beam;
    hull(L, B, 7, -0.4, 0.5, '#1f3550');
    hull(L, B, 7, 0.5, 1.5, '#f2f1ec');
    hull(L - 0.7, B - 0.7, 6.6, 1.5, 1.56, '#a9855a'); // wooden deck fore and aft
    box(L * 0.64, 2.3, B - 1, -2, 2.65, 0, '#f4f3ee'); // the cabin
    box(L * 0.62, 1.05, B - 0.94, -2, 2.75, 0, '#27343f'); // its windows all round
    box(L * 0.68, 0.14, B - 0.6, -2, 3.85, 0, '#7f98a8'); // the roof deck
    box(L * 0.66, 0.5, 0.06, -2, 4.15, (B - 0.7) / 2, '#c9c7bf'); // railings along it
    box(L * 0.66, 0.5, 0.06, -2, 4.15, -(B - 0.7) / 2, '#c9c7bf');
    box(4.2, 1.7, 3.4, 9.6, 2.35, 0, '#f4f3ee'); // the wheelhouse forward
    box(0.1, 0.8, 3.0, 11.7, 2.55, 0, '#27343f');
    box(0.8, 0.2, 5.2, -2 - L * 0.32 + 0.5, 1.55, 0, '#8a2b2b'); // a red stripe at the stern
    for (let i = 0; i < 6; i++) box(1.2, 0.08, 0.5, -12 + i * 3.6, 4.0, 0, '#3d6f9a'); // benches up top
  } else {
    const S = SPECS[kind];
    // Two floats and a deck between them, a seat and a sunshade.
    for (const z of [-0.6, 0.6]) hull(S.len, 0.6, 0.8, -0.15, 0.35, kind === 'swan' ? '#f4f4f0' : paint, z);
    box(S.len * 0.8, 0.12, S.beam - 0.2, -0.1, 0.4, 0, '#e9e6de');
    box(0.7, 0.45, S.beam - 0.5, -0.4, 0.68, 0, '#3c4046');
    if (kind === 'pedal') {
      for (const z of [-0.7, 0.7]) box(0.06, 1.2, 0.06, -0.6, 1.0, z, '#9a9a96');
      box(1.4, 0.06, S.beam - 0.1, -0.5, 1.6, 0, paint);
    } else {
      ball(1.25, 0.7, 0.95, -0.2, 0.75, 0, '#fbfbf7'); // the swan's body round the seat
      ball(0.7, 0.35, 0.18, -0.4, 1.0, 0.85, '#efefe9'); // wings
      ball(0.7, 0.35, 0.18, -0.4, 1.0, -0.85, '#efefe9');
      const neck = new THREE.CylinderGeometry(0.13, 0.2, 1.6, 8).translate(0, 0.8, 0).rotateZ(-0.35).translate(1.1, 0.8, 0);
      colour(neck, '#fbfbf7');
      ball(0.24, 0.22, 0.2, 1.72, 2.25, 0, '#fbfbf7'); // head
      box(0.34, 0.1, 0.12, 1.98, 2.2, 0, '#e07a1f'); // beak
      box(0.1, 0.12, 0.26, 1.72, 2.28, 0, '#1b1b1b'); // eyes
    }
  }
  const g = mergeGeometries(parts)!;
  g.computeVertexNormals();
  return g;
}

// Their own random numbers, so the rest of the world's don't change with the boats.
function seededRandom(seed: number) {
  let s = seed;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

export class Boats {
  scene: THREE.Scene;
  water: Waters;
  islands: Point2 | null;
  list: Boat[];
  rng: () => number;

  // `islands`: where Slovanský ostrov is in local metres (null if not in the area).
  constructor(scene: THREE.Scene, water: Waters, islands: Point2 | null, rng = seededRandom(7)) {
    this.scene = scene;
    this.water = water;
    this.islands = islands;
    this.rng = rng;
    this.list = [];
    const material = new THREE.MeshLambertMaterial({ vertexColors: true });
    const geometries = new Map<string, THREE.BufferGeometry>();
    const add = (kind: Kind, paint: string) => {
      const k = `${kind}|${paint}`;
      if (!geometries.has(k)) geometries.set(k, body(kind, paint));
      const mesh = new THREE.Mesh(geometries.get(k), material);
      mesh.castShadow = true;
      mesh.visible = false;
      mesh.matrixAutoUpdate = false;
      scene.add(mesh);
      this.list.push({ kind, s: SPECS[kind], mesh, live: false, x: 0, y: 0, h: 0, v: 0, w: 0, phase: rng() * 10, wander: 0, side: 1, next: 0, turn: 0, ahead: 1 });
    };
    for (let i = 0; i < CRUISE; i++) add('cruise', '');
    if (islands) for (let i = 0; i < PEDALS; i++) i % 3 === 2 ? add('swan', '') : add('pedal', PAINTS[i % PAINTS.length]);
  }

  // Open water here, for this boat: loaded, on the river, and (for pedal boats) near
  // the islands.
  wet(b: Boat, x: number, y: number) {
    if (b.kind !== 'cruise' && this.islands && Math.hypot(x - this.islands[0], y - this.islands[1]) > ISLANDS) return false;
    return this.water.waterAt(x, y) === true;
  }

  // The whole boat is on water at this spot and heading.
  fits(b: Boat, x: number, y: number, h: number) {
    const c = Math.cos(h), s = Math.sin(h), l = b.s.len / 2 + 1, w = b.s.beam / 2 + 0.5;
    for (const [f, r] of [[l, 0], [-l, w], [-l, -w], [0, w], [0, -w], [l * 0.6, w * 0.6], [l * 0.6, -w * 0.6]]) {
      if (!this.wet(b, x + c * f + s * r, y + s * f - c * r)) return false;
    }
    return true;
  }

  // How far the water goes from a point in a direction, looking up to `max` metres.
  run(b: Boat, x: number, y: number, a: number, max: number) {
    const c = Math.cos(a), s = Math.sin(a), step = max / 6;
    for (let d = step; d <= max; d += step) if (!this.wet(b, x + c * d, y + s * d)) return d - step;
    return max;
  }

  // Try to put a boat on the water somewhere near the player: a few random spots a
  // frame, pointing the way the water is longest.
  place(b: Boat, px: number, py: number) {
    for (let k = 0; k < 4; k++) {
      let x: number, y: number;
      if (b.kind === 'cruise') {
        const a = this.rng() * Math.PI * 2, d = NEAR + this.rng() * (SPAWN - NEAR);
        x = px + Math.cos(a) * d; y = py + Math.sin(a) * d;
      } else {
        const a = this.rng() * Math.PI * 2, d = this.rng() * ISLANDS;
        x = this.islands![0] + Math.cos(a) * d; y = this.islands![1] + Math.sin(a) * d;
        if (Math.hypot(x - px, y - py) > SPAWN) continue;
      }
      if (!this.wet(b, x, y)) continue;
      let best = -1, h = 0;
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2, r = this.run(b, x, y, a, b.s.look * 2) + this.run(b, x, y, a + Math.PI, b.s.look * 2) * 0.5;
        if (r > best) { best = r; h = a; }
      }
      // Cruise boats keep to the main river, not the narrow arms round the islands.
      if (b.kind === 'cruise' && this.run(b, x, y, h + Math.PI / 2, 60) + this.run(b, x, y, h - Math.PI / 2, 60) < 70) continue;
      if (!this.fits(b, x, y, h) || this.list.some((o) => o !== b && o.live && Math.hypot(o.x - x, o.y - y) < (o.s.len + b.s.len) / 2 + 8)) continue;
      Object.assign(b, { x, y, h, v: 0, w: 0, next: 0, live: true, wander: this.rng() * 2 - 1, side: this.rng() < 0.5 ? -1 : 1 });
      b.mesh.visible = true;
      return;
    }
  }

  update(dt: number, px: number, py: number) {
    let placed = false;
    for (const b of this.list) {
      if (b.live && Math.hypot(b.x - px, b.y - py) > FAR) { b.live = false; b.mesh.visible = false; }
      if (!b.live) {
        if (!placed) { this.place(b, px, py); placed = true; }
        continue;
      }
      this.steer(b, dt);
    }
    // Boats keep clear of each other: a gentle push apart where two overlap.
    for (let i = 0; i < this.list.length; i++) {
      const a = this.list[i];
      if (!a.live) continue;
      for (let j = i + 1; j < this.list.length; j++) {
        const b = this.list[j];
        if (!b.live) continue;
        const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1;
        const r = (a.kind === 'cruise' ? a.s.len * 0.4 : a.s.len * 0.5) + (b.kind === 'cruise' ? b.s.len * 0.4 : b.s.len * 0.5);
        if (d >= r) continue;
        const push = Math.min(r - d, 1) * dt * 2, ma = a.s.len, mb = b.s.len;
        const ax = a.x - (dx / d) * push * mb / (ma + mb), ay = a.y - (dy / d) * push * mb / (ma + mb);
        const bx = b.x + (dx / d) * push * ma / (ma + mb), by = b.y + (dy / d) * push * ma / (ma + mb);
        if (this.fits(a, ax, ay, a.h)) { a.x = ax; a.y = ay; }
        if (this.fits(b, bx, by, b.h)) { b.x = bx; b.y = by; }
      }
    }
    for (const b of this.list) if (b.live) this.pose(b, dt);
  }

  // Look ahead and to both sides; head for open water, slow down near the bank, and
  // turn round where it closes in.
  steer(b: Boat, dt: number) {
    const S = b.s, look = S.look + S.len / 2;
    // (A look round a few times a second is plenty at these speeds.)
    b.next -= dt;
    if (b.next <= 0) {
      b.next = 0.3;
      const ahead = this.run(b, b.x, b.y, b.h, look);
      const left = this.run(b, b.x, b.y, b.h + 0.45, look), right = this.run(b, b.x, b.y, b.h - 0.45, look);
      b.wander = clamp(b.wander + (this.rng() - 0.5) * 0.3, -1, 1);
      if (ahead >= look && left >= look * 0.8 && right >= look * 0.8) b.turn = b.wander * (b.kind === 'cruise' ? 0.1 : 0.6);
      else if (Math.abs(left - right) > S.len * 0.05) b.turn = left > right ? 1 : -1;
      else b.turn = b.side; // straight at the bank: keep turning one way until clear
      if (ahead < look * 0.5) b.side = left >= right ? 1 : -1;
      b.ahead = ahead / look;
    }
    b.w += (b.turn * S.turn - b.w) * Math.min(1, dt * 1.5);
    const want = S.speed * clamp(b.ahead, 0.15, 1);
    b.v += clamp(want - b.v, -0.5 * dt, 0.3 * dt);
    const h = b.h + b.w * dt;
    const x = b.x + Math.cos(h) * b.v * dt, y = b.y + Math.sin(h) * b.v * dt;
    if (this.fits(b, x, y, h)) { b.x = x; b.y = y; b.h = h; }
    else if (this.fits(b, b.x, b.y, h)) { b.h = h; b.v *= 0.5; }
    else b.v = 0;
  }

  pose(b: Boat, dt: number) {
    b.phase += dt;
    const t = b.phase, A = b.s.bob;
    const m = b.mesh;
    // The lowest of bow, middle and stern: the ground by the banks can bulge up over the water.
    const c = Math.cos(b.h) * b.s.len * 0.4, s = Math.sin(b.h) * b.s.len * 0.4, T = this.water;
    const y = Math.min(T.terrainAt(b.x, b.y), T.terrainAt(b.x + c, b.y + s), T.terrainAt(b.x - c, b.y - s));
    m.position.set(b.x, y + A * Math.sin(t * 1.4), -b.y);
    m.rotation.set(A * 0.6 * Math.sin(t * 1.1 + 1), b.h, A * 0.4 * Math.sin(t * 0.9 + 2), 'YXZ');
    m.updateMatrix();
  }
}
