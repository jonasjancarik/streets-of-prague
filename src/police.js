import * as THREE from 'three';
import { Car } from './car.js';
import { Polyline, clamp } from './network.js';
import { project, speedLimit, turnOf } from './assist.js';
import { personMesh } from './people.js';

// The police and your wanted level, GTA 2 style.
//
// Crimes build up heat, and heat is shown as stars. A crime the police see counts
// three times as much as one somebody phones in: knocking people over, pulling
// drivers out of their cars, wrecking traffic, ramming or stealing a police car.
// Speeding past a police car (20 km/h over the limit) gets you one star.
//
// A few police cars patrol with the traffic. Once you're wanted, cars chase you along
// the street network, more of them the more stars you have, and ram you. When you're
// on foot or stopped, an officer gets out and runs after you: if they reach you,
// you're busted. Stay out of their sight for a while and you lose a star at a time.

const STARS = [1, 4, 9, 16, 25]; // heat for each star
const CHASERS = [0, 1, 2, 3, 4, 6]; // police cars after you, by stars
const PATROLS = 3;
const POINTS = { knock: 1, carjack: 1, wreck: 0.6, hitCop: 2, stealCop: 3 };
const COOLDOWN = { hitCop: 1 }; // one scrape shouldn't count ten times
const RUN = 6.4; // officers on foot, m/s: you can outrun them, but not walking
const WRECKED = 45; // damage that puts a police car out of the chase

// Points of `poly` from s0 to s1 (backwards if s1 < s0), as [x, y].
function slice(poly, s0, s1) {
  const a = poly.at(s0), b = poly.at(s1), out = [[a.x, a.y]];
  const { pts, cum } = poly;
  if (s1 >= s0) { for (let i = 0; i < pts.length; i++) if (cum[i] > s0 && cum[i] < s1) out.push(pts[i]); }
  else for (let i = pts.length - 1; i >= 0; i--) if (cum[i] < s0 && cum[i] > s1) out.push(pts[i]);
  out.push([b.x, b.y]);
  return out;
}

// Smallest-first queue of [cost, value] for the route search.
class Heap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(item) {
    const a = this.a;
    a.push(item);
    for (let i = a.length - 1; i > 0;) {
      const p = (i - 1) >> 1;
      if (a[p][0] <= a[i][0]) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop() {
    const a = this.a, top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last;
      for (let i = 0; ;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

export class Police {
  constructor({ scene, drive, traffic, grid, rng, edgesNear, offscreen, onBusted }) {
    Object.assign(this, { scene, drive, traffic, grid, r: rng, edgesNear, offscreen, onBusted });
    this.heat = 0;
    this.cars = []; // chasing: { car, path, s, replan, stuck, reverse, calm, wrecked }
    this.officers = [];
    this.seen = false; // the police can see you right now
    this.lose = 0; // seconds out of sight
    this.cool = {};
    this.spawnT = 0;
    this.checkT = 0;
    this.limit = 50;
    // Street network for chasing, both ways along every street (the police ignore one-way signs).
    this.nodes = new Map();
    this.links = new Map();
    this.linked = 0;

    const lamp = new THREE.BoxGeometry(0.26, 0.14, 0.3);
    this.lamps = new THREE.InstancedMesh(lamp, new THREE.MeshBasicMaterial(), 32);
    const glow = new THREE.CircleGeometry(5, 28);
    glow.rotateX(-Math.PI / 2);
    this.glow = new THREE.InstancedMesh(glow, new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending, depthWrite: false }), 16);
    for (const m of [this.lamps, this.glow]) {
      m.count = 0;
      m.frustumCulled = false;
      m.setColorAt(0, new THREE.Color());
      scene.add(m);
    }
    this.dummy = new THREE.Object3D();
  }

  get stars() { return STARS.filter((t) => this.heat >= t).length; }

  // Police cars that are after you, not wrecked or given up.
  get chasing() { return this.cars.filter((p) => !p.calm && !p.wrecked); }

  // Everyone who can spot you: patrols, chasing cars and officers on foot.
  *eyes() {
    for (const a of this.traffic.agents) if (a.car.type === 'police') yield a.car;
    for (const p of this.cars) if (!p.wrecked) yield p.car;
    for (const o of this.officers) if (o.down <= 0) yield o;
  }

  clear(ax, ay, bx, by) {
    const d = Math.hypot(bx - ax, by - ay), n = Math.ceil(d / 2);
    for (let i = 1; i < n; i++) if (this.grid.at(ax + ((bx - ax) * i) / n, ay + ((by - ay) * i) / n) === 255) return false;
    return true;
  }

  sees(x, y, far = 110) {
    for (const e of this.eyes()) {
      const d = Math.hypot(e.x - x, e.y - y);
      if (d < 40 || (d < far && this.clear(e.x, e.y, x, y))) return true;
    }
    return false;
  }

  crime(kind, x, y) {
    if (this.cool[kind] > 0) return;
    this.cool[kind] = COOLDOWN[kind] || 0;
    const seen = this.sees(x, y);
    this.heat = Math.min(40, this.heat + POINTS[kind] * (seen ? 1.5 : 0.5));
    if (seen) this.lose = 0;
  }

  // You got into a police car: whoever was in it gets out and comes after you.
  take(car) {
    const i = this.cars.findIndex((p) => p.car === car);
    if (i >= 0) this.cars.splice(i, 1);
    if (car.crew) this.getOut(car);
    this.crime('stealCop', car.x, car.y);
  }

  knock(o, vx, vy) {
    Object.assign(o, { down: 3, vx, vy, h: Math.atan2(vy, vx) + Math.PI });
  }

  // Dev teleport: the chase doesn't follow you across town.
  reset() {
    for (const o of this.officers) this.scene.remove(o.mesh);
    this.officers = [];
    this.cars = [];
  }

  // ---- Street network ----------------------------------------------------

  sync() {
    const edges = this.drive.edges;
    for (; this.linked < edges.length; this.linked++) {
      const e = edges[this.linked];
      e.mid = e.mid || new Polyline(e.pts);
      this.nodes.set(e.u, e.pts[0]);
      this.nodes.set(e.v, e.pts[e.pts.length - 1]);
      for (const [a, b, back] of [[e.u, e.v, false], [e.v, e.u, true]]) {
        if (!this.links.has(a)) this.links.set(a, []);
        this.links.get(a).push({ to: b, e, back });
      }
    }
  }

  nearestStreet(x, y) {
    let best = null;
    for (const e of this.edgesNear(x, y, 40)) {
      e.mid = e.mid || new Polyline(e.pts);
      const p = project(e.mid, x, y);
      if (p.d < 40 && (!best || p.d < best.d)) best = { e, s: p.s, d: p.d };
    }
    return best;
  }

  // Shortest way by road from (ax, ay) to (bx, by), as a Polyline, or null.
  route(ax, ay, bx, by) {
    this.sync();
    const A = this.nearestStreet(ax, ay), B = this.nearestStreet(bx, by);
    if (!A || !B) return null;
    const lenA = A.e.mid.length, lenB = B.e.mid.length;
    let pts;
    if (A.e === B.e || A.e.twin === B.e) {
      const sb = A.e === B.e ? B.s : lenA - B.s;
      pts = slice(A.e.mid, A.s, sb);
    } else {
      const goal = new Map([[B.e.u, B.s], [B.e.v, lenB - B.s]]);
      const [gx, gy] = [bx, by];
      const g = new Map(), from = new Map(), heap = new Heap();
      for (const [n, cost] of [[A.e.u, A.s], [A.e.v, lenA - A.s]]) {
        g.set(n, cost);
        heap.push([cost, n]);
      }
      let end = null;
      for (let pops = 0; heap.size && pops < 6000; pops++) {
        const [f, n] = heap.pop();
        const gn = g.get(n);
        const [nx, ny] = this.nodes.get(n);
        if (f > gn + Math.hypot(gx - nx, gy - ny) + 1e-6) continue; // stale entry
        if (goal.has(n)) { end = n; break; }
        for (const l of this.links.get(n) || []) {
          const c = gn + l.e.mid.length;
          if (c >= (g.get(l.to) ?? Infinity)) continue;
          g.set(l.to, c);
          from.set(l.to, l);
          const [tx, ty] = this.nodes.get(l.to);
          heap.push([c + Math.hypot(gx - tx, gy - ty), l.to]);
        }
      }
      if (end === null) return null;
      const chain = [];
      let first = end;
      for (let l = from.get(end); l; l = from.get(first)) { chain.unshift(l); first = l.back ? l.e.v : l.e.u; }
      pts = slice(A.e.mid, A.s, first === A.e.u ? 0 : lenA);
      for (const l of chain) pts.push(...(l.back ? [...l.e.pts].reverse() : l.e.pts));
      pts.push(...slice(B.e.mid, end === B.e.u ? 0 : lenB, B.s));
    }
    return new Polyline([[ax, ay], ...pts, [bx, by]]);
  }

  // ---- Cars --------------------------------------------------------------

  // A new police car on a street out of view, 90–250 m from (x, y).
  spawn(x, y) {
    const edges = this.edgesNear(x, y, 250);
    for (let t = 0; t < 30 && edges.length; t++) {
      const e = edges[Math.floor(this.r() * edges.length)];
      if (e.bridge || e.path.length < 12) continue;
      const q = e.path.at(this.r() * e.path.length), d = Math.hypot(q.x - x, q.y - y);
      if (d < 90 || d > 250 || !this.offscreen(q.x, q.y)) continue;
      const car = new Car('police', this.r, q.x, q.y, q.ang);
      if (car.worldSamples().some(([sx, sy]) => this.grid.at(sx, sy))) continue;
      this.enlist(car);
      return true;
    }
    return false;
  }

  enlist(car) {
    car.mode = 'police';
    car.crew = true;
    this.cars.push({ car, path: null, s: 0, replan: 0, stuck: 0, reverse: 0, calm: false, wrecked: false });
  }

  // Steering and pedals for a car chasing the player.
  chase(p, dt, me) {
    const c = p.car, vf = c.forwardSpeed;
    const dx = me.x - c.x, dy = me.y - c.y, dist = Math.hypot(dx, dy);
    let tx, ty, want;
    if (dist < 40 && this.clear(c.x, c.y, me.x, me.y)) {
      // In sight: straight at you. Drive into your car; stop short of you on foot.
      tx = me.x + me.vx * Math.min(0.8, dist / 25);
      ty = me.y + me.vy * Math.min(0.8, dist / 25);
      want = me.car ? Math.max(12, me.speed + 6) : dist < 12 ? 0 : clamp((dist - 10) * 0.8, 3, 12);
    } else {
      p.replan -= dt;
      if (!p.path || p.replan < 0 || p.s > p.path.length - 6) {
        p.path = this.route(c.x, c.y, me.x, me.y);
        p.s = 0;
        p.replan = 1.2 + this.r() * 0.8;
      }
      if (!p.path) { tx = me.x; ty = me.y; want = 8; }
      else {
        const q = project(p.path, c.x, c.y, p.s - 10, p.s + 40);
        p.s = q.s;
        if (q.d > 12) p.replan = 0;
        const L = 6 + Math.abs(vf) * 0.6, t = p.path.at(p.s + L);
        tx = t.x;
        ty = t.y;
        // Slow down for the bends coming up.
        let bend = 0;
        for (const d of [8, 18, 30]) bend = Math.max(bend, Math.abs(turnOf(c.h, p.path.at(p.s + d).ang)));
        want = clamp(24 - bend * 14, 7, 24);
      }
    }
    // An officer out on foot: the car waits.
    if (!c.crew) want = 0;
    const alpha = turnOf(c.h, Math.atan2(ty - c.y, tx - c.x));
    let steer = clamp(alpha * 2.2, -1, 1);
    let throttle = vf < want - 1 ? 1 : vf > want + 2 ? -1 : 0;
    if (throttle > 0 && Math.abs(vf) < 1.2) p.stuck += dt;
    else p.stuck = Math.max(0, p.stuck - dt);
    if (p.stuck > 1.2) { p.reverse = 1.1; p.stuck = 0; }
    if (p.reverse > 0) {
      p.reverse -= dt;
      throttle = -1;
      steer = -steer;
    }
    // Close enough and you're not going anywhere: an officer gets out.
    if (c.crew && Math.abs(vf) < 2.5 && (me.car ? me.speed < 2 && dist < 14 : dist < 18)) this.getOut(c);
    return { throttle, steer, handbrake: want === 0 && Math.abs(vf) < 3 };
  }

  // ---- Officers on foot --------------------------------------------------

  getOut(car) {
    car.crew = false;
    const lx = -Math.sin(car.h), ly = Math.cos(car.h);
    let x = car.x + lx * (car.spec.W / 2 + 0.7), y = car.y + ly * (car.spec.W / 2 + 0.7);
    if (this.grid.at(x, y)) { x = car.x - lx * (car.spec.W / 2 + 0.7); y = car.y - ly * (car.spec.W / 2 + 0.7); }
    const mesh = personMesh('#1f3a68', '#e3b99a', '#15233f');
    mesh.rotation.order = 'YXZ';
    this.scene.add(mesh);
    this.officers.push({ x, y, h: car.h, vx: 0, vy: 0, car, mesh, down: 0, phase: 0, back: false });
  }

  blocked(x, y) {
    const g = this.grid, r = 0.3;
    return g.at(x, y) || g.at(x + r, y) || g.at(x - r, y) || g.at(x, y + r) || g.at(x, y - r);
  }

  walk(o, dt, me) {
    if (o.down > 0) {
      o.down -= dt;
      const k = Math.exp(-4 * dt);
      o.vx *= k;
      o.vy *= k;
    } else {
      const ride = this.cars.find((p) => p.car === o.car && !p.wrecked);
      // Back to the car when you drive off (or the chase is over); after you otherwise.
      const toMe = Math.hypot(me.x - o.x, me.y - o.y);
      o.back = this.heat <= 0 || (ride && me.car && me.speed > 6 && toMe > 12);
      // No car to go back to: they walk off.
      const tx = !o.back ? me.x : ride ? o.car.x : 2 * o.x - me.x, ty = !o.back ? me.y : ride ? o.car.y : 2 * o.y - me.y;
      const dx = tx - o.x, dy = ty - o.y, d = Math.hypot(dx, dy) || 1;
      const sp = o.back && !ride ? 1.4 : RUN;
      o.vx = (dx / d) * sp;
      o.vy = (dy / d) * sp;
      o.h = Math.atan2(dy, dx);
      if (o.back && ride && d < 2.6) { o.gone = true; o.car.crew = true; return; }
      if (!o.back && this.heat > 0) {
        const reach = me.car ? me.car.spec.L / 2 + 1 : 1.1;
        if (toMe < reach && (!me.car || me.speed < 2)) this.onBusted();
      }
    }
    const nx = o.x + o.vx * dt, ny = o.y + o.vy * dt;
    if (!this.blocked(nx, o.y)) o.x = nx;
    if (!this.blocked(o.x, ny)) o.y = ny;
    o.phase += Math.hypot(o.vx, o.vy) * dt * 2.2;
    if (o.back && !this.cars.some((p) => p.car === o.car) && this.offscreen(o.x, o.y)) o.gone = true;
  }

  // ---- Every frame -------------------------------------------------------

  // `me`: { x, y, vx, vy, speed, car } for the player (car is null on foot).
  update(dt, me) {
    for (const k in this.cool) this.cool[k] -= dt;
    const stars = this.stars;

    // Patrols ride along with the traffic.
    const patrols = this.traffic.agents.filter((a) => a.car.type === 'police');
    for (const a of patrols) a.car.crew = true;
    this.spawnT -= dt;
    if (patrols.length < PATROLS && this.spawnT < 0) {
      this.spawnT = 2;
      this.traffic.spawn((x, y) => {
        const d = Math.hypot(x - me.x, y - me.y);
        return d > 80 && d < 320 && this.offscreen(x, y);
      }, this.edgesNear(me.x, me.y, 320), 'police');
    }

    // Speeding past the police.
    this.checkT -= dt;
    if (this.checkT < 0) {
      this.checkT = 0.5;
      if (me.car) this.limit = speedLimit(this.nearestStreet(me.x, me.y)?.e);
      if (me.car && me.speed * 3.6 > this.limit + 20 && this.sees(me.x, me.y, 60)) this.heat = Math.max(this.heat, STARS[0]);
    }

    // Out of sight long enough, you lose a star.
    this.seen = stars > 0 && this.sees(me.x, me.y);
    if (stars === 0 || this.seen) this.lose = 0;
    else if ((this.lose += dt) > 8 + 3 * stars) {
      this.heat = stars >= 2 ? STARS[stars - 2] : 0;
      this.lose = 0;
    }

    // As many cars on your tail as your stars call for: patrols nearby join in first.
    const want = CHASERS[this.stars];
    let chasing = this.chasing;
    for (const a of patrols) {
      if (chasing.length >= want) break;
      if (Math.hypot(a.car.x - me.x, a.car.y - me.y) > 250) continue;
      this.traffic.release(a);
      this.enlist(a.car);
      chasing = this.chasing;
    }
    if (chasing.length < want && this.spawnT < 0) {
      this.spawnT = 1.5;
      this.spawn(me.x, me.y);
    }
    if (chasing.length > want) {
      const far = [...chasing].sort((a, b) => Math.hypot(b.car.x - me.x, b.car.y - me.y) - Math.hypot(a.car.x - me.x, a.car.y - me.y));
      for (const p of far.slice(0, chasing.length - want)) p.calm = true;
    }

    for (const p of this.cars) {
      const c = p.car;
      if (!p.wrecked && c.damage > WRECKED) p.wrecked = true;
      let ctl = null;
      if (!p.wrecked && !p.calm) ctl = this.chase(p, dt, me);
      else if (!p.wrecked) ctl = { throttle: c.forwardSpeed > 0.3 ? -1 : 0, steer: 0, handbrake: false };
      if (p.wrecked) c.mode = 'loose';
      c.update(dt, ctl, this.grid);
      const d = Math.hypot(c.x - me.x, c.y - me.y);
      const waiting = this.officers.some((o) => o.car === c);
      p.gone = !waiting && this.offscreen(c.x, c.y) && (p.calm || p.wrecked ? d > 120 : d > 450);
    }
    this.cars = this.cars.filter((p) => !p.gone);

    for (const o of this.officers) this.walk(o, dt, me);
    for (const o of this.officers) if (o.gone) this.scene.remove(o.mesh);
    this.officers = this.officers.filter((o) => !o.gone);
  }

  // After an arrest: the stars go, the officers go back to their cars.
  forgive() {
    this.heat = 0;
    this.lose = 0;
    for (const p of this.cars) p.calm = true;
  }

  render(height, time) {
    const d = this.dummy, col = new THREE.Color(), blue = new THREE.Color('#3d7bff'), dim = new THREE.Color('#0d1a3a');
    const flip = Math.floor(time * 5) % 2;
    let n = 0, g = 0;
    for (const p of this.cars) {
      if (p.calm || p.wrecked) continue;
      const c = p.car, S = c.spec, mid = (S.cabin[0] + S.cabin[1]) / 2;
      const fx = Math.cos(c.h), fy = Math.sin(c.h);
      const base = height(c.x, c.y);
      for (const side of [-1, 1]) {
        if (n >= this.lamps.instanceMatrix.count) break;
        const off = side * S.W * 0.24;
        d.position.set(c.x + fx * mid - fy * off, base + S.H + 0.18, -(c.y + fy * mid + fx * off));
        d.rotation.set(0, c.h, 0);
        d.scale.setScalar(1);
        d.updateMatrix();
        this.lamps.setMatrixAt(n, d.matrix);
        this.lamps.setColorAt(n, (side > 0) === !!flip ? blue : dim);
        n++;
      }
      if (g < this.glow.instanceMatrix.count) {
        d.position.set(c.x, base + 0.2, -c.y);
        d.rotation.set(0, 0, 0);
        d.updateMatrix();
        this.glow.setMatrixAt(g, d.matrix);
        this.glow.setColorAt(g, col.set('#2a5cff').multiplyScalar(0.25 + 0.2 * Math.abs(Math.sin(time * 8))));
        g++;
      }
    }
    for (const [m, k] of [[this.lamps, n], [this.glow, g]]) {
      m.count = k;
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
    for (const o of this.officers) {
      const down = o.down > 0;
      o.mesh.position.set(o.x, height(o.x, o.y) + (down ? 0.25 : Math.abs(Math.sin(o.phase)) * 0.06), -o.y);
      o.mesh.rotation.set(0, o.h, down ? Math.PI / 2 : Math.sin(o.phase) * 0.07);
    }
  }
}
