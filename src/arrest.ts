import { SCALE } from './figures.ts';
import type { Car, Door } from './car.ts';
import { locomote, type Walker } from './people.ts';
import type { Officer } from './police.ts';
import type { Point2 } from './map/geo.ts';
import { ducking, rising, turn, RISE, SIT } from './getin.ts';

// An arrest, played out: the officer who caught you opens your door and has you out of
// the car (if you were in one), your hands go up, they step behind you and put the
// handcuffs on, and you're walked to their car and put in the back. The screen goes
// dark on the way, and you come out of the cell some hours later.
//
// Brought down by an officer's dive (src/police.ts) it starts on the ground: you go down
// on your front with them on your legs, they get up onto one knee beside you and cuff
// you where you lie, then have you up onto your knees and your feet, and on from there.

const LED = 2.1; // m/s, walked to the car
const WALK_CLIP = 1.2; // m/s the walk clips cover at their own speed
const BEHIND = 0.62; // m the officer stands behind you
const FAR = 28; // m: a police car further off than this isn't walked to
const ORBIT = 4.5; // rad/s an officer walks round you, leading you off
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const HAUL = 0.3, HANDS = 0.55, CUFF = 1, LEAD = 3, AWAY = 1.3, DARK = 0.85, BACK = 0.6; // seconds
// The tackle (figure clips 'tackle', 'tackled', 'pin', 'pinned', 'cuffedup', in
// assets/figures/build.py; the game draws figures 1.35 times the clips' own size):
// seconds on the ground before they get up off your legs, kneeling over you with the
// cuffs, and getting you up; how far you slide on; where they lie (behind your feet,
// their arms round your legs) and kneel (beside your hips, which are ahead of your feet).
const FLOORED = 0.7, SCRAMBLE = 0.5, PINNED = 1.3, GET_UP = 1.4;
const SLIDE = 0.35; // s you slide on for, from the speed you were running at
const ON_LEGS = 1.3, HIPS = 0.68, KNEEL = 0.85; // m

interface Hooks {
  walker: Walker;
  // While it lasts nobody shoots, and the other officers stand round.
  hold(on: boolean): void;
  // Out of the car you're in: to `at`, or wherever there's room beside it.
  leave(car: Car, at?: Point2): void;
  fade(on: boolean): void;
  // The screen is dark: the hours in the cell pass, and you're taken to where you come out.
  taken(): void;
  done(): void;
}

type Phase = 'door' | 'out' | 'down' | 'pin' | 'up' | 'hands' | 'cuff' | 'lead' | 'seat' | 'dark' | 'back';
interface Scene {
  phase: Phase; t: number;
  officer: Officer | null;
  // The car you were caught in, and the door you're had out of.
  car: Car | null; door: Door | null; out: boolean;
  // Which way you stand to be handcuffed.
  face: number;
  // The police car you're put in, and where you stood as its door opened.
  ride: { car: Car; door: Door } | null; from: Point2; h0: number; seated: boolean;
  // Since the screen began to go dark.
  dark: number | null;
  // Tackled: how fast you were going (you slide on a little), and the side of you the
  // officer kneels (1 left, -1 right).
  slide: number; side: number;
}

export class Arrest {
  o: Hooks;
  now: Scene | null = null;

  constructor(o: Hooks) { this.o = o; }

  get active() { return !!this.now; }

  // `car`: the one you're sitting in, if any. `tackled`: brought down on foot by the
  // officer's dive.
  begin(officer: Officer | null, car: Car | null, tackled = false) {
    const w = this.o.walker;
    if (officer) officer.led = true;
    this.o.hold(true);
    let door: Door | null = null;
    if (car) {
      // Out of the front door nearer the officer.
      const mine = car, far = (d: Door) => { const [x, y] = mine.beside(d); return officer ? Math.hypot(x - officer.x, y - officer.y) : 0; };
      door = mine.doors.filter((d) => d.n <= 2 && !w.blocked(...mine.beside(d))).sort((a, b) => far(a) - far(b))[0] ?? null;
      if (!door || !officer) { this.o.leave(mine); car = null; }
    }
    w.down = 0;
    this.now = {
      phase: car ? 'door' : 'hands', t: 0, officer, car, door, out: false, face: w.h,
      ride: null, from: [w.x, w.y], h0: w.h, seated: false, dark: null, slide: 0, side: 1,
    };
    if (tackled && officer && !car) this.floor(officer);
    else if (!car) this.surrender();
  }

  // Down on your front the way you were running, sliding on a little; the officer kneels
  // on the side of you they're on already, unless there's a wall there.
  private floor(o: Officer) {
    const s = this.now!, w = this.o.walker, sp = Math.hypot(w.vx, w.vy);
    s.phase = 'down';
    s.t = 0;
    s.face = w.h = sp > 1 ? Math.atan2(w.vy, w.vx) : w.h;
    s.slide = Math.min(sp, 8);
    const lx = -Math.sin(s.face), ly = Math.cos(s.face);
    s.side = (o.x - w.x) * lx + (o.y - w.y) * ly >= 0 ? 1 : -1;
    const [kx, ky] = this.kneel();
    if (w.blocked(kx, ky)) s.side = -s.side;
    w.base.makeScale(SCALE, SCALE, SCALE);
    w.anim.play('tackled', true, 0.06);
  }

  // Where the officer kneels over you, and which way they face.
  private kneel(): [number, number, number] {
    const s = this.now!, w = this.o.walker, fx = Math.cos(s.face), fy = Math.sin(s.face);
    return [w.x + fx * HIPS - fy * s.side * KNEEL, w.y + fy * HIPS + fx * s.side * KNEEL, s.face - s.side * Math.PI / 2];
  }

  // Brought down, cuffed where you lie, and got up again.
  private floored(s: Scene, dt: number) {
    const w = this.o.walker, o = s.officer, a = w.anim, fx = Math.cos(s.face), fy = Math.sin(s.face);
    a.step(dt);
    // (Getting up, they walk: send() steps their clip then.)
    if (s.phase !== 'up' || s.t <= 0.45) o?.anim.step(dt);
    if (s.phase === 'down') {
      const v = s.slide * Math.max(0, 1 - s.t / SLIDE), nx = w.x + fx * v * dt, ny = w.y + fy * v * dt;
      if (!w.blocked(nx, ny)) [w.x, w.y] = [nx, ny];
      if (o) {
        // Flat on your legs, then (as the clip has them up onto their knees) round to your side.
        const [kx, ky, kh] = this.kneel(), up = s.t > FLOORED;
        const tx = up ? kx : w.x - fx * ON_LEGS, ty = up ? ky : w.y - fy * ON_LEGS, k = Math.min(1, (up ? 9 : 14) * dt);
        o.x += (tx - o.x) * k;
        o.y += (ty - o.y) * k;
        o.h = turn(o.h, up ? kh : s.face, k);
      }
      if (s.t > FLOORED + SCRAMBLE) {
        s.phase = 'pin';
        s.t = 0;
        a.play('pinned', true, 0.45);
        if (o) {
          [o.x, o.y, o.h] = this.kneel();
          o.anim.play('pin', true, 0.15);
        }
      }
    } else if (s.phase === 'pin') {
      if (s.t > PINNED) {
        s.phase = 'up';
        s.t = 0;
        a.play('cuffedup', true, 0.15);
        o?.anim.play('idle', true, 0.45);
      }
    } else {
      // Up off their knee beside you, a step back while you're on your knees (your shins
      // are behind you), then round behind you as you get to your feet.
      const lx = -fy * s.side, ly = fx * s.side, behind = s.t > GET_UP * 0.7;
      if (o && s.t > 0.45) this.send(o, behind ? w.x - fx * BEHIND + lx * 0.22 : w.x + lx * 0.95, behind ? w.y - fy * BEHIND + ly * 0.22 : w.y + ly * 0.95, behind ? 2.2 : 1.2, dt);
      if (s.t > GET_UP) this.leadOff();
    }
  }

  // Hands up, back to the officer (or facing the car you've just been pulled out of).
  private surrender() {
    const s = this.now!, w = this.o.walker, o = s.officer;
    s.phase = 'hands';
    s.t = 0;
    // (An officer right on top of you gives no way to face: then as you were.)
    s.face = s.car && s.door ? s.car.h - s.door.side * Math.PI / 2 : o && Math.hypot(w.x - o.x, w.y - o.y) > 0.3 ? Math.atan2(w.y - o.y, w.x - o.x) : w.h;
    w.base.makeScale(SCALE, SCALE, SCALE);
    w.anim.play('handsup', true, 0.15);
  }

  // The officer walks (or runs) to a spot; true once there.
  private send(o: Officer, x: number, y: number, speed: number, dt: number) {
    const dx = x - o.x, dy = y - o.y, d = Math.hypot(dx, dy), step = Math.min(d, speed * dt);
    if (d > 0.03) {
      o.x += (dx / d) * step;
      o.y += (dy / d) * step;
      o.h = turn(o.h, Math.atan2(dy, dx), Math.min(1, 14 * dt));
    }
    locomote(o.anim, dt, d > 0.03 ? speed : 0);
    return d <= 0.05;
  }

  update(dt: number) {
    const s = this.now;
    if (!s) return;
    const w = this.o.walker, o = s.officer, a = w.anim;
    s.t += dt;
    w.z = w.speed = w.vx = w.vy = 0;
    if (s.dark !== null) s.dark += dt;

    if (s.phase === 'down' || s.phase === 'pin' || s.phase === 'up') {
      this.floored(s, dt);
      w.sync();
      return;
    }

    if (s.phase === 'door' && s.car && s.door && o) {
      // To your door, a step behind where it opens.
      const { car, door } = s, mid = (door.front + door.back) / 2;
      const [x, y] = car.local(mid - 0.95, door.side * (car.spec.W / 2 + 0.8));
      if (this.send(o, x, y, 5.5, dt) || s.t > 1.5) {
        Object.assign(o, { x, y, h: Math.atan2(car.y - y, car.x - x) });
        car.open(door.n);
        o.anim.play('pull', true, 0.1);
        s.phase = 'out';
        s.t = 0;
      }
      return;
    }
    if (s.phase === 'out' && s.car && s.door) {
      o?.anim.step(dt);
      if (s.t > HAUL && !s.out) {
        s.out = true;
        this.o.leave(s.car, s.car.seat(s.door));
        a.play('getin', true, 0);
      }
      if (s.out) {
        const u = Math.min(1, (s.t - HAUL) / RISE);
        rising(w, s.car, s.door, u);
        if (u >= 1) this.surrender();
      }
      if (s.out) w.sync();
      return;
    }
    if (s.phase === 'hands') {
      w.h = turn(w.h, s.face, Math.min(1, 9 * dt));
      a.step(dt);
      const there = !o || this.send(o, w.x - Math.cos(s.face) * BEHIND, w.y - Math.sin(s.face) * BEHIND, 3.2, dt);
      if (o && there) o.h = turn(o.h, s.face, Math.min(1, 12 * dt));
      if (s.t > HANDS && (there || s.t > HANDS + 1)) {
        s.phase = 'cuff';
        s.t = 0;
        a.play('cuffed', true, 0.3);
        if (o) {
          Object.assign(o, { x: w.x - Math.cos(s.face) * BEHIND, y: w.y - Math.sin(s.face) * BEHIND, h: s.face });
          o.anim.play('cuff', true, 0.15);
        }
      }
    } else if (s.phase === 'cuff') {
      w.h = s.face;
      a.step(dt);
      o?.anim.step(dt);
      if (s.t > CUFF) this.leadOff();
    } else if (s.phase === 'lead') {
      // To the police car's back door; with none to go to, off the way the officer came.
      const [tx, ty] = s.ride ? s.ride.car.beside(s.ride.door) : [w.x - Math.cos(s.face) * 50, w.y - Math.sin(s.face) * 50];
      const d = Math.hypot(tx - w.x, ty - w.y), way = Math.atan2(ty - w.y, tx - w.x);
      // Turned round on the spot first (their car is mostly behind you), then walked: not
      // marched off sideways.
      w.h = turn(w.h, way, Math.min(1, 5 * dt));
      const pace = clamp(1.6 - 2 * Math.abs(wrap(way - w.h)), 0, 1), step = Math.min(d, LED * dt * pace);
      w.x += Math.cos(w.h) * step;
      w.y += Math.sin(w.h) * step;
      a.step(dt, Math.max(0.4, pace) * LED / WALK_CLIP);
      if (o) {
        // A step behind, a little to your left, a hand on your arm. As you turn they walk
        // round you to that place, at arm's length (they used to be stuck to it, and swung
        // round through you).
        const ex = w.x - Math.cos(w.h) * BEHIND - Math.sin(w.h) * 0.22, ey = w.y - Math.sin(w.h) * BEHIND + Math.cos(w.h) * 0.22;
        const now = Math.atan2(o.y - w.y, o.x - w.x), want = Math.atan2(ey - w.y, ex - w.x);
        const r0 = Math.hypot(o.x - w.x, o.y - w.y), r1 = Math.hypot(ex - w.x, ey - w.y);
        const ang = now + clamp(wrap(want - now), -ORBIT * dt, ORBIT * dt), r = Math.max(0.55, r0 + clamp(r1 - r0, -dt, dt));
        o.x = w.x + Math.cos(ang) * r;
        o.y = w.y + Math.sin(ang) * r;
        o.h = turn(o.h, w.h, Math.min(1, 8 * dt));
        o.anim.step(dt, Math.max(0.4, pace) * LED / WALK_CLIP);
      }
      if (s.dark === null) {
        if (s.ride && d < 0.3) {
          s.phase = 'seat';
          s.t = 0;
          s.from = [w.x, w.y];
          s.h0 = w.h;
          s.ride.car.open(s.ride.door.n);
          a.play('cuffed', true, 0.2);
          o?.anim.play('idle', false, 0.25);
        } else if (s.t > (s.ride ? LEAD : AWAY)) this.darken();
      }
    } else if (s.phase === 'seat' && s.ride) {
      // The door opens, in you go, and it shuts on you.
      const { car, door } = s.ride, wait = 0.3;
      if (o) locomote(o.anim, dt, 0);
      if (s.t < wait) a.step(dt);
      else if (!s.seated) {
        if (a.name !== 'getin') a.play('getin', true, 0.12);
        const u = Math.min(1, (s.t - wait) / SIT);
        ducking(w, car, door, s.from, s.h0, u);
        a.step(dt, a.duration / SIT);
        if (u >= 1) {
          s.seated = true;
          w.mesh.visible = false;
          car.open(door.n, false);
        }
      } else if (s.t > wait + SIT + 0.35 && s.dark === null) this.darken();
    }
    if (s.dark !== null && s.phase !== 'back' && s.dark > DARK) {
      // In the dark: the cell, and back on your feet outside it.
      const ride = s.seated ? s.ride : null;
      if (o) o.led = false;
      this.o.hold(false);
      w.base.makeScale(SCALE, SCALE, SCALE);
      w.mesh.visible = true;
      a.play('idle', true, 0);
      if (ride) [w.x, w.y] = ride.car.beside(ride.door);
      s.officer = null;
      s.phase = 'back';
      s.t = 0;
      this.o.taken();
    }
    if (s.phase === 'back') {
      locomote(a, dt, 0);
      if (s.t > BACK) {
        this.now = null;
        this.o.fade(false);
        this.o.done();
      }
    }
    w.sync();
  }

  // Off to the police car, cuffed.
  private leadOff() {
    const s = this.now!;
    s.phase = 'lead';
    s.t = 0;
    s.ride = this.ride(s.officer);
    // (The door you got out of shuts as you're led off.)
    if (s.car && s.door) s.car.open(s.door.n, false);
    this.o.walker.anim.play('cuffedwalk', true, 0.25);
    s.officer?.anim.play('escort', true, 0.25);
  }

  private darken() {
    this.now!.dark = 0;
    this.o.fade(true);
  }

  // The arresting officer's car and the back door nearer to you, if it's near enough and
  // still fit to drive you away.
  private ride(o: Officer | null) {
    const w = this.o.walker, car = o?.car;
    if (!car || car.burnt || car.speed > 1 || Math.hypot(car.x - w.x, car.y - w.y) > FAR) return null;
    const reach = (d: Door) => { const [x, y] = car.beside(d); return Math.hypot(x - w.x, y - w.y); };
    const door = car.doors.filter((d) => d.n > 2 && !w.blocked(...car.beside(d))).sort((a, b) => reach(a) - reach(b))[0];
    return door ? { car, door } : null;
  }
}
