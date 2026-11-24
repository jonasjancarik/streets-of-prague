import type { Crowd, Pedestrian } from './people.ts';
import type { WalkEdge, WalkGraph } from './network.ts';
import type { Point2 } from './map/geo.ts';
import { Heap } from './pathfinding.ts';
import { brightUmbrella } from './umbrellas.ts';

// Guided tour groups round the sights of the old town, by day. A guide holds up a bright
// umbrella, rain or shine, and walks slowly from sight to sight along the footpaths, the
// group a few metres behind in twos; at each sight the group gathers round the guide in a
// half circle for a minute or two, then they walk on. After a few sights the tour ends and
// everyone goes their own way.
//
// They're people of the crowd (src/people.ts). The guide walks the paths like anyone,
// on a planned way (`route`); the group are in its 'hold' state, each making for a place
// on the guide's trail, or round the guide at a sight. A group starts at a sight out of
// sight of you, as if it had been there a while. Frightened off or knocked over, someone
// leaves the group; without its guide, the group breaks up.

// Where groups stop, [name, lon, lat]: a spot in front of each sight where a group can
// stand, picked by hand from OpenStreetMap's position of the sight, like the footfall
// map's tourist hotspots (pipeline/build_footfall.py). Which sights tours stop at and
// the ways they take between them aren't published anywhere: these are the usual ones.
export const TOUR_STOPS: [string, number, number][] = [
  ['Orloj', 14.42070, 50.08686],
  ['Jan Hus', 14.42113, 50.08758],
  ['Týn', 14.42150, 50.08752],
  ['Malé náměstí', 14.41956, 50.08667],
  ['Estates Theatre', 14.42380, 50.08620],
  ['Powder Tower', 14.42735, 50.08718],
  ['Klementinum', 14.41640, 50.08628],
  ['Bethlehem Chapel', 14.41775, 50.08425],
  ['Old Town Bridge Tower', 14.41395, 50.08622],
  ['Charles Bridge, St John of Nepomuk', 14.41075, 50.08659],
  ['Malá Strana Bridge Tower', 14.40720, 50.08722],
  ['Lennon Wall', 14.40681, 50.08624],
  ['Kampa', 14.40850, 50.08640],
  ['Malostranské náměstí', 14.40380, 50.08816],
  ['Nerudova', 14.39900, 50.08840],
  ['Hradčanské náměstí', 14.39717, 50.08950],
  ['St Vitus', 14.40040, 50.09060],
  ['Golden Lane', 14.40383, 50.09185],
  ['Old-New Synagogue', 14.41858, 50.08990],
  ['Rudolfinum', 14.41600, 50.08975],
  ['National Theatre', 14.41400, 50.08090],
  ['Wenceslas', 14.42955, 50.07990],
  ['Můstek', 14.42400, 50.08400],
];

export const TOURS = {
  most: 3, // groups about at once where the sights are thickest
  reach: 420, // m: sights this near you can have a group
  size: [7, 16], // people in a group, the guide besides
  pace: 0.9, // m/s: the guide's walk (the group keeps up)
  talk: [40, 110], // s at each sight
  sights: [2, 5], // visited before the tour ends
  leg: [120, 650], // m: from one sight to the next, as the crow flies
  straggle: 5, // m: the guide waits while anyone is this far behind their place
  stall: 45, // s: walking this long without getting 5 m further, the group breaks up
};

interface Sight { name: string; x: number; y: number }
interface Member { p: Pedestrian; hold: { x: number; y: number; h: number }; back: number; side: number; away: boolean }
interface Group {
  guide: Pedestrian; hold: { x: number; y: number; h: number }; speed: number;
  members: Member[];
  // The guide's trail, newest last (x, y pairs).
  trail: number[];
  phase: 'talk' | 'walk' | 'lost';
  until: number; at: Sight; next: Sight | null; target: { e: WalkEdge; s: number } | null;
  visited: Sight[]; left: number;
  // Where the guide was when last checked, walking (a group that gets nowhere breaks up).
  check: { x: number; y: number; t: number };
}

export interface TourWorld {
  crowd: () => Crowd;
  walk: WalkGraph;
  toLocal: (lon: number, lat: number) => Point2;
  player: () => { x: number; y: number };
  offscreen: (x: number, y: number) => boolean;
  road: (x: number, y: number) => boolean;
  share: () => number; // 0 to 1: how many of the most there are now (the hour, rain, graphics)
  far: number; // m from you: a group further away is broken up
  rng: () => number;
}

export class Tours {
  groups: Group[] = [];
  sights: Sight[];
  // How many tours have ended, by why (for the tests).
  ended: Record<string, number> = {};
  private clock = 0;
  private spawnAt = 2;

  constructor(private w: TourWorld) {
    this.sights = TOUR_STOPS.map(([name, lon, lat]) => {
      const [x, y] = w.toLocal(lon, lat);
      return { name, x, y };
    });
  }

  update(dt: number) {
    this.clock += dt;
    const crowd = this.w.crowd(), me = this.w.player();
    for (let i = this.groups.length - 1; i >= 0; i--) {
      const g = this.groups[i];
      // (Gone, or taken for someone else: see Crowd.add.)
      const gone = crowd.people[g.guide.i] !== g.guide || g.guide.group !== g;
      if (gone || Math.hypot(g.guide.x - me.x, g.guide.y - me.y) > this.w.far) { this.end(g, gone ? 'guide gone' : 'far'); continue; }
      this.step(g, dt);
    }
    if (this.clock > this.spawnAt) {
      this.spawnAt = this.clock + 4 + this.w.rng() * 4;
      const near = this.sights.filter((s) => Math.hypot(s.x - me.x, s.y - me.y) < TOURS.reach).length;
      if (this.groups.length < Math.min(near, Math.round(TOURS.most * this.w.share()))) this.start();
    }
  }

  // A new group, gathered at a sight near you that you can't see, as if it had been there a
  // while. (The tests can pick the sight, in view or not, and the next one.)
  start(where?: Sight, seen = false, then?: Sight) {
    const me = this.w.player(), r = this.w.rng, crowd = this.w.crowd();
    const sights = where ? [where] : this.sights.filter((s) => {
      const d = Math.hypot(s.x - me.x, s.y - me.y);
      return d < TOURS.reach && (seen || this.w.offscreen(s.x, s.y)) && !this.groups.some((g) => Math.hypot(g.guide.x - s.x, g.guide.y - s.y) < 60);
    });
    const at = sights[Math.floor(r() * sights.length)];
    if (!at) return null;
    const spot = crowd.nearest(at.x, at.y);
    if (!spot) return null;
    const n = TOURS.size[0] + Math.floor(r() * (TOURS.size[1] - TOURS.size[0] + 1));
    // The people: passers-by out of sight (or anyone free, when asked for in view).
    const picked: Pedestrian[] = [];
    for (let k = 0; k < 400 && picked.length < n + 1; k++) {
      const p = crowd.people[Math.floor(r() * crowd.people.length)];
      if (p && free(p) && !picked.includes(p) && (seen || this.w.offscreen(p.x, p.y))) picked.push(p);
    }
    if (picked.length < Math.min(n + 1, TOURS.size[0] + 1)) return null;
    const guide = picked.pop()!, q = spot.e.path.at(spot.s);
    const hold = { x: q.x, y: q.y, h: 0 };
    const g: Group = {
      guide, hold, speed: guide.speed, members: picked.map((p, k) => ({ p, hold: { x: q.x, y: q.y, h: 0 }, back: 1.6 + Math.floor(k / 2) * 0.9 + (k % 2) * 0.45 + (r() - 0.5) * 0.4, side: ((k % 2) - 0.5) * 0.9 + (r() - 0.5) * 0.35, away: r() < 0.25 })),
      trail: [], phase: 'talk', until: this.clock + 10 + r() * 50, at, next: then ?? null, target: null, visited: [at],
      left: TOURS.sights[0] + Math.floor(r() * (TOURS.sights[1] - TOURS.sights[0] + 1)), check: { x: q.x, y: q.y, t: 0 },
    };
    Object.assign(guide, { e: spot.e, s: spot.s, x: q.x, y: q.y, state: 'hold', hold, kept: true, group: g, brolly: brightUmbrella(r() * 1e4), speed: TOURS.pace, route: undefined, pause: 0, stuck: 0, vx: 0, vy: 0, pace: 0 });
    for (const m of g.members) Object.assign(m.p, { state: 'hold', hold: m.hold, group: g, x: q.x, y: q.y, pause: 0, stuck: 0, vx: 0, vy: 0 });
    this.gather(g, this.openSide(q.x, q.y));
    // (Put straight onto their places round the guide.)
    for (const m of g.members) Object.assign(m.p, { x: m.hold.x, y: m.hold.y, h: m.hold.h, pace: 0 });
    guide.h = hold.h;
    this.groups.push(g);
    return g;
  }

  private step(g: Group, dt: number) {
    const crowd = this.w.crowd(), guide = g.guide;
    // Anyone frightened off, knocked over or taken elsewhere has left the group.
    let n = 0;
    for (const m of g.members) {
      if (crowd.people[m.p.i] === m.p && m.p.state === 'hold' && m.p.hold === m.hold) g.members[n++] = m;
      else if (m.p.group === g) m.p.group = undefined;
    }
    g.members.length = n;
    if (!g.members.length) { this.end(g, 'nobody left'); return; }
    if (g.phase === 'talk') {
      if (guide.state !== 'hold' || guide.hold !== g.hold) { g.phase = 'lost'; return; }
      if (this.clock < g.until) return;
      if (g.left <= 0) { this.end(g, 'done'); return; }
      if (!this.onward(g)) { this.end(g, 'nowhere to go'); return; }
    }
    if (g.phase === 'lost') {
      // Run off from a car, or knocked down: the group waits until the guide's walking
      // again, then they go on (or, not yet on their way, the guide goes back to them).
      if (guide.state !== 'walk') return;
      if (!g.target) {
        Object.assign(guide, { state: 'hold', hold: g.hold });
        g.phase = 'talk';
      } else if (this.plan(g, g.target)) g.phase = 'walk';
      else this.end(g, 'lost');
      return;
    }
    // Walking: the guide on its way, the group following along its trail.
    if (guide.state !== 'walk') { g.phase = 'lost'; return; }
    const t = g.trail, lx = t[t.length - 2], ly = t[t.length - 1];
    if (Math.hypot(guide.x - lx, guide.y - ly) > 0.4) {
      t.push(guide.x, guide.y);
      if (t.length > 240) t.splice(0, t.length - 200);
    }
    let behind = 0;
    for (const m of g.members) {
      this.onTrail(g, m.back, m.side, m.hold);
      behind = Math.max(behind, Math.hypot(m.p.x - m.hold.x, m.p.y - m.hold.y));
    }
    if (behind > TOURS.straggle) guide.pause = Math.max(guide.pause, 0.4);
    // Held up for good (a crowd, someone stuck behind a fence): the tour's over.
    if (Math.hypot(guide.x - g.check.x, guide.y - g.check.y) > 5) Object.assign(g.check, { x: guide.x, y: guide.y, t: this.clock });
    else if (this.clock - g.check.t > TOURS.stall) { this.end(g, 'held up'); return; }
    // Come to the sight.
    const goal = g.target!, q = goal.e.path.at(goal.s);
    const there = guide.e === goal.e && (!guide.route || !guide.route.length) && (guide.fwd ? guide.s >= goal.s - 0.3 : guide.s <= goal.s + 0.3);
    if (there || Math.hypot(guide.x - q.x, guide.y - q.y) < 1.2) {
      g.at = g.next!;
      g.visited.push(g.at);
      g.left--;
      g.phase = 'talk';
      g.until = this.clock + TOURS.talk[0] + this.w.rng() * (TOURS.talk[1] - TOURS.talk[0]);
      Object.assign(g.hold, { x: guide.x, y: guide.y });
      Object.assign(guide, { state: 'hold', hold: g.hold, route: undefined, vx: 0, vy: 0 });
      // Turned to face the group, which gathers in front.
      let cx = 0, cy = 0;
      for (const m of g.members) { cx += m.p.x; cy += m.p.y; }
      cx = cx / g.members.length - guide.x; cy = cy / g.members.length - guide.y;
      this.gather(g, Math.hypot(cx, cy) > 0.5 ? Math.atan2(cy, cx) : guide.h + Math.PI);
    } else if (!guide.route) {
      // Off the planned way (it stepped round something onto another path): planned again.
      if (!this.plan(g, goal)) this.end(g, 'lost');
    }
  }

  // On to the next sight: the nearest of a few not yet seen, by a way through the paths.
  private onward(g: Group) {
    const r = this.w.rng, here = g.guide;
    const near = g.next && !g.visited.includes(g.next) ? [g.next] : this.sights.filter((s) => {
      const d = Math.hypot(s.x - here.x, s.y - here.y);
      return !g.visited.includes(s) && d > TOURS.leg[0] && d < TOURS.leg[1];
    }).sort((a, b) => Math.hypot(a.x - here.x, a.y - here.y) - Math.hypot(b.x - here.x, b.y - here.y)).slice(0, 3);
    while (near.length) {
      const s = near.splice(Math.floor(r() * near.length), 1)[0], spot = this.w.crowd().nearest(s.x, s.y);
      if (!spot) continue;
      // The group lines up behind the guide, on its side, and they set off.
      let cx = 0, cy = 0;
      for (const m of g.members) { cx += m.p.x - here.x; cy += m.p.y - here.y; }
      const u = Math.atan2(cy, cx);
      Object.assign(here, { state: 'walk', hold: undefined, pause: 1 + r() });
      if (!this.plan(g, spot)) { Object.assign(here, { state: 'hold', hold: g.hold }); continue; }
      g.next = s;
      g.target = spot;
      g.phase = 'walk';
      g.trail.length = 0;
      g.trail.push(here.x + Math.cos(u) * 10, here.y + Math.sin(u) * 10, here.x, here.y);
      Object.assign(g.check, { x: here.x, y: here.y, t: this.clock });
      return true;
    }
    return false;
  }

  // The guide's way to `to`: the shortest through the footpaths loaded now.
  private plan(g: Group, to: { e: WalkEdge; s: number }) {
    const p = g.guide, way = walkRoute(this.w.walk, { e: p.e, s: p.s }, to, (e) => this.w.crowd().indoor(e, false));
    if (!way) return false;
    p.fwd = way.fwd;
    p.route = way.legs;
    return true;
  }

  // Where on the trail someone `back` m behind the guide, `side` m to the right of it, walks:
  // nearer the trail where that would be in a wall or out in the street.
  private onTrail(g: Group, back: number, side: number, out: { x: number; y: number; h: number }) {
    const t = g.trail, crowd = this.w.crowd();
    let x = g.guide.x, y = g.guide.y, left = back, ux = 1, uy = 0;
    for (let i = t.length - 2; i >= 0; i -= 2) {
      const dx = x - t[i], dy = y - t[i + 1], d = Math.hypot(dx, dy);
      if (d > 1e-3) { ux = dx / d; uy = dy / d; }
      if (d >= left) { x -= ux * left; y -= uy * left; left = 0; break; }
      x = t[i]; y = t[i + 1]; left -= d;
    }
    const onRoad = this.w.road(x, y);
    for (const k of [1, 0.5, 0]) {
      const px = x + uy * side * k, py = y - ux * side * k;
      if (k && (crowd.blocked(px, py) || (!onRoad && this.w.road(px, py)))) continue;
      out.x = px; out.y = py; out.h = Math.atan2(uy, ux);
      return;
    }
  }

  // The group round the guide in a half circle (two rows) on the side `toward`, facing them;
  // a few look about at the sight instead.
  private gather(g: Group, toward: number) {
    const crowd = this.w.crowd(), r = this.w.rng, n = g.members.length, front = Math.ceil(n * 0.55);
    const spots: { x: number; y: number }[] = [];
    for (let row = 0; row < 2; row++) {
      const count = row ? n - front : front, spread = Math.min(2.6, 0.42 * count + 0.4);
      for (let j = 0; j < count; j++) {
        const a = toward + (count > 1 ? (j / (count - 1) - 0.5) * spread : 0) + (r() - 0.5) * 0.12;
        let put: { x: number; y: number } | null = null;
        for (const radius of [2.3 + row * 0.95, 1.8 + row * 0.8, 3.4 + row]) {
          const x = g.guide.x + Math.cos(a) * radius, y = g.guide.y + Math.sin(a) * radius;
          if (!crowd.blocked(x, y) && !this.w.road(x, y) && !spots.some((s) => Math.hypot(s.x - x, s.y - y) < 0.6)) { put = { x, y }; break; }
        }
        if (put) spots.push(put);
      }
    }
    // Too little room round the guide (a narrow lane): the rest along the path either side.
    const guide = g.guide, roadside = this.w.road(guide.x, guide.y);
    for (let k = 0; spots.length < n && k < 24; k++) {
      const q = guide.e.path.at(guide.s + (k % 2 ? -1 : 1) * (1.3 + Math.floor(k / 4) * 0.6));
      const side = (k & 2 ? -0.45 : 0.45), x = q.x + Math.sin(q.ang) * side, y = q.y - Math.cos(q.ang) * side;
      if (!crowd.blocked(x, y) && (roadside || !this.w.road(x, y)) && !spots.some((o) => Math.hypot(o.x - x, o.y - y) < 0.5)) spots.push({ x, y });
    }
    g.hold.h = toward;
    g.guide.h = g.guide.state === 'hold' ? g.guide.h : toward;
    // Each to the nearest place left, nearest the guide first; anyone without one stays put.
    const order = [...g.members].sort((a, b) => Math.hypot(a.p.x - g.guide.x, a.p.y - g.guide.y) - Math.hypot(b.p.x - g.guide.x, b.p.y - g.guide.y));
    for (const m of order) {
      let best = -1, bd = Infinity;
      for (let k = 0; k < spots.length; k++) {
        const d = Math.hypot(spots[k].x - m.p.x, spots[k].y - m.p.y);
        if (d < bd) { bd = d; best = k; }
      }
      const s = best >= 0 ? spots.splice(best, 1)[0] : { x: m.p.x, y: m.p.y };
      const face = Math.atan2(g.guide.y - s.y, g.guide.x - s.x);
      Object.assign(m.hold, { x: s.x, y: s.y, h: m.away ? face + (r() - 0.5) * 2.4 : face + (r() - 0.5) * 0.3 });
    }
  }

  // The way with most room round a spot (where to gather a group that has just come).
  private openSide(x: number, y: number) {
    const crowd = this.w.crowd();
    let best = 0, most = -1;
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      let room = 0;
      for (const d of [1.5, 2.5, 3.5]) for (const o of [-0.5, 0, 0.5]) {
        const px = x + Math.cos(a + o) * d, py = y + Math.sin(a + o) * d;
        if (!crowd.blocked(px, py) && !this.w.road(px, py)) room++;
      }
      if (room > most) { most = room; best = a; }
    }
    return best;
  }

  // The tour is over (or can't go on): everyone goes their own way.
  end(g: Group, why = 'ended') {
    this.ended[why] = (this.ended[why] ?? 0) + 1;
    const crowd = this.w.crowd(), guide = g.guide;
    for (const m of g.members) {
      if (m.p.group === g) m.p.group = undefined;
      this.release(m.p, m.hold);
    }
    if (crowd.people[guide.i] === guide && guide.group === g) {
      Object.assign(guide, { kept: false, group: undefined, brolly: undefined, speed: g.speed, route: undefined });
      if (guide.state === 'hold' && guide.hold === g.hold) this.release(guide, g.hold);
    }
    g.members.length = 0;
    const i = this.groups.indexOf(g);
    if (i >= 0) this.groups.splice(i, 1);
  }

  private release(p: Pedestrian, hold: object) {
    const crowd = this.w.crowd();
    if (crowd.people[p.i] !== p || p.state !== 'hold' || p.hold !== hold) return;
    p.hold = undefined;
    const n = crowd.nearest(p.x, p.y);
    if (!n) { p.state = 'walk'; return; }
    if (this.w.offscreen(p.x, p.y)) {
      Object.assign(p, { state: 'walk', e: n.e, s: n.s });
      crowd.place(p);
    } else {
      const at = n.e.path.at(n.s);
      Object.assign(p, { state: 'rejoin', target: { e: n.e, s: n.s, x: at.x, y: at.y }, t: 0 });
    }
  }

  // For the tests: each sight, how far it lies from the nearest footpath loaded now (null:
  // none within reach), whether it's on open ground and, given a sight to start from, how
  // far it is to walk there from that one (null: no way through the paths loaded now).
  survey(from?: Sight) {
    const crowd = this.w.crowd(), start = from && crowd.nearest(from.x, from.y);
    return this.sights.map((s) => {
      const n = crowd.nearest(s.x, s.y), q = n?.e.path.at(n.s);
      let walk: number | null = null;
      if (start && n) {
        const way = walkRoute(this.w.walk, start, n, (e) => crowd.indoor(e, false));
        if (way) walk = way.legs.reduce((sum, l) => sum + l.e.path.length, 0);
      }
      return { name: s.name, x: s.x, y: s.y, path: q ? Math.hypot(q.x - s.x, q.y - s.y) : null, open: !crowd.blocked(s.x, s.y) && !this.w.road(s.x, s.y), walk };
    });
  }

  // For the tests: each group, where its guide is and what it's doing.
  report() {
    return this.groups.map((g) => ({
      id: g.guide.serial, x: g.guide.x, y: g.guide.y, phase: g.phase, at: g.at.name, next: g.next?.name ?? null, size: g.members.length, left: g.left,
      route: g.guide.route?.length ?? null, spread: Math.max(0, ...g.members.map((m) => Math.hypot(m.p.x - g.guide.x, m.p.y - g.guide.y))),
      behind: Math.max(0, ...g.members.map((m) => Math.hypot(m.p.x - m.hold.x, m.p.y - m.hold.y))),
      cx: g.members.reduce((a, m) => a + m.p.x, 0) / g.members.length, cy: g.members.reduce((a, m) => a + m.p.y, 0) / g.members.length,
    }));
  }
}

// Someone just walking about, free to join a group.
const free = (p: Pedestrian) => p.state === 'walk' && !p.kept && p.hurt === undefined && p.route === undefined;

// The shortest way through the footpaths from one spot on them to another, as the streets
// to take one after another and which way to set off along the first; null if they don't
// join up in the paths loaded now (or within `most` junctions). `skip`: paths not to walk.
export function walkRoute(walk: WalkGraph, from: { e: WalkEdge; s: number }, to: { e: WalkEdge; s: number }, skip: (e: WalkEdge) => boolean, most = 6000) {
  if (from.e === to.e) return { fwd: to.s >= from.s, legs: [] as { e: WalkEdge; fwd: boolean }[] };
  const goal = to.e.path.at(to.s), at = new Map<string, Point2>();
  const cost = new Map<string, number>(), came = new Map<string, { parent: string | null; e: WalkEdge; fwd: boolean }>(), open = new Heap();
  const relax = (node: string, c: number, where: Point2, parent: string | null, e: WalkEdge, fwd: boolean) => {
    if (c >= (cost.get(node) ?? Infinity)) return;
    cost.set(node, c);
    at.set(node, where);
    came.set(node, { parent, e, fwd });
    open.push([c + Math.hypot(goal.x - where[0], goal.y - where[1]), node]);
  };
  const fe = from.e, len = fe.path.length;
  relax(fe.u, from.s, fe.pts[0], null, fe, false);
  relax(fe.v, len - from.s, fe.pts[fe.pts.length - 1], null, fe, true);
  let end: string | null = null, endFwd = true, best = Infinity;
  for (let i = 0; open.size && i < most; i++) {
    const [score, node] = open.pop()!;
    if (score >= best) break;
    const c = cost.get(node)!, p = at.get(node)!;
    if (score > c + Math.hypot(goal.x - p[0], goal.y - p[1]) + 1e-5) continue;
    if (node === to.e.u && c + to.s < best) { best = c + to.s; end = node; endFwd = true; }
    if (node === to.e.v && c + to.e.path.length - to.s < best) { best = c + to.e.path.length - to.s; end = node; endFwd = false; }
    for (const { e, fwd } of walk.adj.get(node) ?? []) {
      if (e === to.e || skip(e)) continue;
      relax(fwd ? e.v : e.u, c + e.path.length * (e.side > 0 ? 1.08 : 1), fwd ? e.pts[e.pts.length - 1] : e.pts[0], node, e, fwd);
    }
  }
  if (end === null) return null;
  // Back from the end: each junction's way in, until the street they start on.
  const legs: { e: WalkEdge; fwd: boolean }[] = [{ e: to.e, fwd: endFwd }];
  for (let n = end; ;) {
    const step = came.get(n)!;
    if (step.parent === null) return { fwd: step.fwd, legs };
    legs.unshift({ e: step.e, fwd: step.fwd });
    n = step.parent;
  }
}
