import * as THREE from 'three';
import { clamp, segDist } from './network.js';
import { Figures, Anim, SCALE, randomLook, jumpHeight } from './figures.js';

// Pedestrians wander the footpath network, jump out of the way of fast cars,
// and get knocked over (then get up again) when they don't make it.

// Metres covered by one cycle of the walk and run clips, so feet keep pace with the ground.
const WALK_STRIDE = 1.6;
const RUN_STRIDE = 4;
const GETUP = 1.25; // seconds of getting up at the end of lying on the ground

const _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(SCALE, SCALE, SCALE);
const UP = new THREE.Vector3(0, 1, 0);

// Pick the clip for someone on their feet going at `speed` (negative: backwards).
export function locomote(a, dt, speed) {
  const sp = Math.abs(speed);
  if (sp < 0.2) { a.play('idle', false, 0.3); a.step(dt); }
  else if (sp > 4.5) { a.play('run', false, 0.2); a.step(dt, (speed / RUN_STRIDE) * a.duration); }
  else { a.play('walk', false, 0.2); a.step(dt, (speed / WALK_STRIDE) * a.duration); }
}

// Lying down after being knocked over, getting up for the last GETUP seconds.
export function knocked(a, dt, left) {
  if (left < GETUP) a.play('getup', false, 0.1);
  a.step(dt);
}

export class Crowd {
  constructor(walk, grid, scene, rng, count, kit) {
    this.walk = walk;
    this.grid = grid;
    this.r = rng;
    this.kit = kit;
    this.people = [];
    this.fig = new Figures(kit, count + 16);
    scene.add(this.fig.mesh);
    this.totalLen = walk.edges.reduce((a, e) => a + e.path.length, 0);
    this.cell = 16;
    this.segs = new Map();
    this.index(walk.edges);
    for (let i = 0; i < count; i++) this.add();
  }

  // Footpath segments bucketed for nearest(); called again as more of the map loads.
  index(edges) {
    for (const e of edges) {
      let acc = 0;
      for (let i = 0; i < e.pts.length - 1; i++) {
        const a = e.pts[i], b = e.pts[i + 1];
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const k = `${Math.floor((a[0] + b[0]) / 2 / this.cell)},${Math.floor((a[1] + b[1]) / 2 / this.cell)}`;
        if (!this.segs.has(k)) this.segs.set(k, []);
        this.segs.get(k).push({ e, a, b, s0: acc, len });
        acc += len;
      }
    }
  }

  // Closest point on the footpath network (used to rejoin after running away).
  nearest(x, y) {
    let best = null, bestD = Infinity;
    const cx = Math.floor(x / this.cell), cy = Math.floor(y / this.cell);
    for (let R = 1; R <= 4 && !best; R++) {
      for (let i = -R; i <= R; i++) {
        for (let j = -R; j <= R; j++) {
          for (const s of this.segs.get(`${cx + i},${cy + j}`) || []) {
            const d = segDist(x, y, s.a, s.b);
            if (d < bestD) {
              const dx = s.b[0] - s.a[0], dy = s.b[1] - s.a[1];
              const t = clamp(((x - s.a[0]) * dx + (y - s.a[1]) * dy) / (dx * dx + dy * dy || 1), 0, 1);
              bestD = d;
              best = { e: s.e, s: s.s0 + t * s.len };
            }
          }
        }
      }
    }
    return best;
  }

  add(at) {
    const r = this.r;
    if (this.people.length >= this.fig.capacity) {
      // Full: move someone who is out of the way instead.
      const p = this.people[Math.floor(r() * this.people.length)];
      Object.assign(p, { e: at?.e || p.e, s: at?.s ?? p.s, state: 'walk', vx: 0, vy: 0 });
      this.place(p);
      return p;
    }
    let e = at?.e, s = at?.s;
    if (!e) {
      let x = r() * this.totalLen;
      for (const f of this.walk.edges) if ((x -= f.path.length) < 0) { e = f; break; }
      e = e || this.walk.edges[0];
      s = r() * e.path.length;
    }
    const i = this.people.length;
    const p = {
      i, e, s, fwd: r() > 0.5, side: r() > 0.5 ? 1 : -1,
      speed: 1.1 + r() * 0.6, x: 0, y: 0, h: 0, vx: 0, vy: 0,
      state: 'walk', t: 0, pause: 0, z: 0, anim: new Anim(this.kit, 'walk', r() * 2),
    };
    p.look = randomLook(r);
    this.fig.look(i, p.look);
    this.fig.mesh.count = this.people.length + 1;
    this.people.push(p);
    this.place(p);
    return p;
  }

  // Someone goes home: the last in the list takes their slot.
  retire(p) {
    const last = this.people.pop();
    if (last !== p) {
      last.i = p.i;
      this.people[p.i] = last;
      this.fig.look(last.i, last.look);
    }
    this.fig.mesh.count = this.people.length;
  }

  // Put a person on their edge, on their side of the street, clear of buildings.
  place(p) {
    const q = p.e.path.at(p.s);
    let off = p.e.side * p.side;
    const nx = Math.sin(q.ang), ny = -Math.cos(q.ang);
    let x = q.x + nx * off, y = q.y + ny * off;
    for (let k = 0; k < 6 && this.grid.at(x, y); k++) {
      off *= 0.6;
      x = q.x + nx * off;
      y = q.y + ny * off;
    }
    p.x = x;
    p.y = y;
    p.h = p.fwd ? q.ang : q.ang + Math.PI;
  }

  blocked(x, y) { return this.grid.at(x, y) !== 0; }

  // Someone steps out of a car (a driver who's just been pulled out, say).
  spawnAt(x, y) {
    const p = this.add(this.nearest(x, y) || undefined);
    p.x = x;
    p.y = y;
    return p;
  }

  update(dt, threats) {
    const r = this.r;
    for (const p of this.people) {
      p.t -= dt;
      if (p.state === 'walk') {
        // Look out for fast cars heading this way.
        for (const c of threats) {
          const sp = Math.hypot(c.vx, c.vy);
          if (sp < 5) continue;
          const dx = p.x - c.x, dy = p.y - c.y;
          const dist = Math.hypot(dx, dy);
          if (dist > 6 + sp * 0.7) continue;
          const ux = c.vx / sp, uy = c.vy / sp;
          const ahead = dx * ux + dy * uy, side = dx * uy - dy * ux;
          if (ahead > -1 && Math.abs(side) < 3.2) {
            const s = side >= 0 ? 1 : -1;
            p.state = 'flee';
            p.t = 1 + r() * 0.8;
            p.vx = uy * s * 5.5;
            p.vy = -ux * s * 5.5;
            // Too close to just run: they leap out of the way.
            if (dist < 3 + sp * 0.35) p.anim.play('jump', true, 0.08);
            break;
          }
        }
      }
      if (p.state === 'walk') {
        if (p.pause > 0) { p.pause -= dt; }
        else {
          p.s += (p.fwd ? 1 : -1) * p.speed * dt;
          if (p.s < 0 || p.s > p.e.path.length) this.turn(p);
          if (r() < dt * 0.02) p.pause = 1 + r() * 4;
        }
        this.place(p);
      } else if (p.state === 'flee' || p.state === 'down' || p.state === 'rejoin') {
        if (p.state === 'down') {
          const k = Math.exp(-4 * dt);
          p.vx *= k;
          p.vy *= k;
        }
        if (p.state === 'rejoin') {
          const dx = p.target.x - p.x, dy = p.target.y - p.y, d = Math.hypot(dx, dy);
          if (d < 0.4 || p.t < -8) {
            p.state = 'walk';
            p.e = p.target.e;
            p.s = p.target.s;
          } else {
            p.vx = (dx / d) * 1.8;
            p.vy = (dy / d) * 1.8;
          }
        }
        const nx = p.x + p.vx * dt, ny = p.y + p.vy * dt;
        if (!this.blocked(nx, p.y)) p.x = nx; else p.vx *= -0.3;
        if (!this.blocked(p.x, ny)) p.y = ny; else p.vy *= -0.3;
        if (p.state !== 'down' && Math.hypot(p.vx, p.vy) > 0.3) p.h = Math.atan2(p.vy, p.vx);
        if (p.t < 0 && (p.state === 'flee' || p.state === 'down')) {
          const n = this.nearest(p.x, p.y);
          if (n) {
            const q = n.e.path.at(n.s);
            p.target = { e: n.e, s: n.s, x: q.x, y: q.y };
            p.state = 'rejoin';
            p.t = 0;
          } else p.state = 'walk';
        }
      }
      this.animate(p, dt);
    }
  }

  animate(p, dt) {
    const a = p.anim;
    if (p.state === 'down') knocked(a, dt, p.t);
    else if (a.name === 'jump' && !a.done) a.step(dt);
    else locomote(a, dt, p.state === 'walk' ? (p.pause > 0 ? 0 : p.speed) : Math.hypot(p.vx, p.vy));
    p.z = a.name === 'jump' ? jumpHeight(a.t, 0.7) : 0;
  }

  turn(p) {
    const node = p.s > p.e.path.length / 2 ? p.e.v : p.e.u;
    const opts = (this.walk.adj.get(node) || []).filter((o) => o.e !== p.e);
    // Busier streets are likelier, by the square root of how busy they are: in the
    // long run that keeps as many people on a street as its footfall says.
    const w = opts.map((o) => (this.footfall ? Math.sqrt(0.02 + this.footfall.edge(o.e)) : 1));
    let x = this.r() * w.reduce((a, b) => a + b, 0), k = 0;
    while (k < opts.length - 1 && (x -= w[k]) > 0) k++;
    const pick = opts.length ? opts[k] : { e: p.e, fwd: !p.fwd };
    p.e = pick.e;
    p.fwd = pick.fwd;
    p.s = p.fwd ? 0 : p.e.path.length;
  }

  knock(p, vx, vy) {
    p.state = 'down';
    p.t = 3 + this.r() * 2;
    p.vx = vx;
    p.vy = vy;
    p.h = Math.atan2(vy, vx) + Math.PI;
    p.anim.play('fall', true, 0.08);
  }

  render(height = () => 0) {
    const m = new THREE.Matrix4();
    for (const p of this.people) {
      m.compose(_p.set(p.x, height(p.x, p.y) + p.z, -p.y), _q.setFromAxisAngle(UP, p.h), _s);
      this.fig.set(p.i, m, p.anim);
    }
    this.fig.commit(this.people.length);
  }
}

// Nearest spot where a person fits (a free cell with free cells on all four sides),
// searching outward in rings up to maxR metres.
export function nearestWalkable(grid, x, y, maxR = 60) {
  for (let r = 0; r <= maxR; r += 1) {
    const n = Math.max(8, Math.round(r * 6));
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const px = x + Math.cos(a) * r, py = y + Math.sin(a) * r;
      if (grid.at(px, py) === 0 && grid.at(px + 1, py) === 0 && grid.at(px - 1, py) === 0 && grid.at(px, py + 1) === 0 && grid.at(px, py - 1) === 0) return [px, py];
    }
  }
  return [x, y];
}

// The player on foot: tank controls relative to where they face, Shift to run, Space
// to jump. `ctl` = { move -1..1, turn -1..1 (left +), run, jump, aim }. With `aim` =
// { h, mag } (the touch stick) you turn to face h and walk that way instead; a full
// push runs.
export class Walker {
  constructor(grid, kit) {
    this.grid = grid;
    this.x = this.y = 0;
    this.h = 0;
    this.z = 0;
    this.speed = 0;
    this.down = 0;
    this.vx = this.vy = 0;
    this.anim = new Anim(kit, 'idle');
    this.look = { shirt: '#d9612c', trousers: '#2f3a4f', skin: '#e3b99a', hair: '#3a2618', sleeves: false };
    this.fig = new Figures(kit, 1);
    this.fig.look(0, this.look);
    this.fig.mesh.count = 1;
    this.base = new THREE.Matrix4().makeScale(SCALE, SCALE, SCALE);
    this.mesh = new THREE.Group();
    this.mesh.add(this.fig.mesh);
    this.ring = new THREE.Mesh(
      new THREE.RingGeometry(0.7, 0.95, 32),
      new THREE.MeshBasicMaterial({ color: '#ffe08a', transparent: true, opacity: 0.95, depthWrite: false }),
    );
    this.ring.rotation.x = -Math.PI / 2;
    this.mesh.add(this.ring);
  }

  // In the air, high enough for a car to pass under your feet.
  get airborne() { return this.z > 0.5; }

  blocked(x, y) {
    const g = this.grid, r = 0.3;
    return g.at(x, y) || g.at(x + r, y) || g.at(x - r, y) || g.at(x, y + r) || g.at(x, y - r);
  }

  update(dt, ctl) {
    const a = this.anim;
    if (this.down > 0) {
      this.down -= dt;
      const k = Math.exp(-4 * dt);
      this.vx *= k;
      this.vy *= k;
      if (!this.blocked(this.x + this.vx * dt, this.y)) this.x += this.vx * dt;
      if (!this.blocked(this.x, this.y + this.vy * dt)) this.y += this.vy * dt;
      // A quicker get-up than the crowd's: you want to get going again.
      if (this.down < GETUP / 1.5) a.play('getup', false, 0.1);
      a.step(dt, a.name === 'getup' ? 1.5 : 1);
      this.z = 0;
      this.sync();
      return;
    }
    // Tank controls, like GTA 2: up/down move along the way you face, left/right turn.
    let { turn, move } = ctl, target;
    if (ctl.aim) {
      const off = Math.atan2(Math.sin(ctl.aim.h - this.h), Math.cos(ctl.aim.h - this.h));
      turn = Math.sign(off) * Math.min(1, Math.abs(off) * 3);
      this.h += Math.sign(off) * Math.min(Math.abs(off), 12 * dt);
      // Hardly move until you've turned round, so a sharp change doesn't drift sideways.
      const facing = Math.max(0, Math.cos(off));
      target = (ctl.aim.mag > 0.9 || ctl.run ? 7.5 : 3.6 * Math.min(1, ctl.aim.mag / 0.8)) * facing;
    } else {
      this.h += turn * (ctl.run ? 3.6 : 4.2) * dt;
      target = move > 0 ? move * (ctl.run ? 7.5 : 3.6) : move * 2;
    }
    const jumping = a.name === 'jump' && !a.done;
    if (ctl.jump && !jumping) a.play('jump', true, 0.06);
    this.speed += (target - this.speed) * Math.min(1, dt * 10);
    this.vx = Math.cos(this.h) * this.speed;
    this.vy = Math.sin(this.h) * this.speed;
    if (!this.blocked(this.x + this.vx * dt, this.y)) this.x += this.vx * dt;
    if (!this.blocked(this.x, this.y + this.vy * dt)) this.y += this.vy * dt;
    if (a.name === 'jump' && !a.done) a.step(dt);
    // Turning on the spot shuffles the feet.
    else locomote(a, dt, Math.abs(this.speed) > 0.2 ? this.speed : Math.abs(turn) * 0.9);
    this.z = a.name === 'jump' ? jumpHeight(a.t, 1.1) : 0;
    this.sync();
  }

  knock(vx, vy) {
    this.down = 2.2;
    this.vx = vx;
    this.vy = vy;
    this.h = Math.atan2(vy, vx) + Math.PI;
    this.anim.play('fall', true, 0.08);
  }

  sync() {
    const ground = this.grid.height ? this.grid.height(this.x, this.y) : 0;
    this.mesh.position.set(this.x, ground + this.z, -this.y);
    this.mesh.rotation.set(0, this.h, 0);
    this.ring.position.y = 0.05 - this.z;
    this.fig.set(0, this.base, this.anim);
    this.fig.commit(1);
  }
}
