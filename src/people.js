import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { clamp, segDist } from './network.js';

// Pedestrians wander the footpath network, jump out of the way of fast cars,
// and get knocked over (then get up again) when they don't make it.

const SCALE = 1.35;
const CLOTHES = ['#3b4a63', '#5c3a3a', '#2f2f33', '#6a6f5a', '#8a6d4e', '#a8a39a', '#264653', '#7b4b6a', '#c26a3d', '#4f6d7a', '#1f2a36', '#9c3b30'];
const SKIN = ['#e3b99a', '#d4a383', '#b9825f', '#8d5a3e', '#f0cdb3'];
const HAIR = ['#2a1d15', '#4a3222', '#8a6a44', '#1a1a1a', '#b9b1a6', '#6e4a2c'];

function personGeometry() {
  const torso = new THREE.CylinderGeometry(0.26, 0.2, 1.15, 10);
  torso.scale(0.75, 1, 1);
  torso.translate(0, 0.95, 0);
  const shoulders = new THREE.BoxGeometry(0.3, 0.2, 0.58);
  shoulders.translate(0, 1.45, 0);
  const body = mergeGeometries([torso, shoulders]);
  const head = new THREE.SphereGeometry(0.16, 12, 8);
  head.translate(0.02, 1.72, 0);
  const hair = new THREE.SphereGeometry(0.165, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2);
  hair.translate(-0.01, 1.75, 0);
  return { body, head, hair };
}

export function personMesh(clothes, skin = SKIN[0], hair = HAIR[0]) {
  const g = personGeometry();
  const group = new THREE.Group();
  for (const [geo, color] of [[g.body, clothes], [g.head, skin], [g.hair, hair]]) {
    const m = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color }));
    m.castShadow = true;
    group.add(m);
  }
  group.scale.setScalar(SCALE);
  return group;
}

export class Crowd {
  constructor(walk, grid, scene, rng, count) {
    this.walk = walk;
    this.grid = grid;
    this.r = rng;
    this.people = [];
    const g = personGeometry();
    const mk = (geo) => {
      const m = new THREE.InstancedMesh(geo, new THREE.MeshLambertMaterial(), count + 16);
      m.castShadow = true;
      m.count = 0;
      m.frustumCulled = false;
      scene.add(m);
      return m;
    };
    this.meshes = [mk(g.body), mk(g.head), mk(g.hair)];
    this.dummy = new THREE.Object3D();
    this.dummy.rotation.order = 'YXZ';
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
    if (this.people.length >= this.meshes[0].instanceMatrix.count) {
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
      state: 'walk', t: 0, pause: 0, phase: r() * 10,
    };
    const col = new THREE.Color();
    this.meshes[0].setColorAt(i, col.set(CLOTHES[Math.floor(r() * CLOTHES.length)]));
    this.meshes[1].setColorAt(i, col.set(SKIN[Math.floor(r() * SKIN.length)]));
    this.meshes[2].setColorAt(i, col.set(HAIR[Math.floor(r() * HAIR.length)]));
    for (const m of this.meshes) { m.count = this.people.length + 1; m.instanceColor.needsUpdate = true; }
    this.people.push(p);
    this.place(p);
    return p;
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
        p.phase += p.speed * dt * 5;
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
        p.phase += Math.hypot(p.vx, p.vy) * dt * 5;
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
    }
  }

  turn(p) {
    const node = p.s > p.e.path.length / 2 ? p.e.v : p.e.u;
    const opts = (this.walk.adj.get(node) || []).filter((o) => o.e !== p.e);
    const pick = opts.length ? opts[Math.floor(this.r() * opts.length)] : { e: p.e, fwd: !p.fwd };
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
  }

  render(height = () => 0) {
    const d = this.dummy;
    for (const p of this.people) {
      const down = p.state === 'down';
      d.position.set(p.x, height(p.x, p.y) + (down ? 0.25 : Math.abs(Math.sin(p.phase)) * 0.05), -p.y);
      d.rotation.set(0, p.h, down ? Math.PI / 2 : Math.sin(p.phase) * 0.06);
      d.scale.setScalar(SCALE);
      d.updateMatrix();
      for (const m of this.meshes) m.setMatrixAt(p.i, d.matrix);
    }
    for (const m of this.meshes) m.instanceMatrix.needsUpdate = true;
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

// The player on foot: tank controls relative to where they face, Shift to run.
// `ctl` = { move -1..1, turn -1..1 (left +), run }.
export class Walker {
  constructor(grid) {
    this.grid = grid;
    this.x = this.y = 0;
    this.h = 0;
    this.speed = 0;
    this.phase = 0;
    this.down = 0;
    this.vx = this.vy = 0;
    this.mesh = personMesh('#d9612c', SKIN[0], '#3a2618');
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.7, 0.95, 32),
      new THREE.MeshBasicMaterial({ color: '#ffe08a', transparent: true, opacity: 0.95, depthWrite: false }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.05;
    this.mesh.add(ring);
    this.mesh.rotation.order = 'YXZ';
  }

  blocked(x, y) {
    const g = this.grid, r = 0.3;
    return g.at(x, y) || g.at(x + r, y) || g.at(x - r, y) || g.at(x, y + r) || g.at(x, y - r);
  }

  update(dt, ctl) {
    if (this.down > 0) {
      this.down -= dt;
      const k = Math.exp(-4 * dt);
      this.vx *= k;
      this.vy *= k;
      if (!this.blocked(this.x + this.vx * dt, this.y)) this.x += this.vx * dt;
      if (!this.blocked(this.x, this.y + this.vy * dt)) this.y += this.vy * dt;
      this.sync();
      return;
    }
    // Tank controls, like GTA 2: up/down move along the way you face, left/right turn.
    const { turn, move } = ctl;
    this.h += turn * (ctl.run ? 3.6 : 4.2) * dt;
    const target = move > 0 ? move * (ctl.run ? 7.5 : 3.6) : move * 2;
    this.speed += (target - this.speed) * Math.min(1, dt * 10);
    this.vx = Math.cos(this.h) * this.speed;
    this.vy = Math.sin(this.h) * this.speed;
    if (!this.blocked(this.x + this.vx * dt, this.y)) this.x += this.vx * dt;
    if (!this.blocked(this.x, this.y + this.vy * dt)) this.y += this.vy * dt;
    this.phase += Math.max(Math.abs(this.speed), Math.abs(turn) * 1.2) * dt * 2.2;
    this.sync();
  }

  knock(vx, vy) {
    this.down = 1.6;
    this.vx = vx;
    this.vy = vy;
    this.h = Math.atan2(vy, vx) + Math.PI;
  }

  sync() {
    const down = this.down > 0;
    const ground = this.grid.height ? this.grid.height(this.x, this.y) : 0;
    this.mesh.position.set(this.x, ground + (down ? 0.25 : Math.abs(Math.sin(this.phase)) * 0.06), -this.y);
    this.mesh.rotation.set(0, this.h, down ? Math.PI / 2 : Math.sin(this.phase) * 0.07);
  }
}
