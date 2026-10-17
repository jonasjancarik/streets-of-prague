import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { body, boatMaterial, FERRY } from './boats.ts';
import { Course } from './river.ts';
import type { FerryLine, Landing } from './river.ts';
import type { Point2 } from './map/geo.ts';
import { t, tHtml } from './i18n.ts';

// PID's ferries across the Vltava (P1, P2, …, from river.json): one boat a line, going
// to and fro between its landings on the real crossing. Where it is follows from the
// game's clock, like the funicular, so it keeps its place while the world runs faster.
// It sails between the timetable's first and last sailing of the day, and the seasonal
// lines only from April to October by the game's date; otherwise it lies at its first
// landing. It doesn't keep the timetable's quarter of an hour between sailings: it waits
// a little over a minute at each landing and goes, so there's always one coming.
//
// Press E by the landing while the boat is in to ride (it takes a PID ticket, like a
// tram), and E again at a landing to get off onto the bank.

interface Options {
  clock: { t: number };
  day: () => number; // the game's date: the day of the year
  // The water's height at a point and the ground's, null where the map isn't loaded.
  water: (x: number, y: number) => number | null;
  ground: (x: number, y: number) => number | null;
}
interface RiderPosition { x: number; y: number; h: number; vx: number; vy: number }

const DWELL = 75; // s at each landing
const ACC = 0.25; // m/s²
const FAST = 6;
const REACH = 16; // m from where the boat lies: near enough to go aboard
const SEASON: [number, number] = [91, 304]; // 1 April to 31 October, as days of the year
const DECK = 1.1; // m: the pontoon's deck over the water (and the boat's)

// Seconds to cover d metres from a standstill to a standstill, and how far along and
// how fast at τ seconds in (as the funicular's).
function runTime(d: number, v: number, a: number) { return d > (v * v) / a ? d / v + v / a : 2 * Math.sqrt(d / a); }
function runAt(tau: number, d: number, v: number, a: number): [number, number] {
  const T = runTime(d, v, a), top = Math.min(v, (a * T) / 2), ta = top / a;
  if (tau <= 0) return [0, 0];
  if (tau >= T) return [d, 0];
  if (tau < ta) return [0.5 * a * tau * tau, a * tau];
  if (tau > T - ta) { const r = T - tau; return [d - 0.5 * a * r * r, a * r]; }
  return [0.5 * a * ta * ta + top * (tau - ta), top];
}

const clockTime = (h: number) => `${Math.floor(h + 1 / 120)}:${String(Math.round((h % 1) * 60) % 60).padStart(2, '0')}`;

// A landing: a pontoon from the bank out to where the boat lies, on two floats, with a
// post carrying the line's colour. Made along +x from the bank, `len` metres long.
function pontoon(len: number, colour: string) {
  const parts: THREE.BufferGeometry[] = [];
  const box = (sx: number, sy: number, sz: number, x: number, y: number, z: number, color: string, glow = 0) => {
    const g = new THREE.BoxGeometry(sx, sy, sz).translate(x, y, z).toNonIndexed();
    const c = new THREE.Color(color), n = g.attributes.position.count, col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('glow', new THREE.BufferAttribute(new Float32Array(n).fill(glow), 1));
    g.deleteAttribute('uv');
    g.deleteAttribute('normal');
    parts.push(g);
  };
  box(len, 0.14, 2.2, len / 2, DECK - 0.07, 0, '#8a7558'); // the planks
  for (const z of [-0.8, 0.8]) box(len - 0.6, 0.7, 0.5, len / 2 + 0.3, 0.2, z, '#4a5257'); // the floats
  for (const z of [-1.05, 1.05]) {
    box(len, 0.06, 0.06, len / 2, DECK + 1.0, z, '#c9c7bf'); // a rail each side
    for (let x = 0.2; x <= len; x += Math.max(1.5, (len - 0.4) / Math.ceil(len / 2))) box(0.06, 1.0, 0.06, x, DECK + 0.5, z, '#c9c7bf');
  }
  box(0.1, 2.6, 0.1, 0.4, DECK + 1.3, 1.25, '#5c6064'); // the post, with the line's colour on a board
  box(0.06, 0.5, 0.8, 0.4, DECK + 2.3, 1.25, colour);
  box(0.16, 0.14, 0.16, 0.4, DECK + 2.7, 1.25, '#fff3d0', 2);
  const g = mergeGeometries(parts)!;
  g.computeVertexNormals();
  return g;
}

interface Step { stop: number | null; leg: number; back: boolean; from: number; dur: number }

export interface Ferry {
  line: FerryLine;
  legs: Course[];
  steps: Step[]; // one round trip, landing by landing
  period: number;
  mesh: THREE.Mesh;
  piers: THREE.Mesh[];
  x: number; y: number; h: number; vx: number; vy: number;
  z: number | null; // the water's height under it (null where the map isn't loaded)
  stop: number | null; // the landing it lies at
  to: number; // the landing it's going to (or will go to next)
  open: boolean; // sailing now
}

export class Ferries {
  o: Options;
  list: Ferry[] = [];
  me: Ferry | null = null;
  scale = 1;

  constructor(lines: FerryLine[], scene: THREE.Scene, o: Options) {
    this.o = o;
    for (const line of lines) {
      const legs = line.legs.map((pts) => new Course(pts));
      // There and back: wait at each landing, then sail the leg to the next.
      const steps: Step[] = [];
      let at = 0;
      const add = (stop: number | null, leg: number, back: boolean, dur: number) => { steps.push({ stop, leg, back, from: at, dur }); at += dur; };
      for (let k = 0; k < legs.length; k++) { add(k, k, false, DWELL); add(null, k, false, runTime(legs[k].length, FERRY.speed, ACC)); }
      for (let k = legs.length - 1; k >= 0; k--) { add(k + 1, k, true, DWELL); add(null, k, true, runTime(legs[k].length, FERRY.speed, ACC)); }
      const mesh = new THREE.Mesh(body('ferry', line.colour), boatMaterial());
      mesh.castShadow = true;
      mesh.visible = false;
      mesh.matrixAutoUpdate = false;
      scene.add(mesh);
      const piers = line.stops.map((s) => {
        const len = Math.max(2.5, Math.hypot(s.berth[0] - s.gate[0], s.berth[1] - s.gate[1]) - FERRY.len / 2 + 0.3);
        const pier = new THREE.Mesh(pontoon(len, line.colour), boatMaterial());
        pier.castShadow = true;
        pier.visible = false;
        pier.matrixAutoUpdate = false;
        scene.add(pier);
        return pier;
      });
      const p = legs[0].at(0);
      this.list.push({ line, legs, steps, period: at, mesh, piers, x: p.x, y: p.y, h: p.ang, vx: 0, vy: 0, z: null, stop: 0, to: 1, open: false });
    }
  }

  // Whether a line sails at this time of this day.
  sails(line: FerryLine, sec: number) {
    const day = this.o.day(), h = sec / 3600;
    return (line.allYear || (day >= SEASON[0] && day <= SEASON[1])) && h >= line.hours[0] && h < line.hours[1];
  }

  // Where a line's boat is at `sec` seconds into the day.
  private place(f: Ferry, sec: number) {
    const from = f.line.hours[0] * 3600, p = sec - from;
    // (The last round trip is back before the day's last sailing time.)
    const open = this.sails(f.line, sec) && p < Math.floor(((f.line.hours[1] - f.line.hours[0]) * 3600) / f.period) * f.period;
    f.open = open;
    if (!open) return { ...f.legs[0].at(0), v: 0, stop: 0, to: 1 };
    const tau = p % f.period, step = f.steps.find((s) => tau < s.from + s.dur) ?? f.steps[f.steps.length - 1], c = f.legs[step.leg];
    if (step.stop !== null) {
      const q = c.at(step.back ? c.length : 0);
      return { ...q, ang: step.back ? q.ang + Math.PI : q.ang, v: 0, stop: step.stop, to: step.back ? step.leg : step.leg + 1 };
    }
    const [d, v] = runAt(tau - step.from, c.length, FERRY.speed, ACC), q = c.at(step.back ? c.length - d : d);
    return { ...q, ang: step.back ? q.ang + Math.PI : q.ang, v, stop: null, to: step.back ? step.leg : step.leg + 1 };
  }

  update(dt: number) {
    const sec = ((this.o.clock.t % 86400) + 86400) % 86400;
    for (const f of this.list) {
      const p = this.place(f, sec);
      f.x = p.x; f.y = p.y; f.stop = p.stop; f.to = p.to;
      f.vx = Math.cos(p.ang) * p.v; f.vy = Math.sin(p.ang) * p.v;
      // It swings round to face the way it goes next while it lies at a landing.
      let dh = p.ang - f.h;
      dh = Math.atan2(Math.sin(dh), Math.cos(dh));
      f.h = p.v > 0.5 || !(dt > 0) ? p.ang : f.h + Math.max(-0.5 * dt, Math.min(0.5 * dt, dh));
      f.z = this.o.water(f.x, f.y);
      f.mesh.visible = f.z !== null;
      if (f.z !== null) {
        f.mesh.position.set(f.x, f.z, -f.y);
        f.mesh.rotation.set(0, f.h, 0);
        f.mesh.updateMatrix();
      }
      f.line.stops.forEach((s, k) => {
        const pier = f.piers[k], z = this.o.water(s.berth[0], s.berth[1]);
        if (pier.visible === (z !== null)) return;
        pier.visible = z !== null;
        if (z === null) return;
        pier.position.set(s.gate[0], z, -s.gate[1]);
        pier.rotation.set(0, Math.atan2(s.berth[1] - s.gate[1], s.berth[0] - s.gate[0]), 0);
        pier.updateMatrix();
      });
    }
  }

  // A ferry lying at a landing right by (x, y), if there is one to ride.
  // (With any, also one lying there while the line isn't sailing.)
  near(x: number, y: number, any = false) {
    if (this.me) return null;
    for (const f of this.list) {
      if (f.stop === null || f.z === null || (!f.open && !any)) continue;
      const s = f.line.stops[f.stop];
      if (Math.hypot(x - f.x, y - f.y) < REACH || Math.hypot(x - s.gate[0], y - s.gate[1]) < REACH / 2) return f;
    }
    return null;
  }

  // The landing a ferry lies at.
  landing(f: Ferry): Landing | null { return f.stop === null ? null : f.line.stops[f.stop]; }

  // Where to stand on the bank at a landing: `walkable(x, y)` gives the nearest spot
  // a person can stand on.
  ashore(s: Landing, walkable: (x: number, y: number) => Point2): Point2 {
    // A little inland of the gate, away from the water.
    const dx = s.gate[0] - s.berth[0], dy = s.gate[1] - s.berth[1], d = Math.hypot(dx, dy) || 1;
    return walkable(s.gate[0] + (dx / d) * 2.5, s.gate[1] + (dy / d) * 2.5);
  }

  // What the hint says standing by a ferry at its landing.
  offer(f: Ferry) {
    const { line } = f;
    if (!f.open) {
      const day = this.o.day();
      if (!line.allYear && (day < SEASON[0] || day > SEASON[1])) return tHtml('Ferry {line} sails from April to October', { line: line.ref });
      return tHtml('Ferry {line} sails {hours}', { line: line.ref, hours: `${clockTime(line.hours[0])}–${clockTime(line.hours[1])}` });
    }
    return tHtml('<b>E</b> take ferry {line} to {name}', { line: line.ref, name: line.stops[f.to].name });
  }

  // And riding one (without the keys on a touch screen).
  hint(touch: boolean, scale: number) {
    const f = this.me!, parts = [];
    if (scale > 1.5) parts.push(t('{n}× speed', { n: Math.round(scale) }));
    if (f.stop !== null) parts.push(tHtml('At {name}', { name: f.line.stops[f.stop].name }));
    else parts.push(tHtml('Ferry {line} to {name}', { line: f.line.ref, name: f.line.stops[f.to].name }));
    if (!touch) parts.push(t(f.stop !== null ? '<b>E</b> get off' : 'hold <b>Shift</b> to speed up'));
    return parts.join(' · ');
  }

  board(f: Ferry) {
    this.me = f;
    this.scale = 1;
  }

  leave() {
    this.me = null;
    this.scale = 1;
  }

  seat(walker: RiderPosition) {
    const f = this.me!;
    Object.assign(walker, { x: f.x, y: f.y, h: f.h, vx: f.vx * this.scale, vy: f.vy * this.scale });
  }

  // Hold Shift to speed the crossing up.
  speedUp(dt: number, hold: boolean) {
    const target = hold ? FAST : 1;
    this.scale += (target - this.scale) * Math.min(1, dt * (target > this.scale ? 1.5 : 4));
    if (Math.abs(this.scale - target) < 0.02) this.scale = target;
    return this.scale;
  }
}
