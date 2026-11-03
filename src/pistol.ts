import type { Car } from './car.ts';
import { LAMP } from './car.ts';

// Your pistol. A shot flies from you the way you aim it until it meets a wall, a car or
// a tram; people are never hit, whoever they are: a bullet that would pass through
// someone goes on past them, and everyone near enough to hear it runs. A car takes a
// little damage with every bullet (enough of them set it smoking and then burning, as a
// crash does), and a bullet that lands on one of its lamps smashes it.
//
// What a shot does to the world (the police, the sound, the tracer) is up to main.ts;
// this only finds where it goes.

// Players don't have it: only the developer panel hands it out (dev.ts), and that
// browser keeps it. The `gun-on` class on the page shows the controls that go with it.
let armed = false;
try { armed = localStorage.getItem('pistol') === 'on'; } catch { /* no storage: unarmed */ }
export const gunOn = () => armed;
export function setGun(on: boolean, keep = true) {
  armed = on;
  if (keep) try { localStorage.setItem('pistol', on ? 'on' : 'off'); } catch { /* not kept */ }
  document.body.classList.toggle('gun-on', on);
}

export const RANGE = 55; // m a bullet carries
export const PACE = 0.26; // s between shots, holding the trigger
export const DAMAGE = 7; // what a bullet does to a car (a crash's damage is the speed over 8 m/s)
const STEP = 0.3; // m between the points a shot is checked at for walls
const ASSIST = 0.3; // radians either side of where you face that a car is aimed at for you
const LAMP_REACH = 0.45; // m from a lamp that a bullet still smashes it

export interface Target { x: number; y: number; r: number }
export interface Hit { x: number; y: number; d: number; car: Car | null; tram: boolean }

// Where a ray from (x, y) along `h` first enters a car's box, as a distance, or Infinity.
function intoCar(c: Car, x: number, y: number, dx: number, dy: number) {
  const cs = Math.cos(c.h), sn = Math.sin(c.h), ox = x - c.x, oy = y - c.y;
  // The ray in the car's frame: along its length, then across it.
  const px = ox * cs + oy * sn, py = -ox * sn + oy * cs, vx = dx * cs + dy * sn, vy = -dx * sn + dy * cs;
  const L = c.spec.L / 2, W = c.spec.W / 2;
  let t0 = 0, t1 = Infinity;
  for (const [p, v, e] of [[px, vx, L], [py, vy, W]]) {
    if (Math.abs(v) < 1e-9) { if (Math.abs(p) > e) return Infinity; continue; }
    let a = (-e - p) / v, b = (e - p) / v;
    if (a > b) [a, b] = [b, a];
    t0 = Math.max(t0, a);
    t1 = Math.min(t1, b);
    if (t0 > t1) return Infinity;
  }
  return t0;
}

// Where a ray first meets a circle (a tram's body), or Infinity.
function intoCircle(t: Target, x: number, y: number, dx: number, dy: number) {
  const ox = x - t.x, oy = y - t.y, b = ox * dx + oy * dy, c = ox * ox + oy * oy - t.r * t.r;
  const disc = b * b - c;
  if (disc < 0) return Infinity;
  const d = -b - Math.sqrt(disc);
  return d >= 0 ? d : c < 0 ? 0 : Infinity;
}

// Where a shot from (x, y) along heading `h` goes. `wall` says whether a point is inside
// a building; `cars` and `trams` are what stand about; `skip`, the car you shoot from.
export function trace(x: number, y: number, h: number, o: { wall: (x: number, y: number) => boolean; cars: Iterable<Car>; trams: Iterable<Target>; skip?: Car | null }): Hit {
  const dx = Math.cos(h), dy = Math.sin(h);
  let d = RANGE;
  for (let s = STEP; s < RANGE; s += STEP) if (o.wall(x + dx * s, y + dy * s)) { d = s; break; }
  let car: Car | null = null, tram = false;
  for (const c of o.cars) {
    if (c === o.skip || c.burnt) continue;
    const s = intoCar(c, x, y, dx, dy);
    if (s < d) { d = s; car = c; }
  }
  for (const t of o.trams) {
    const s = intoCircle(t, x, y, dx, dy);
    if (s < d) { d = s; car = null; tram = true; }
  }
  return { x: x + dx * d, y: y + dy * d, d, car, tram };
}

// A bullet into a car at (x, y): damage, and the lamp it lands on smashed.
export function strike(c: Car, x: number, y: number) {
  c.damage += DAMAGE;
  if (c.two) return;
  const cs = Math.cos(c.h), sn = Math.sin(c.h), ox = x - c.x, oy = y - c.y;
  const along = ox * cs + oy * sn, left = -ox * sn + oy * cs, L = c.spec.L / 2, W = c.spec.W / 2;
  for (const [bit, a, l] of [[LAMP.headLeft, L, W - 0.3], [LAMP.headRight, L, 0.3 - W], [LAMP.tailLeft, -L, W - 0.3], [LAMP.tailRight, -L, 0.3 - W]]) {
    if (c.ram && a > 0) continue;
    if (Math.hypot(along - a, left - l) < LAMP_REACH + 0.15) c.broken |= bit;
  }
}

// Shooting with a key or a button, not the mouse: the nearest car roughly ahead is
// aimed at for you, or straight ahead when there's none.
export function assist(x: number, y: number, h: number, cars: Iterable<Car>, skip?: Car | null) {
  let best = h, near = RANGE * 0.8;
  for (const c of cars) {
    if (c === skip || c.burnt) continue;
    const d = Math.hypot(c.x - x, c.y - y);
    if (d > near || d < 0.5) continue;
    const a = Math.atan2(c.y - y, c.x - x);
    if (Math.abs(Math.atan2(Math.sin(a - h), Math.cos(a - h))) > ASSIST) continue;
    best = a; near = d;
  }
  return best;
}
