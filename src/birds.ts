import * as THREE from 'three';
import { sendInstances } from './gpu.ts';

// Birds: flocks of pigeons wheeling over the roofs in a tight bunch, a few gulls gliding
// in wide circles over the river, and pigeons pecking about on the ground, which take
// off when you or a car come at them, circle for a while and come down again somewhere
// near. Seen from above a bird is its outline and its shadow on the roofs and the
// street, so each one is a flat shape, all of them one instanced mesh with an ordinary
// material (one draw, and one more in the shadow pass). A wingbeat from above is the
// span getting narrower and wider, which is just the instance's scale across, so nothing
// is animated on the GPU and a frame's work here is a matrix for each bird (at most
// BIRDS.most).
//
// A flock arrives from beyond the view, circles a spot for a while and leaves again or
// lands. None arrive at night or in rain or snow; the ones in the air then fly off.

export const BIRDS = {
  most: 120, // birds drawn at once
  flocks: 3, // flocks in the air at once
  groups: 3, // groups on the ground at once
  beyond: 70, // m past the edge of the view where a flock arrives and is taken away
  low: 32, // m a bird stays below the camera: a flock comes down as the view zooms in,
  roofs: 24, // and when that brings it this low (down among the roofs) it shrinks away
  size: 1.3, // drawn bigger than life, as the people are, to read from above
  shy: 3.2, // m: how near you come on foot before the pigeons on the ground take off
  car: 7, // m: and a moving car
};

interface Kind {
  birds: [number, number]; speed: number; height: [number, number]; ring: [number, number]; stay: [number, number];
  spread: number; // m the flock is across
  beat: number; // wingbeats a second
  glide: number; // how much of the time the wings are held still (0 to 1)
  span: number; long: number; // the shape's scale across and along
  lands: number; // the chance it comes down when it has circled long enough, rather than flying off
  colours: THREE.Color[];
}
const colours = (list: string[]) => list.map((c) => new THREE.Color(c));
const KINDS: Record<'pigeon' | 'gull', Kind> = {
  pigeon: {
    birds: [10, 24], speed: 12, height: [32, 46], ring: [45, 90], stay: [35, 80], spread: 11, beat: 6.5, glide: 0.15, span: 1, long: 1, lands: 0.6,
    colours: colours(['#7d858f', '#6a717b', '#8b9199', '#5b6068', '#70777f', '#c9cbcc', '#6f6258', '#4a4e55']),
  },
  gull: {
    birds: [3, 8], speed: 8.5, height: [26, 40], ring: [60, 130], stay: [50, 110], spread: 26, beat: 3, glide: 0.65, span: 1.75, long: 1.25, lands: 0,
    colours: colours(['#f1f1ee', '#e7e8e6', '#f6f5f0', '#dcdedc']),
  },
};
// On the ground: how far across a group pecks about (m), how fast a pigeon walks (m/s)
// and how narrow it is with its wings folded (of its span).
const GROUND = { across: 2.4, walk: 0.45, folded: 0.3 };

interface Bird {
  // Where in the flock it flies (m along, across and up from the middle), and how it
  // wanders about that place.
  along: number; across: number; up: number; phase: number; drift: number; beat: number; size: number; colour: THREE.Color;
  // On the ground: where it stands from the group's middle and how high the ground is
  // there, the way it faces, where it is walking to and how long it stays once there.
  gx: number; gy: number; gz: number; gh: number; tx: number; ty: number; wait: number;
}
interface Flock {
  kind: Kind; x: number; y: number; h: number; alt: number;
  // The spot it circles, which way round and how wide, and for how long yet.
  homeX: number; homeY: number; ring: number; turn: number; stay: number;
  birds: Bird[]; bank: number; t: number;
  // Taking off (seconds since it left the ground, and how high the ground was), or coming
  // down to a spot on the ground. `leaving`: it has circled long enough.
  risen: number | null; from: number; leaving: boolean;
  land: { x: number; y: number; z: number } | null;
}
interface Group { x: number; y: number; birds: Bird[] }
export interface BirdsView {
  x: number; y: number; radius: number; height: number; // the camera's target, how far it sees and how high it is
  dark: number; rain: number; snow: number;
  ground: (x: number, y: number) => number;
  water: (x: number, y: number) => boolean;
  // Open ground a bird can stand on (not a road, not water, nothing in the way).
  open: (x: number, y: number) => boolean;
  // You within BIRDS.shy metres of the spot or a moving car within BIRDS.car: where it is, or null.
  threat: (x: number, y: number) => { x: number; y: number } | null;
}

// The shape from above, facing +x, wings out along z: body and head, a fanned tail and
// two swept wings, darker towards the wingtips and the end of the tail.
function shape() {
  const pos: number[] = [], col: number[] = [];
  const poly = (points: [number, number, number][]) => {
    for (let i = 1; i < points.length - 1; i++) {
      // Wound to face up, whichever way round the outline was given.
      const [a, b, c] = [points[0], points[i], points[i + 1]];
      const up = (b[1] - a[1]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[1] - a[1]) > 0;
      for (const [x, z, shade] of up ? [a, b, c] : [a, c, b]) {
        pos.push(x, 0, z);
        col.push(shade, shade, shade);
      }
    }
  };
  poly([[0.2, 0, 0.8], [0.15, 0.035, 0.85], [0.06, 0.05, 1], [-0.12, 0.04, 0.95], [-0.12, -0.04, 0.95], [0.06, -0.05, 1], [0.15, -0.035, 0.85]]);
  poly([[-0.1, 0.035, 0.9], [-0.27, 0.075, 0.5], [-0.29, 0, 0.45], [-0.27, -0.075, 0.5], [-0.1, -0.035, 0.9]]);
  for (const s of [1, -1]) {
    poly([[0.09, s * 0.04, 1], [0.12, s * 0.17, 0.95], [0.04, s * 0.3, 0.6], [-0.06, s * 0.34, 0.4], [-0.09, s * 0.2, 0.7], [-0.07, s * 0.04, 0.9]]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(pos.map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
  return g;
}

const _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _roll = new THREE.Quaternion(), _s = new THREE.Vector3(), _m = new THREE.Matrix4();
const UP = new THREE.Vector3(0, 1, 0), FORWARD = new THREE.Vector3(1, 0, 0);
const { clamp, smoothstep, lerp } = THREE.MathUtils;
const AROUND = [[0, 0], [2.6, 0], [-2.6, 0], [0, 2.6], [0, -2.6]];

export class Birds {
  mesh: THREE.InstancedMesh<THREE.BufferGeometry, THREE.MeshLambertMaterial>;
  flocks: Flock[] = [];
  groups: Group[] = [];
  private wait = 2; // seconds until the next flock may arrive
  private look = 1; // and until the next look for a group on the ground just out of sight
  // (Its own numbers: nothing here may move the game's seeded sequence along.)
  private seed = 20231;
  private r = () => ((this.seed = (this.seed * 16807) % 2147483647) / 2147483647);
  private between = ([a, b]: [number, number]) => a + (b - a) * this.r();

  constructor(scene: THREE.Scene) {
    const material = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
    this.mesh = new THREE.InstancedMesh(shape(), material, BIRDS.most);
    this.mesh.setColorAt(0, new THREE.Color('#ffffff'));
    this.mesh.castShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.visible = false;
    scene.add(this.mesh);
  }

  private get room() { return BIRDS.most - this.flocks.reduce((n, f) => n + f.birds.length, 0) - this.groups.reduce((n, g) => n + g.birds.length, 0); }

  private bird(k: Kind): Bird {
    // Bunched towards the middle of the flock, strung out a little along the way they fly.
    const d = k.spread * 0.5 * Math.sqrt(this.r()), b = this.r() * Math.PI * 2;
    // On the ground: a place of its own in the group.
    const g = GROUND.across * Math.sqrt(this.r()), ga = this.r() * Math.PI * 2, gx = Math.cos(ga) * g, gy = Math.sin(ga) * g;
    return {
      along: Math.cos(b) * d * 1.4, across: Math.sin(b) * d, up: (this.r() - 0.5) * k.spread * 0.3, phase: this.r() * Math.PI * 2, drift: 0.25 + this.r() * 0.35,
      beat: k.beat * (0.9 + this.r() * 0.2), size: 0.9 + this.r() * 0.2, colour: k.colours[Math.floor(this.r() * k.colours.length)],
      gx, gy, gz: NaN, gh: this.r() * Math.PI * 2, tx: gx, ty: gy, wait: this.r() * 3,
    };
  }

  // A flock of `kind` heading for (x, y) from `from` metres away (0: already there).
  add(kind: 'pigeon' | 'gull', x: number, y: number, from: number, view: BirdsView) {
    const k = KINDS[kind], n = Math.min(Math.round(this.between(k.birds)), this.room);
    if (n <= 0) return null;
    const a = this.r() * Math.PI * 2;
    const flock: Flock = {
      kind: k, x: x + Math.cos(a) * from, y: y + Math.sin(a) * from, h: a + Math.PI, alt: view.ground(x, y) + this.between(k.height),
      homeX: x, homeY: y, ring: this.between(k.ring), turn: this.r() < 0.5 ? 1 : -1, stay: this.between(k.stay),
      birds: Array.from({ length: n }, () => this.bird(k)), bank: 0, t: this.r() * 100, risen: null, from: 0, leaving: false, land: null,
    };
    this.flocks.push(flock);
    return flock;
  }

  // Pigeons standing about at (x, y): new ones, or a flock that has come down.
  settle(x: number, y: number, birds?: Bird[]) {
    const n = Math.min(Math.round(6 + this.r() * 9), this.room);
    if (!birds && n <= 0) return null;
    const group: Group = { x, y, birds: birds ?? Array.from({ length: n }, () => this.bird(KINDS.pigeon)) };
    for (const b of group.birds) b.gz = NaN;
    this.groups.push(group);
    return group;
  }

  // Up and away from whatever came at them, to circle a spot a little way off.
  private scatter(g: Group, from: { x: number; y: number }, view: BirdsView) {
    const k = KINDS.pigeon, away = Math.atan2(g.y - from.y, g.x - from.x) + (this.r() - 0.5) * 0.8, far = 50 + this.r() * 40;
    for (const b of g.birds) {
      // (From where each stands: its place in the flock is taken up as it climbs.)
      b.tx = b.gx;
      b.ty = b.gy;
    }
    this.flocks.push({
      kind: k, x: g.x, y: g.y, h: away, alt: view.ground(g.x, g.y) + this.between(k.height),
      homeX: g.x + Math.cos(away) * far, homeY: g.y + Math.sin(away) * far, ring: 35 + this.r() * 25, turn: this.r() < 0.5 ? 1 : -1, stay: 14 + this.r() * 22,
      birds: g.birds, bank: 0, t: this.r() * 100, risen: 0, from: view.ground(g.x, g.y), leaving: false, land: null,
    });
    this.groups.splice(this.groups.indexOf(g), 1);
  }

  // Open ground for a group within `reach` metres of (x, y), or null.
  private spot(x: number, y: number, reach: number, view: BirdsView, tries: number) {
    for (let i = 0; i < tries; i++) {
      const a = this.r() * Math.PI * 2, d = reach * Math.sqrt(this.r()), sx = x + Math.cos(a) * d, sy = y + Math.sin(a) * d;
      if (Math.hypot(sx - view.x, sy - view.y) > view.radius + BIRDS.beyond) continue;
      if (this.groups.some((g) => Math.hypot(g.x - sx, g.y - sy) < 12)) continue;
      if (AROUND.every(([dx, dy]) => view.open(sx + dx, sy + dy)) && !view.threat(sx, sy)) return { x: sx, y: sy, z: view.ground(sx, sy) };
    }
    return null;
  }

  update(dt: number, view: BirdsView) {
    const flying = view.dark < 0.5 && view.rain < 0.3 && view.snow < 0.3;
    if (flying && this.flocks.length < BIRDS.flocks && (this.wait -= dt) <= 0) {
      // Somewhere in the middle part of the view; over water it's gulls.
      const a = this.r() * Math.PI * 2, d = view.radius * 0.55 * Math.sqrt(this.r());
      const x = view.x + Math.cos(a) * d, y = view.y + Math.sin(a) * d;
      this.add(view.water(x, y) ? 'gull' : 'pigeon', x, y, view.radius + d + BIRDS.beyond, view);
      this.wait = 6 + this.r() * 14;
    }
    // Pigeons already on the ground where you're about to look: just past the edge of the view.
    if (dt > 0 && view.dark < 0.5 && this.groups.length < BIRDS.groups && (this.look -= dt) <= 0) {
      this.look = 0.7;
      const a = this.r() * Math.PI * 2, d = view.radius + 8 + this.r() * 40;
      const at = this.spot(view.x + Math.cos(a) * d, view.y + Math.sin(a) * d, 0, view, 1);
      if (at) this.settle(at.x, at.y);
    }
    if (!this.flocks.length && !this.groups.length) {
      this.mesh.visible = false;
      return;
    }

    const out = view.radius + BIRDS.beyond + 40;
    for (const f of [...this.flocks]) {
      f.t += dt;
      f.stay -= flying ? dt : 4 * dt; // (in a hurry once the rain starts)
      if (f.risen !== null && (f.risen += dt) > 6) f.risen = null;
      // Time to go: down to open ground near the spot it circled, if there is any, or away.
      if (f.stay <= 0 && !f.leaving && f.risen === null) {
        f.leaving = true;
        if (this.r() < f.kind.lands && this.groups.length < BIRDS.groups) f.land = this.spot(f.homeX, f.homeY, 45, view, 8);
      }
      const goal = f.land ?? { x: f.homeX, y: f.homeY }, dx = goal.x - f.x, dy = goal.y - f.y, d = Math.hypot(dx, dy) || 1;
      let want = f.h, speed = f.kind.speed;
      if (f.land) {
        want = Math.atan2(dy, dx);
        speed *= clamp(d / 30, 0.25, 1);
        if (d < 1.5) {
          // Down: each where it came to, facing about the way it flew in.
          this.flocks.splice(this.flocks.indexOf(f), 1);
          for (const b of f.birds) Object.assign(b, { gx: b.tx, gy: b.ty, gh: f.h + (this.r() - 0.5) * 2, wait: this.r() * 2 });
          this.settle(f.land.x, f.land.y, f.birds);
          continue;
        }
      } else if (!f.leaving) {
        // Round the spot: along the ring, and in or out towards it by how far off it is.
        const off = clamp((d - f.ring) / f.ring, -1, 1);
        want = Math.atan2(dy, dx) - f.turn * (Math.PI / 2) * (1 - off);
      }
      if (f.risen !== null) speed *= smoothstep(f.risen, -0.5, 1.5);
      const turn = clamp(Math.atan2(Math.sin(want - f.h), Math.cos(want - f.h)), -1, 1) * (f.land ? 1.2 : 0.55);
      f.h += turn * dt;
      f.bank += (turn * 0.9 - f.bank) * Math.min(1, dt * 2);
      f.x += Math.cos(f.h) * speed * dt;
      f.y += Math.sin(f.h) * speed * dt;
      if (Math.hypot(f.x - view.x, f.y - view.y) > out && (f.leaving || Math.hypot(f.homeX - view.x, f.homeY - view.y) > out + f.ring)) this.flocks.splice(this.flocks.indexOf(f), 1);
    }
    for (const g of [...this.groups]) {
      const far = Math.hypot(g.x - view.x, g.y - view.y);
      if (far > out) { this.groups.splice(this.groups.indexOf(g), 1); continue; }
      const from = dt > 0 && far < view.radius + 10 ? view.threat(g.x, g.y) : null;
      if (from) { this.scatter(g, from, view); continue; }
      for (const b of g.birds) {
        // A few steps to somewhere else in the group, a look about there, and on.
        const dx = b.tx - b.gx, dy = b.ty - b.gy, d = Math.hypot(dx, dy);
        if (d > 0.05) {
          const step = Math.min(d, GROUND.walk * dt);
          b.gx += dx / d * step;
          b.gy += dy / d * step;
          b.gh = Math.atan2(dy, dx);
          b.gz = NaN;
        } else if ((b.wait -= dt) < 0) {
          const a = this.r() * Math.PI * 2, reach = GROUND.across * Math.sqrt(this.r());
          b.tx = Math.cos(a) * reach;
          b.ty = Math.sin(a) * reach;
          b.wait = 0.5 + this.r() * 4;
        } else b.gh += Math.sin(b.wait * 9 + b.phase) * dt * 1.5;
      }
    }

    let n = 0;
    // (Too near the camera a bird in the air would fill the screen.)
    const ceiling = view.ground(view.x, view.y) + view.height - BIRDS.low, near = smoothstep(view.height - BIRDS.low, BIRDS.roofs - 8, BIRDS.roofs);
    for (const f of this.flocks) {
      const k = f.kind, cos = Math.cos(f.h), sin = Math.sin(f.h);
      // Climbing from the ground or coming down to it: how far up it is (0 to 1), and from where.
      let up = f.risen === null ? 1 : smoothstep(f.risen, 0, 5), base = f.from;
      if (f.land) {
        base = f.land.z;
        up = Math.min(up, smoothstep(Math.hypot(f.land.x - f.x, f.land.y - f.y), 1, 40));
      }
      const high = lerp(base + 0.3, f.alt, up), alt = up < 1 ? Math.min(high, Math.max(ceiling, base + 6)) : Math.min(high, ceiling);
      // (Low down, just off the ground or nearly on it, they show whatever the zoom.)
      const size = BIRDS.size * (up < 1 ? Math.max(near, 1 - smoothstep(high - base, 5, 12)) : near);
      _q.setFromAxisAngle(UP, f.h).multiply(_roll.setFromAxisAngle(FORWARD, -f.bank));
      for (const b of f.birds) {
        if (n >= BIRDS.most) break;
        const w = f.t * b.drift + b.phase;
        // (On the way up or down: between where it stands in the group and its place in the flock.)
        const along = lerp(cos * b.tx + sin * b.ty, b.along + Math.sin(w) * k.spread * 0.18, up);
        const across = lerp(-sin * b.tx + cos * b.ty, b.across + Math.sin(w * 1.3 + 1) * k.spread * 0.16, up);
        // Beating, with spells of gliding on spread wings (none while climbing or landing).
        const beating = up < 1 ? 1 : smoothstep(Math.sin(f.t * 0.45 + b.phase * 3) * 0.5 + 0.5, k.glide - 0.1, k.glide + 0.1);
        const flap = 1 - beating * 0.5 * (0.5 + 0.5 * Math.sin(f.t * b.beat * Math.PI * 2 + b.phase));
        _p.set(f.x + cos * along - sin * across, alt + (b.up + Math.sin(w * 0.7) * 1.5) * up, -(f.y + sin * along + cos * across));
        this.mesh.setMatrixAt(n, _m.compose(_p, _q, _s.set(size * b.size * k.long, size * b.size, size * b.size * k.span * flap)));
        this.mesh.setColorAt(n++, b.colour);
      }
    }
    for (const g of this.groups) {
      for (const b of g.birds) {
        if (n >= BIRDS.most) break;
        if (Number.isNaN(b.gz)) b.gz = view.ground(g.x + b.gx, g.y + b.gy);
        const size = BIRDS.size * b.size;
        _p.set(g.x + b.gx, b.gz + 0.07, -(g.y + b.gy));
        this.mesh.setMatrixAt(n, _m.compose(_p, _q.setFromAxisAngle(UP, b.gh), _s.set(size, size, size * GROUND.folded)));
        this.mesh.setColorAt(n++, b.colour);
      }
    }
    this.mesh.count = n;
    this.mesh.visible = n > 0;
    sendInstances(this.mesh);
  }

  clear() {
    this.flocks.length = 0;
    this.groups.length = 0;
    this.mesh.count = 0;
    this.mesh.visible = false;
  }
}
