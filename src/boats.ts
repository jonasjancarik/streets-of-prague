import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { clamp } from './network.ts';
import { lampLit } from './lamps.ts';
import { fences } from './fences.ts';
import type { Point2 } from './map/geo.ts';
import { Course } from './river.ts';
import type { Reach } from './river.ts';

// Boats on the Vltava: a few white tourist cruise boats going slowly up and down the
// river, and pedal boats (some of them swans) paddling about round the islands. The
// river is only a ground layer, so the water polygons of the loaded tiles are the
// area they can move in: each boat looks ahead along its course and turns towards
// the side with more open water. Where nothing is loaded they don't go (it doesn't
// count as water), and one that falls far behind the player is taken away and put
// back on the water nearer you. They keep to the water's height, so they pass under
// bridges (which are levels of their own).
//
// Where the area has a fairway (river.json, see river.ts), the cruise boats follow it
// instead: up and down the navigable channel, keeping to the right of its middle
// where there's room, round the islands on the side with water enough and past each
// weir through its lock. Two don't meet in a lock or its canal: the one still in wide
// water waits there. At the end of a stretch they turn round. The water's height
// changes at a lock, and a boat rises or sinks there at a lock's pace, not in a jump.

export interface Waters {
  waterAt: (x: number, y: number) => boolean | null;
  terrainAt: (x: number, y: number, onWater?: boolean) => number;
  cellAt: (x: number, y: number, level: number, z: number) => number;
}

type Kind = 'cruise' | 'pedal' | 'swan' | 'ferry'; // (the ferries are run by ferries.ts)
interface Spec { len: number; beam: number; speed: number; turn: number; look: number; bob: number; top: number }
const SPECS: Record<Kind, Spec> = {
  cruise: { len: 34, beam: 6.4, speed: 2.6, turn: 0.1, look: 45, bob: 0.05, top: 3.95 },
  pedal: { len: 3.2, beam: 1.8, speed: 0.8, turn: 0.45, look: 7, bob: 0.07, top: 2.1 },
  swan: { len: 3.4, beam: 1.9, speed: 0.7, turn: 0.4, look: 7, bob: 0.07, top: 2.4 },
  ferry: { len: 11, beam: 3.8, speed: 2.4, turn: 0.3, look: 15, bob: 0.05, top: 3.9 },
};
const CRUISE = 4, PEDALS = 9;
const NEAR = 60, SPAWN = 420, FAR = 700; // m from the player: where boats are put, and taken away
const MOORED = 3; // pedal boats tied up at the bank
const ISLANDS = 520; // pedal boats keep within this many metres of Slovanský ostrov
const PAINTS = ['#e8c534', '#d8402f', '#2f7fc4', '#3aa55a', '#f08a2c'];
// How high each kind stands over the water (the top of its mast, lamp or head), for
// the bridges it must pass under (scripts/check-river.mjs).
export const BOAT_TOP: Record<Kind, number> = { cruise: SPECS.cruise.top, pedal: SPECS.pedal.top, swan: SPECS.swan.top, ferry: SPECS.ferry.top };
export const FERRY = SPECS.ferry;
const KEEP_RIGHT = 14; // m to the right of the fairway's middle, where the water is wide enough
const BANK = 4; // m a cruise boat's side keeps from the bank
const NARROW = 14; // m to the bank: under this the fairway is a canal or a lock, for one boat at a time
const TURNING = 22; // m to the bank a cruise boat needs to turn round on the spot
const RISE = 0.3; // m/s: how fast a boat rises or sinks where the water's height changes
const BOARD_REACH = 4.5, BOARD_STEP = 0.8; // a short step between a low bank and the deck

interface Boat {
  kind: Kind; s: Spec; mesh: THREE.Mesh; live: boolean;
  x: number; y: number; h: number; v: number; w: number; phase: number; wander: number; side: number;
  next: number; turn: number; ahead: number; // when to look round again, and what it found
  moored: boolean; // tied up at the bank, waiting to be taken
  course: Course | null; along: number; dir: number; // on the fairway: which stretch, how far along it, and which way (1 or -1)
  about: number; // radians still to turn, turning round at the end of a stretch
  z: number | null; // the height it floats at (null: not yet on the water)
}

// Boxes and extrusions with a colour per vertex, merged into one body. Forward is +x,
// right +z, the waterline y = 0, as for the cars. `glow` marks what shines at night:
// 1 the cabin windows (lit from inside), 2 the navigation lights (their own colour).
export function body(kind: Kind, paint: string) {
  const parts: THREE.BufferGeometry[] = [];
  const colour = (g: THREE.BufferGeometry, color: string, glow = 0) => {
    const c = new THREE.Color(color), n = g.attributes.position.count, col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('glow', new THREE.BufferAttribute(new Float32Array(n).fill(glow), 1));
    g.deleteAttribute('uv');
    g.deleteAttribute('normal');
    parts.push(g.index ? g.toNonIndexed() : g);
  };
  const box = (sx: number, sy: number, sz: number, x: number, y: number, z: number, color: string, glow = 0) =>
    colour(new THREE.BoxGeometry(sx, sy, sz).translate(x, y, z), color, glow);
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
    box(L * 0.64, 1.85, B - 1, -2, 2.42, 0, '#f4f3ee'); // the cabin (low, like the boats that fit under Prague's bridges)
    box(L * 0.62, 0.95, B - 0.3, -2, 2.55, 0, '#27343f', 1); // its windows all round (a little proud of the roof, so they show from above)
    box(L * 0.68, 0.14, B - 0.6, -2, 3.4, 0, '#7f98a8'); // the roof deck
    box(L * 0.66, 0.5, 0.06, -2, 3.7, (B - 0.7) / 2, '#c9c7bf'); // railings along it
    box(L * 0.66, 0.5, 0.06, -2, 3.7, -(B - 0.7) / 2, '#c9c7bf');
    box(4.2, 1.7, 3.4, 9.6, 2.35, 0, '#f4f3ee'); // the wheelhouse forward
    box(0.1, 0.8, 3.0, 11.7, 2.55, 0, '#27343f');
    // Navigation lights: red to port (left), green to starboard, white on a stub of a mast.
    box(0.5, 0.35, 0.12, 9.9, 2.9, -1.76, '#ff1a10', 2);
    box(0.5, 0.35, 0.12, 9.9, 2.9, 1.76, '#10ff40', 2);
    box(0.08, 0.4, 0.08, 10.4, 3.4, 0, '#c9c7bf');
    box(0.45, 0.3, 0.45, 10.4, 3.75, 0, '#ffffff', 2);
    box(0.3, 0.3, 0.3, -2 - L * 0.32 + 0.3, 2.0, 0, '#ffffff', 2); // and one at the stern
    box(0.8, 0.2, 5.2, -2 - L * 0.32 + 0.5, 1.55, 0, '#8a2b2b'); // a red stripe at the stern
    for (let i = 0; i < 6; i++) box(1.2, 0.08, 0.5, -12 + i * 3.6, 3.55, 0, '#3d6f9a'); // benches up top
  } else if (kind === 'ferry') {
    // PID's little ferry: a dark hull with a band in the line's colour, an open deck
    // forward under an awning, the cabin and wheelhouse aft.
    const L = SPECS.ferry.len, B = SPECS.ferry.beam;
    hull(L, B, 2.6, -0.35, 0.45, '#1f3550');
    hull(L, B, 2.6, 0.45, 0.8, paint);
    hull(L, B, 2.6, 0.8, 1.05, '#f2f1ec');
    hull(L - 0.5, B - 0.5, 2.4, 1.05, 1.1, '#8d9296'); // the deck
    box(3.6, 1.9, B - 0.7, -2.6, 2.05, 0, '#f4f3ee'); // the cabin
    box(3.4, 0.8, B - 0.5, -2.6, 2.3, 0, '#27343f', 1); // its windows
    box(3.9, 0.12, B - 0.4, -2.6, 3.06, 0, '#e9e6de');
    for (const z of [-(B / 2 - 0.35), B / 2 - 0.35]) {
      for (const x of [-0.4, 1.6, 3.2]) box(0.07, 1.9, 0.07, x, 2.05, z, '#c9c7bf'); // the awning's posts
      box(4.0, 0.06, 0.06, 1.4, 2.0, z, '#c9c7bf'); // and a rail along each side
    }
    box(4.2, 0.08, B - 0.5, 1.4, 3.02, 0, paint); // the awning
    box(1.6, 0.3, 0.5, 1.2, 1.4, -0.9, '#6f5a43'); // benches
    box(1.6, 0.3, 0.5, 1.2, 1.4, 0.9, '#6f5a43');
    box(0.4, 0.3, 0.1, -1.0, 2.8, -(B / 2 - 0.3), '#ff1a10', 2);
    box(0.4, 0.3, 0.1, -1.0, 2.8, B / 2 - 0.3, '#10ff40', 2);
    box(0.07, 0.7, 0.07, -2.6, 3.45, 0, '#c9c7bf');
    box(0.3, 0.25, 0.3, -2.6, 3.8, 0, '#ffffff', 2);
  } else {
    const S = SPECS[kind];
    // Two floats and a deck between them, a seat and a sunshade.
    for (const z of [-0.6, 0.6]) hull(S.len, 0.6, 0.8, -0.15, 0.35, kind === 'swan' ? '#f4f4f0' : paint, z);
    box(S.len * 0.8, 0.12, S.beam - 0.2, -0.1, 0.4, 0, '#e9e6de');
    box(0.7, 0.45, S.beam - 0.5, -0.4, 0.68, 0, '#3c4046');
    // A small all-round white lamp, merged into the body: no extra light or draw call.
    const lampX = kind === 'pedal' ? -0.6 : -1.3, lampY = kind === 'pedal' ? 2 : 1.25;
    box(0.06, 0.35, 0.06, lampX, lampY - 0.23, 0, '#9a9a96');
    box(0.18, 0.16, 0.18, lampX, lampY, 0, '#ffffff', 2);
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

// One material for every boat (the ferries too).
let shared: THREE.MeshLambertMaterial | null = null;
export function boatMaterial() {
  if (shared) return shared;
  shared = new THREE.MeshLambertMaterial({ vertexColors: true });
  const material = shared;
  // Cabin windows and navigation lamps shine with the street lamps' night switch;
  // their light falls on the boats too. Small boats carry an all-round white lamp.
  material.onBeforeCompile = (sh) => {
    lampLit(sh);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', 'attribute float glow;\nvarying float vGlow;\n#include <common>')
      .replace('#include <color_vertex>', '#include <color_vertex>\nvGlow = glow;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', 'varying float vGlow;\n#include <common>')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
  if (vGlow > .5 && uLampOn > .005) totalEmissiveRadiance += (vGlow > 1.5 ? vColor.rgb * 1.6 : vec3(1., .86, .62) * .6) * uLampOn;`);
  };
  material.customProgramCacheKey = () => 'boats';
  return material;
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
  me: Boat | null = null; // the pedal boat the player is in
  courses: Course[];
  private placeNext = 0;

  // `islands`: where Slovanský ostrov is in local metres (null if not in the area).
  // `fairway`: the stretches the cruise boats sail (none: they wander on open water).
  constructor(scene: THREE.Scene, water: Waters, islands: Point2 | null, rng = seededRandom(7), fairway: Reach[] = []) {
    this.courses = fairway.map((r) => new Course(r.pts));
    this.scene = scene;
    this.water = water;
    this.islands = islands;
    this.rng = rng;
    this.list = [];
    const material = boatMaterial();
    const geometries = new Map<string, THREE.BufferGeometry>();
    const add = (kind: Kind, paint: string) => {
      const k = `${kind}|${paint}`;
      if (!geometries.has(k)) geometries.set(k, body(kind, paint));
      const mesh = new THREE.Mesh(geometries.get(k), material);
      mesh.castShadow = true;
      mesh.visible = false;
      mesh.matrixAutoUpdate = false;
      scene.add(mesh);
      this.list.push({ kind, s: SPECS[kind], mesh, live: false, x: 0, y: 0, h: 0, v: 0, w: 0, phase: rng() * 10, wander: 0, side: 1, next: 0, turn: 0, ahead: 1, moored: false, course: null, along: 0, dir: 1, about: 0, z: null });
    };
    for (let i = 0; i < CRUISE; i++) add('cruise', '');
    if (islands) for (let i = 0; i < PEDALS; i++) i % 3 === 2 ? add('swan', '') : add('pedal', PAINTS[i % PAINTS.length]);
    // The first few wait at the bank, for you to take one.
    for (const b of this.list.filter((b) => b.kind !== 'cruise').slice(0, MOORED)) b.moored = true;
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
    if (b.kind === 'cruise' && this.courses.length) { this.launch(b, px, py); return; }
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
      if (b.moored) {
        // Tied up: pulled in to the nearest bank, lying along it.
        let bank = Infinity, a = 0;
        for (let i = 0; i < 16; i++) {
          const r = this.run(b, x, y, (i / 16) * Math.PI * 2, 12);
          if (r < bank) { bank = r; a = (i / 16) * Math.PI * 2; }
        }
        if (bank >= 12) continue;
        const pull = bank - (b.s.beam / 2 + 0.6);
        x += Math.cos(a) * pull; y += Math.sin(a) * pull;
        h = a + Math.PI / 2;
        if (!this.fits(b, x, y, h) || !this.landing(b, x, y, h) || this.list.some((o) => o !== b && o.live && Math.hypot(o.x - x, o.y - y) < 6)) continue;
        Object.assign(b, { x, y, h, v: 0, w: 0, live: true, z: null });
        b.mesh.visible = true;
        return;
      }
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2, r = this.run(b, x, y, a, b.s.look * 2) + this.run(b, x, y, a + Math.PI, b.s.look * 2) * 0.5;
        if (r > best) { best = r; h = a; }
      }
      // Cruise boats keep to the main river, not the narrow arms round the islands.
      if (b.kind === 'cruise' && this.run(b, x, y, h + Math.PI / 2, 60) + this.run(b, x, y, h - Math.PI / 2, 60) < 70) continue;
      if (!this.fits(b, x, y, h) || this.list.some((o) => o !== b && o.live && Math.hypot(o.x - x, o.y - y) < (o.s.len + b.s.len) / 2 + 8)) continue;
      Object.assign(b, { x, y, h, v: 0, w: 0, next: 0, live: true, z: null, wander: this.rng() * 2 - 1, side: this.rng() < 0.5 ? -1 : 1 });
      b.mesh.visible = true;
      return;
    }
  }

  // A cruise boat onto the fairway, somewhere near the player but not in a lock.
  launch(b: Boat, px: number, py: number) {
    for (const c of this.courses) {
      const near = c.project(px, py);
      if (near.d > SPAWN) continue;
      for (let k = 0; k < 4; k++) {
        const s = near.s + (this.rng() * 2 - 1) * SPAWN, p = c.at(s), d = Math.hypot(p.x - px, p.y - py);
        if (s < 0 || s > c.length || d < NEAR || d > SPAWN || p.w < NARROW || this.water.waterAt(p.x, p.y) !== true) continue;
        if (this.list.some((o) => o !== b && o.live && Math.hypot(o.x - p.x, o.y - p.y) < 80)) continue;
        const dir = this.rng() < 0.5 ? -1 : 1, off = this.keepRight(b, p.w) * dir;
        Object.assign(b, { x: p.x + Math.sin(p.ang) * off, y: p.y - Math.cos(p.ang) * off, h: dir > 0 ? p.ang : p.ang + Math.PI, v: b.s.speed * 0.5, w: 0, course: c, along: s, dir, about: 0, live: true, z: null });
        b.mesh.visible = true;
        return;
      }
    }
  }

  // How far right of the fairway's middle a boat sails where the bank is `w` away.
  keepRight(b: Boat, w: number) { return clamp(w - b.s.beam / 2 - BANK, 0, KEEP_RIGHT); }

  // Along the fairway: head for a point ahead on it, a little to the right; slow down
  // behind another boat; wait in wide water while one comes the other way through a
  // canal or lock ahead; turn round at the end of the stretch. Taken away where the
  // map ahead isn't loaded (and put back on nearer the player).
  follow(b: Boat, dt: number) {
    const c = b.course!, S = b.s;
    b.along = c.project(b.x, b.y, b.along).s;
    const here = c.at(b.along);
    if (b.about > 0) {
      // Turning round on the spot, as these boats do with their bow thruster.
      const step = Math.min(b.about, 0.12 * dt);
      b.about -= step;
      b.h += step;
      b.v = 0;
      return;
    }
    const look = clamp(here.w * 1.5, 12, 40), ahead = c.at(b.along + b.dir * look);
    const loaded = this.water.waterAt(ahead.x, ahead.y);
    if (loaded === null) { b.live = false; b.mesh.visible = false; return; }
    // Where to turn round: the last water wide enough before the stretch ends.
    const left = b.dir > 0 ? c.length - b.along : b.along;
    let want = S.speed;
    if (left < 5 || (left < 150 && here.w >= TURNING && (left < 30 || c.narrowest(b.along, b.along + b.dir * Math.min(left, 60)) < TURNING))) {
      if (b.v > 0.25) want = 0;
      else { b.dir = -b.dir; b.about = Math.PI; return; }
    }
    const a = b.dir > 0 ? ahead.ang : ahead.ang + Math.PI, off = this.keepRight(b, Math.min(here.w, ahead.w));
    const tx = ahead.x + Math.sin(a) * off, ty = ahead.y - Math.cos(a) * off;
    let dh = Math.atan2(ty - b.y, tx - b.x) - b.h;
    dh = Math.atan2(Math.sin(dh), Math.cos(dh));
    if (here.w < NARROW) want *= 0.7;
    if (Math.abs(dh) > 0.5) want *= 0.4;
    for (const o of this.list) {
      if (o === b || !o.live || o.course !== c) continue;
      const gap = (o.along - b.along) * b.dir;
      if (gap <= 0) continue;
      if (o.dir === b.dir || o.about > 0) { if (gap < 90) want = Math.min(want, S.speed * clamp((gap - 50) / 40, 0, 1)); }
      // (Of two both waiting at the ends of one canal, the one going up the line goes first.)
      else if (gap < 1500 && here.w >= NARROW && (b.dir < 0 || c.at(o.along).w < NARROW) && c.narrowest(b.along + b.dir * 30, b.along + b.dir * Math.min(gap, 120)) < NARROW && c.narrowest(b.along, o.along) < NARROW) want = 0;
    }
    b.w = clamp(dh * 0.8, -S.turn * 2, S.turn * 2);
    b.v += clamp(want - b.v, -0.5 * dt, 0.3 * dt);
    b.h += b.w * dt;
    b.x += Math.cos(b.h) * b.v * dt;
    b.y += Math.sin(b.h) * b.v * dt;
  }

  // Water height stays below bridge decks and ignores a quay bulging over the water.
  waterHeight(b: Boat, x = b.x, y = b.y, h = b.h) {
    const c = Math.cos(h) * b.s.len * 0.4, s = Math.sin(h) * b.s.len * 0.4, T = this.water;
    return Math.min(T.terrainAt(x, y, true), T.terrainAt(x + c, y + s, true), T.terrainAt(x - c, y - s, true));
  }

  private bankFits(x: number, y: number, deck: number, shoreStep = false) {
    for (const [dx, dy] of [[0, 0], [0.3, 0], [-0.3, 0], [0, 0.3], [0, -0.3]]) {
      const px = x + dx, py = y + dy, wet = this.water.waterAt(px, py);
      // Stepping across the shoreline can overlap water behind the feet. Every dry
      // part still needs the walker's clearance; later dry route samples cannot do this.
      if (wet === true && shoreStep) continue;
      const ground = this.water.terrainAt(px, py);
      if (wet !== false || this.water.cellAt(px, py, 0, ground) !== 0 || Math.abs(ground - deck) > BOARD_STEP) return false;
    }
    return true;
  }

  // A person fits on dry ground, at deck height, with a clear short path to the boat.
  // Once the path reaches land it cannot cross another stretch of water or a wall.
  reachable(b: Boat, x: number, y: number, z = this.water.terrainAt(x, y), bx = b.x, by = b.y, h = b.h) {
    const T = this.water, d = Math.hypot(x - bx, y - by);
    if (d > BOARD_REACH || T.waterAt(x, y) !== false) return false;
    const deck = this.waterHeight(b, bx, by, h) + 0.4;
    if (Math.abs(z - deck) > BOARD_STEP) return false;
    if (!this.bankFits(x, y, deck)) return false;
    let land = false, landX = 0, landY = 0;
    const n = Math.max(1, Math.ceil(d / 0.25));
    for (let i = 0; i <= n; i++) {
      const px = bx + (x - bx) * i / n, py = by + (y - by) * i / n, wet = T.waterAt(px, py);
      if (wet === null || fences.blocks(px, py, 0.3, 0)) return false;
      if (wet) { if (land) return false; continue; }
      if (!land) { land = true; landX = px; landY = py; }
      if (!this.bankFits(px, py, deck, Math.hypot(px - landX, py - landY) <= 0.3)) return false;
    }
    return true;
  }

  // Use the same reachable bank for spawning a moored boat and for getting out.
  landing(b: Boat, bx = b.x, by = b.y, h = b.h): Point2 | null {
    for (let r = b.s.beam / 2 + 0.5; r <= BOARD_REACH; r += 0.5) {
      for (let i = 0; i < 32; i++) {
        const a = i * Math.PI / 16, x = bx + Math.cos(a) * r, y = by + Math.sin(a) * r;
        if (!this.reachable(b, x, y, this.water.terrainAt(x, y), bx, by, h)) continue;
        // Leave room to stand and turn, matching nearestWalkable's clear footprint.
        if ([[1, 0], [-1, 0], [0, 1], [0, -1]].every(([dx, dy]) => {
          const px = x + dx, py = y + dy;
          return this.water.waterAt(px, py) === false && this.water.cellAt(px, py, 0, this.water.terrainAt(px, py)) === 0;
        })) return [x, y];
      }
    }
    return null;
  }

  // A pedal boat close enough to step into from the bank, never from a bridge above it.
  near(x: number, y: number, z = this.water.terrainAt(x, y)) {
    let best: Boat | null = null, bestD = Infinity;
    for (const b of this.list) {
      if (!b.live || b.kind === 'cruise') continue;
      const d = Math.hypot(b.x - x, b.y - y);
      if (d < bestD && this.reachable(b, x, y, z)) { best = b; bestD = d; }
    }
    return best;
  }

  // `ctl`: how the player pedals the boat they're in ({ move, turn }), if they are.
  update(dt: number, px: number, py: number, ctl: { move: number; turn: number } | null = null) {
    for (const b of this.list) {
      if (b === this.me) {
        if (ctl) this.pedal(b, dt, ctl);
        continue;
      }
      if (b.live && Math.hypot(b.x - px, b.y - py) > FAR) { b.live = false; b.mesh.visible = false; }
      if (!b.live) continue;
      if (b.course) this.follow(b, dt); else this.steer(b, dt);
    }
    // One placement attempt per frame, taking turns: a missing safe bank must not
    // keep every later boat from spawning.
    for (let j = 0; j < this.list.length; j++) {
      const i = (this.placeNext + j) % this.list.length, b = this.list[i];
      if (b.live || b === this.me) continue;
      this.placeNext = (i + 1) % this.list.length;
      this.place(b, px, py);
      break;
    }
    // Boats keep clear of each other: a gentle push apart where two overlap.
    for (let i = 0; i < this.list.length; i++) {
      const a = this.list[i];
      if (!a.live) continue;
      for (let j = i + 1; j < this.list.length; j++) {
        const b = this.list[j];
        if (!b.live || (a.course && b.course)) continue; // (boats on the fairway keep their own distance)
        const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1;
        const r = (a.kind === 'cruise' ? a.s.len * 0.4 : a.s.len * 0.5) + (b.kind === 'cruise' ? b.s.len * 0.4 : b.s.len * 0.5);
        if (d >= r) continue;
        const push = Math.min(r - d, 1) * dt * 2, ma = a.s.len, mb = b.s.len;
        // A tied-up boat stays at its reachable mooring; the passing boat moves aside.
        const wa = a.moored ? 0 : b.moored ? 1 : mb / (ma + mb);
        const wb = b.moored ? 0 : a.moored ? 1 : ma / (ma + mb);
        const ax = a.x - (dx / d) * push * wa, ay = a.y - (dy / d) * push * wa;
        const bx = b.x + (dx / d) * push * wb, by = b.y + (dy / d) * push * wb;
        if (!a.course && this.fits(a, ax, ay, a.h)) { a.x = ax; a.y = ay; }
        if (!b.course && this.fits(b, bx, by, b.h)) { b.x = bx; b.y = by; }
      }
    }
    for (const b of this.list) if (b.live) this.pose(b, dt);
  }

  // The player's pedal boat: W/S pedal forward and back, A/D turn (a pedal boat turns
  // on the spot). It stops dead against the bank.
  pedal(b: Boat, dt: number, ctl: { move: number; turn: number }) {
    b.moored = false;
    const want = ctl.move * (ctl.move > 0 ? 1.8 : 0.9);
    b.v += clamp(want - b.v, -1.2 * dt, 0.8 * dt);
    b.w += (ctl.turn * 0.7 - b.w) * Math.min(1, dt * 3);
    const h = b.h + b.w * dt;
    const x = b.x + Math.cos(h) * b.v * dt, y = b.y + Math.sin(h) * b.v * dt;
    if (this.fits(b, x, y, h)) { b.x = x; b.y = y; b.h = h; }
    else if (this.fits(b, b.x, b.y, h)) { b.h = h; b.v = 0; }
    else b.v = 0;
  }

  // Look ahead and to both sides; head for open water, slow down near the bank, and
  // turn round where it closes in.
  steer(b: Boat, dt: number) {
    if (b.moored) return;
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
    // Where the water's height changes (a lock, a sluice), the boat follows at a lock's pace.
    const level = this.waterHeight(b);
    b.z = b.z === null || !(dt > 0) ? level : b.z + clamp(level - b.z, -RISE * dt, RISE * dt);
    const y = b.z;
    m.position.set(b.x, y + A * Math.sin(t * 1.4), -b.y);
    m.rotation.set(A * 0.6 * Math.sin(t * 1.1 + 1), b.h, A * 0.4 * Math.sin(t * 0.9 + 2), 'YXZ');
    m.updateMatrix();
  }
}
