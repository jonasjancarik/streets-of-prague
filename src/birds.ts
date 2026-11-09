import * as THREE from 'three';
import { sendInstances } from './gpu.ts';

// Flocks of birds over the roofs: pigeons wheeling round a block in a tight bunch, and
// over the river a few gulls gliding in wide circles. Seen from above a bird is its
// outline and its shadow on the roofs and the street, so each one is a flat shape, all
// of them one instanced mesh with an ordinary material (one draw, and one more in the
// shadow pass). A wingbeat from above is the span getting narrower and wider, which is
// just the instance's scale across, so nothing is animated on the GPU and a frame's
// work here is a matrix for each bird in the air (at most BIRDS.most).
//
// A flock arrives from beyond the view, circles a spot for a while and leaves again.
// None fly at night or in rain or snow; the ones in the air then fly off.

export const BIRDS = {
  most: 96, // birds drawn at once
  flocks: 3, // flocks about at once
  beyond: 70, // m past the edge of the view where a flock arrives and is taken away
  low: 32, // m a bird stays below the camera: a flock comes down as the view zooms in,
  roofs: 24, // and below this height over the ground (down among the roofs) it shrinks away
  size: 1.3, // drawn bigger than life, as the people are, to read from above
};

interface Kind {
  birds: [number, number]; speed: number; height: [number, number]; ring: [number, number]; stay: [number, number];
  spread: number; // m the flock is across
  beat: number; // wingbeats a second
  glide: number; // how much of the time the wings are held still (0 to 1)
  span: number; long: number; // the shape's scale across and along
  colours: string[];
}
const KINDS: Record<'pigeon' | 'gull', Kind> = {
  pigeon: {
    birds: [10, 26], speed: 12, height: [32, 46], ring: [45, 90], stay: [35, 80], spread: 11, beat: 6.5, glide: 0.15, span: 1, long: 1,
    colours: ['#7d858f', '#6a717b', '#8b9199', '#5b6068', '#70777f', '#c9cbcc', '#6f6258', '#4a4e55'],
  },
  gull: {
    birds: [3, 8], speed: 8.5, height: [26, 40], ring: [60, 130], stay: [50, 110], spread: 26, beat: 3, glide: 0.65, span: 1.75, long: 1.25,
    colours: ['#f1f1ee', '#e7e8e6', '#f6f5f0', '#dcdedc'],
  },
};

interface Bird {
  // Where in the flock it flies (m along, across and up from the middle), and how it
  // wanders about that place.
  along: number; across: number; up: number; phase: number; drift: number; beat: number; size: number;
}
interface Flock {
  kind: Kind; x: number; y: number; h: number; alt: number;
  // The spot it circles, which way round and how wide, and for how long yet.
  homeX: number; homeY: number; ring: number; turn: number; stay: number;
  birds: Bird[]; first: number; bank: number; t: number;
}
export interface BirdsView {
  x: number; y: number; radius: number; height: number; // the camera's target, how far it sees and how high it is
  dark: number; rain: number; snow: number;
  ground: (x: number, y: number) => number;
  water: (x: number, y: number) => boolean;
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
const _c = new THREE.Color();
const UP = new THREE.Vector3(0, 1, 0), FORWARD = new THREE.Vector3(1, 0, 0);

export class Birds {
  mesh: THREE.InstancedMesh<THREE.BufferGeometry, THREE.MeshLambertMaterial>;
  flocks: Flock[] = [];
  private wait = 2; // seconds until the next flock may arrive
  // (Its own numbers: nothing here may move the game's seeded sequence along.)
  private seed = 20231;
  private r = () => ((this.seed = (this.seed * 16807) % 2147483647) / 2147483647);
  private between = ([a, b]: [number, number]) => a + (b - a) * this.r();

  constructor(scene: THREE.Scene) {
    const material = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
    this.mesh = new THREE.InstancedMesh(shape(), material, BIRDS.most);
    this.mesh.setColorAt(0, _c.set('#ffffff'));
    this.mesh.castShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.visible = false;
    scene.add(this.mesh);
  }

  // A flock of `kind` heading for (x, y) from `from` metres away (0: already there).
  add(kind: 'pigeon' | 'gull', x: number, y: number, from: number, view: BirdsView) {
    const k = KINDS[kind], used = this.flocks.reduce((n, f) => n + f.birds.length, 0);
    const n = Math.min(Math.round(this.between(k.birds)), BIRDS.most - used);
    if (n <= 0) return null;
    const a = this.r() * Math.PI * 2;
    const flock: Flock = {
      kind: k, x: x + Math.cos(a) * from, y: y + Math.sin(a) * from, h: a + Math.PI, alt: view.ground(x, y) + this.between(k.height),
      homeX: x, homeY: y, ring: this.between(k.ring), turn: this.r() < 0.5 ? 1 : -1, stay: this.between(k.stay),
      birds: [], first: used, bank: 0, t: this.r() * 100,
    };
    for (let i = 0; i < n; i++) {
      // Bunched towards the middle, strung out a little along the way they fly.
      const d = k.spread * 0.5 * Math.sqrt(this.r()), b = this.r() * Math.PI * 2;
      flock.birds.push({ along: Math.cos(b) * d * 1.4, across: Math.sin(b) * d, up: (this.r() - 0.5) * k.spread * 0.3, phase: this.r() * Math.PI * 2, drift: 0.25 + this.r() * 0.35, beat: k.beat * (0.9 + this.r() * 0.2), size: 0.9 + this.r() * 0.2 });
      this.mesh.setColorAt(used + i, _c.set(k.colours[Math.floor(this.r() * k.colours.length)]));
    }
    this.flocks.push(flock);
    sendInstances(this.mesh);
    return flock;
  }

  private arrive(view: BirdsView) {
    // Somewhere in the middle part of the view; over water it's gulls.
    const a = this.r() * Math.PI * 2, d = view.radius * 0.55 * Math.sqrt(this.r());
    const x = view.x + Math.cos(a) * d, y = view.y + Math.sin(a) * d;
    this.add(view.water(x, y) ? 'gull' : 'pigeon', x, y, view.radius + d + BIRDS.beyond, view);
  }

  update(dt: number, view: BirdsView) {
    const flying = view.dark < 0.5 && view.rain < 0.3 && view.snow < 0.3;
    if (flying && this.flocks.length < BIRDS.flocks && (this.wait -= dt) <= 0) {
      this.arrive(view);
      this.wait = 6 + this.r() * 14;
    }
    if (!this.flocks.length) {
      this.mesh.visible = false;
      return;
    }
    let gone = false;
    for (const f of this.flocks) {
      f.t += dt;
      f.stay -= flying ? dt : 4 * dt; // (in a hurry once the rain starts)
      const dx = f.homeX - f.x, dy = f.homeY - f.y, d = Math.hypot(dx, dy) || 1;
      let want = f.h;
      if (f.stay > 0) {
        // Round the spot: along the ring, and in or out towards it by how far off it is.
        const off = THREE.MathUtils.clamp((d - f.ring) / f.ring, -1, 1);
        want = Math.atan2(dy, dx) - f.turn * (Math.PI / 2) * (1 - off);
      }
      const turn = THREE.MathUtils.clamp(Math.atan2(Math.sin(want - f.h), Math.cos(want - f.h)), -1, 1) * 0.55;
      f.h += turn * dt;
      f.bank += (turn * 0.9 - f.bank) * Math.min(1, dt * 2);
      f.x += Math.cos(f.h) * f.kind.speed * dt;
      f.y += Math.sin(f.h) * f.kind.speed * dt;
      if (Math.hypot(f.x - view.x, f.y - view.y) > view.radius + BIRDS.beyond + 40 && (f.stay <= 0 || Math.hypot(f.homeX - view.x, f.homeY - view.y) > view.radius + f.ring + BIRDS.beyond)) {
        gone = true;
        f.birds.length = 0;
      }
    }
    if (gone) {
      // Close the ranks: every flock's birds stay together in the instance buffer.
      this.flocks = this.flocks.filter((f) => f.birds.length);
      let first = 0;
      for (const f of this.flocks) {
        for (let i = 0; i < f.birds.length; i++) if (f.first !== first) { this.mesh.getColorAt(f.first + i, _c); this.mesh.setColorAt(first + i, _c); }
        f.first = first;
        first += f.birds.length;
      }
    }
    let n = 0;
    for (const f of this.flocks) {
      const k = f.kind, cos = Math.cos(f.h), sin = Math.sin(f.h);
      // (Too near the camera a bird would fill the screen.)
      const floor = view.ground(view.x, view.y), alt = Math.min(f.alt, floor + view.height - BIRDS.low);
      const near = THREE.MathUtils.smoothstep(alt - floor, BIRDS.roofs - 8, BIRDS.roofs);
      _q.setFromAxisAngle(UP, f.h).multiply(_roll.setFromAxisAngle(FORWARD, -f.bank));
      for (const b of f.birds) {
        const w = f.t * b.drift + b.phase;
        const along = b.along + Math.sin(w) * k.spread * 0.18, across = b.across + Math.sin(w * 1.3 + 1) * k.spread * 0.16;
        // Beating, with spells of gliding on spread wings.
        const beating = THREE.MathUtils.smoothstep(Math.sin(f.t * 0.45 + b.phase * 3) * 0.5 + 0.5, k.glide - 0.1, k.glide + 0.1);
        const flap = 1 - beating * 0.5 * (0.5 + 0.5 * Math.sin(f.t * b.beat * Math.PI * 2 + b.phase));
        const size = BIRDS.size * b.size * near;
        _p.set(f.x + cos * along - sin * across, alt + b.up + Math.sin(w * 0.7) * 1.5, -(f.y + sin * along + cos * across));
        this.mesh.setMatrixAt(n++, _m.compose(_p, _q, _s.set(size * k.long, size, size * k.span * flap)));
      }
    }
    this.mesh.count = n;
    this.mesh.visible = n > 0;
    sendInstances(this.mesh);
  }

  clear() {
    this.flocks.length = 0;
    this.mesh.count = 0;
    this.mesh.visible = false;
  }
}
