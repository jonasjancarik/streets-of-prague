import { HALF } from './trams.ts';
import type { Trams, TramVehicle, TramLine } from './trams.ts';
import { Route } from './tracks.ts';
import type { TrackNet, Option, Turn } from './tracks.ts';
import { clamp } from './network.ts';

// Driving a tram you've taken over. W pulls away, S brakes (Space brakes hard) and
// the tram rolls on its own when you let go. It follows the track, and at each
// junction it goes the way you picked (A/D, or the arrows in the strip) or, if you
// didn't, straight on. The track ahead is laid out only as far as the next junction,
// and the way is fixed a few seconds before you reach it.

const BACK = 60; // m of the line behind the tram that its route starts with
const AHEAD = 350; // m of track laid ahead of the front
const COMMIT = 25; // m before a junction at which the way through it is fixed
const ACCEL = 1.25, BRAKE = 1.5, HARD = 3.2, COAST = 0.12; // m/s²
const TOP = 19; // m/s (68 km/h)
const TURNING = 0.5; // rad the stick has to point off the track to pick a turn

export interface DriveControls { move: number; turn: number; brake: boolean; aim: { h: number; mag: number } | null }

export class TramDrive {
  v: TramVehicle;
  route: Route;
  options: Option[] = []; // the ways on at the next junction
  pref: Turn = 0;
  junction = Infinity; // m to the next junction (Infinity: none in sight)
  locked = false; // the doors are open: it stays where it is
  hit = 0; // the speed of the last knock against another tram (for a jolt), until it's read
  private pending = -1;
  private turning = 0;
  private start = 0; // where on the route the tram is at first

  constructor(private trams: Trams, private net: TrackNet, v: TramVehicle) {
    this.v = v;
    this.route = this.lay(v.line, v.s);
    trams.steal(v, this.route, this.start);
    this.extend();
  }

  // The stretch of the tram's line it sits on, as the first part of its route.
  private lay(line: TramLine, s: number) {
    const { pts } = line, n = pts.length, cum = [0];
    for (let i = 1; i < n; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    const L = cum[n - 1], s0 = (((s - BACK) % L) + L) % L;
    let i = 0;
    while (i < n - 2 && cum[i + 1] <= s0) i++;
    const route = new Route();
    this.start = BACK + (s0 - cum[i]);
    route.push(this.net.node(pts[i]), pts[i]);
    for (let k = 0; k < 2 * n && route.length < this.start + HALF + 15; k++) {
      i = i + 1 >= n ? 1 : i + 1;
      route.push(this.net.node(pts[i]), pts[i]);
    }
    return route;
  }

  // Pick the way at the next junction: `turn` if it has one.
  choose(turn: Turn) {
    if (this.options.some((o) => o.turn === turn)) this.pref = turn;
  }

  // One step left or right from the way picked.
  nudge(step: number) {
    const turns = this.options.map((o) => o.turn).sort((a, b) => a - b);
    const i = turns.indexOf(this.pref) + step;
    if (i >= 0 && i < turns.length) this.pref = turns[i];
  }

  ring() { this.v.ring = (this.v.ring ?? 0) + 1; }

  // The front of the tram on the track.
  private get front() { return this.v.s + HALF; }

  // Lay the track on ahead, and fix the way through a junction once it's near.
  private extend() {
    const { route, net, front } = this;
    for (let k = 0; k < 400 && route.length < front + AHEAD; k++) {
      const node = route.last, outs = net.outs[node];
      if (!outs.length) break;
      if (outs.length === 1) {
        route.push(outs[0], net.xy[outs[0]]);
        continue;
      }
      if (this.pending !== node) {
        const a = route.at(Math.max(0, route.length - 10)), b = net.xy[node];
        this.options = net.options(node, Math.atan2(b[1] - a.y, b[0] - a.x));
        this.pending = node;
        this.pref = 0;
      }
      if (route.length - front > COMMIT) break;
      const pick = this.options.find((o) => o.turn === this.pref) ?? this.options.find((o) => o.turn === 0) ?? this.options[0];
      route.push(pick.node, net.xy[pick.node]);
      this.pending = -1;
      this.options = [];
      this.pref = 0;
    }
    this.junction = this.pending >= 0 ? route.length - front : Infinity;
  }

  update(dt: number, ctl: DriveControls) {
    const { v } = this;
    // The way at the next junction: a tap of A or D moves the pick one step; a stick
    // held off to one side picks that side.
    let turn = Math.sign(ctl.turn);
    if (ctl.aim && ctl.aim.mag > 0.5) {
      const d = ctl.aim.h - v.parts[0].ang, off = Math.atan2(Math.sin(d), Math.cos(d));
      this.choose(Math.abs(off) < TURNING ? 0 : off > 0 ? 1 : -1);
      turn = 0;
    }
    if (turn !== this.turning && turn) this.nudge(turn);
    this.turning = turn;

    if (this.locked) { v.speed = 0; this.extend(); return; }
    const a = ctl.brake ? -HARD : ctl.move > 0 ? ACCEL * (1 - 0.6 * v.speed / TOP) : ctl.move < 0 ? -BRAKE : -COAST;
    v.speed = clamp(v.speed + a * dt, 0, TOP);
    let travel = v.speed * dt;
    // Another tram in the way: stop short of it.
    const gap = this.trams.gapToTram(v, this.front, 6 + travel);
    if (gap < Infinity && travel > Math.max(0, gap - 2)) {
      if (v.speed > 3) this.hit = Math.max(this.hit, v.speed);
      travel = Math.max(0, gap - 2);
      v.speed = Math.min(v.speed, travel / dt);
    }
    v.s += travel;
    this.extend();
  }
}
