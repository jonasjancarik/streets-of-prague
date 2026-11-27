import { Heap, slicePath as slice } from './pathfinding.ts';
export { Heap } from './pathfinding.ts';
import * as telemetry from './telemetry.ts';
import { aim } from './difficulty.ts';
import * as THREE from 'three';
import { Car, TYPES } from './car.ts';
import { ahead, layout } from './roadblock.ts';
import type { Roadblock, Spot, Placed } from './roadblock.ts';
import { Polyline, clamp } from './network.ts';
import { project, speedLimit, turnOf } from './assist.ts';
import { Figures, Anim, SCALE } from './figures.ts';
import { locomote, knocked } from './people.ts';
import { Helicopters, HELI_SIGHT } from './helicopter.ts';
import type { CarGrid } from './car.ts';
import type { DriveEdge, DriveGraph, WalkEdge, WalkGraph } from './network.ts';
import type { Traffic } from './traffic.ts';
import type { FigureKit } from './figures.ts';
import type { Point2 } from './map/geo.ts';
import type { Point3 } from './guns.ts';

// `pit`: trying a PIT manoeuvre on you (see pitting); `trick`: seconds before it thinks of
// trying one. `block`: parked across the road as part of a roadblock (see roadblock.ts).
// (`halt`: pulling up to let its officer out, see Police.crime.)
// (`look`: where it's looking for you once they've lost you, see Police.lookout.)
interface ChaseCar extends Follower { car: Car; calm: boolean; wrecked: boolean; gone?: boolean; reload?: number; side?: number; pit?: Pit; trick?: number; block?: Roadblock; halt?: boolean; look?: Look }
// A search for you once they've lost sight of you: from where they last knew you to be,
// the way you were heading then (a unit vector, or 0 for a crime phoned in), seconds
// they've been at it, whether a car has been to see the spot itself, and the street
// corners they've looked at since.
interface Search { x: number; y: number; hx: number; hy: number; t: number; checked: boolean; been: Set<string> }
// Where one car is going to look: the spot itself, or (`node`) a street corner; `t`, the
// seconds it has left to get there before it looks somewhere else.
interface Look { x: number; y: number; node?: string; of: Search; t: number }
// (`ok`: seconds it has kept its place beside you; `cramped`: seconds that place has been
// in a wall or another car.)
interface Pit { phase: 'line' | 'hit' | 'off'; t: number; side: number; ok: number; cramped: number }
// `door`: the one of their car they got out of, left open till they're back. `led`: making
// an arrest, moved by src/arrest.ts. `slot`: the way round you (radians) they stand when
// they've caught up; `at`: the door of your car they're making for. `post`: where they
// stand at a roadblock, behind their car.
// `looked`: seconds they've spent looking round where you were, once they've lost you.
// `way`: their way round the buildings to where they're going (see Police.towards).
export interface Officer { avatarId: number; x: number; y: number; h: number; vx: number; vy: number; car: Car; fig: Figures; anim: Anim; down: number; back: boolean; out?: number; gone?: boolean; level?: number; gz?: number; detour?: number; reload?: number; door?: number; led?: boolean; grip?: number; slot?: number; at?: number; post?: Point2; block?: Roadblock; sprint?: number; winded?: number; dive?: Dive; diveRest?: number; looked?: number; way?: Footway }
// A way round the buildings for an officer on foot: the points along it still ahead, where
// it leads, and seconds before they look for a new one.
interface Footway { pts: Point2[]; tx: number; ty: number; t: number }
// An officer's dive at your legs: `t` since they left their feet, which way, how fast they
// set off, and whether it's been decided yet.
interface Dive { t: number; ux: number; uy: number; v: number; done: boolean }
// A stretch of the way a police car or a fire engine can take: a street, or (`foot`) a
// way meant for people.
type Way = (DriveEdge | WalkEdge) & { mid?: Polyline; twin?: DriveEdge | null };
interface Link { to: string; e: Way; back: boolean; foot: boolean; cost: number }
// Where people walk and an emergency vehicle may drive: pedestrian streets and squares,
// and paths through parks and courtyards wide enough for it. Not steps, footbridges or
// subways.
const FOOT_OK = new Set(['pedestrian', 'footway', 'path', 'track']);
const FOOT_WIDTH = 4; // m (pedestrian streets and squares count whatever width the map gives them)
// The pavement beside a street: only as the few metres from the street into a park, say.
const PAVEMENT_COST = 10;
const FOOT_COST = 3; // a metre there counts as this many by road: the street is taken where there is one
const FOOT_SPEED = 10; // m/s among people
const FOOT_FAR = 15; // m: a footpath is where a way starts or ends only if it's this much nearer than any street (a pavement runs beside every street)
const OTHER_LEVEL = 15; // m: a street on another level than the one wanted counts as this much further
const LEVEL_APART = 3; // m of height between two that are on different levels (as main.ts's `apart`)
// Whether a street is on a level of that kind: in a tunnel (below 0), on a bridge (above), or on the ground.
export const onLevel = (e: { bridge?: boolean; tunnel?: boolean }, level: number) => (level < 0 ? !!e.tunnel : level > 0 ? !!e.bridge : !e.bridge && !e.tunnel);
// (`level`: on the ground 0, in a tunnel below it, on a bridge above it; see TileWorld.track.)
// `duty`: driving a fire engine or an ambulance (see ON_DUTY).
interface PlayerTarget { x: number; y: number; z: number; level: number; vx: number; vy: number; speed: number; car: Car | null; air: boolean; riding: boolean; duty?: boolean }
interface PoliceOptions {
  scene: THREE.Scene; drive: DriveGraph; traffic: Traffic; grid: CarGrid;
  height: (x: number, y: number, who?: Car | Officer) => number;
  rng: () => number; edgesNear: (x: number, y: number, radius: number) => DriveEdge[];
  // The footpath network, for the ways an emergency vehicle may take through pedestrian zones and parks.
  walk?: WalkGraph; walkNear?: (x: number, y: number, radius: number) => WalkEdge[];
  offscreen: (x: number, y: number) => boolean; onBusted: (by: Officer, tackled?: boolean) => void; kit: FigureKit;
  // Whether a car or a tram (other than `skip`) takes up a circle of radius r at (x, y).
  bodyAt?: (x: number, y: number, r: number, skip: Car | null) => boolean;
  // A shot at the player, from the muzzle to where the bullet went, and whether it hit.
  onShot?: (from: Point3, to: Point3, hit: boolean) => void;
  // Whether a tram track runs within r m of (x, y): no roadblock there.
  trackNear?: (x: number, y: number, r: number) => boolean;
}

// The police and your wanted level, GTA 2 style.
//
// Crimes build up heat, and heat is shown as stars. A crime the police see counts
// three times as much as one somebody phones in: knocking people over, pulling
// drivers out of their cars, wrecking traffic, ramming or stealing a police car.
// Speeding past a police car gets you one star: never up to 10 km/h over the limit, then
// more and more likely, nearly certain at 30 km/h over.
//
// A few police cars patrol with the traffic. Once you're wanted, cars chase you along
// the street network, more of them the more stars you have, and ram you. When you're
// on foot or stopped, an officer gets out and runs after you: if they reach you,
// you're busted, unless you break away before they've had hold of you for a moment
// or two. Stay out of their sight for a while and you lose a star at a time.
//
// The police only know where you are while they can see you. A crime none of them saw
// is phoned in some seconds later, and they go to where it happened; once there,
// they find you only if you're still in sight of them.
// From three stars a helicopter joins in (src/helicopter.ts), and the officers draw
// their pistols: they stop where they can see you and shoot rather than run you down.
// From four stars they shoot from the cars as well.
// From two stars a car behind you now and then tries a PIT manoeuvre on you (pitting),
// and from three they set up roadblocks ahead of you (src/roadblock.ts).
//
// In a fire engine or an ambulance the police go easier on you. Taking one is still a
// carjack, but the stars go ON_DUTY.lose times as fast once they've lost sight of you.
// While you're not wanted they let speeding go, a crash or someone knocked over counts
// ON_DUTY.crash as much, and that little heat drains away by itself.

const STARS = [1, 4, 9, 16, 25]; // heat for each star
const BRAKED = { throttle: 0, steer: 0, handbrake: true };
const CHASERS = [0, 1, 2, 3, 4, 6]; // police cars after you, by stars
const HELIS = [0, 0, 0, 1, 1, 1];
const PATROLS = 3;
const RAMS = [0.15, 0.2, 0.35, 0.5, 0.7, 0.85]; // how many of the cars sent after you carry the ram frame, by stars
const POINTS = { knock: 1, carjack: 1, wreck: 0.6, hitCop: 2, stealCop: 3, stealTram: 1.5, blowUp: 1.5, blowUpCop: 3, fareDodge: 2, gunfire: 1 };
// What each is called in the statistics (src/telemetry.ts).
const CRIME_NAMES: Record<keyof typeof POINTS, string> = {
  knock: 'knocked someone over', carjack: 'took a car from its driver', wreck: 'wrecked a car', hitCop: 'hit the police',
  stealCop: 'took a police car', stealTram: 'took a tram', blowUp: 'blew up a car', blowUpCop: 'blew up a police car', fareDodge: 'ran from a ticket inspector',
  gunfire: 'fired a gun',
};
const COOLDOWN: Partial<Record<keyof typeof POINTS, number>> = { hitCop: 1, gunfire: 2.5 }; // one scrape (or one burst) shouldn't count ten times
const RUN = 6.4; // officers on foot, m/s: you can outrun them, but not walking
// Close behind someone running from them (you run at 7.5 m/s), an officer sprints for a
// moment and then is winded for a while: from a few metres off that gets them near enough
// to dive at your legs; from further off you still get away.
const SPRINT = 9, SPRINT_FOR = 2.2, WINDED = 4, SPRINT_NEAR = 7; // m/s, s, s, m
// The dive (the `tackle` clip): they set off at up to DIVE_MAX m/s and slow to a stop on
// the ground in DIVE_SLIDE s, their arms DIVE_ARMS m ahead, and it's decided DIVE_CONTACT s
// in: you're brought down if you're within DIVE_HIT of their arms then (src/arrest.ts
// plays it out). They only go for it when they'd reach where you'll be by then. A miss leaves
// them on the ground until DIVE_UP s, and a while before they try another.
const DIVE_CONTACT = 0.3, DIVE_SLIDE = 0.5, DIVE_MAX = 10.5, DIVE_ARMS = 1.4, DIVE_HIT = 0.95, DIVE_UP = 1.55, DIVE_REST = 3;
const DIVE_TRAVEL = DIVE_CONTACT - DIVE_CONTACT * DIVE_CONTACT / (2 * DIVE_SLIDE); // metres covered by contact per m/s set off at
const DIVE_FAST = 4.5; // m/s you're going at least: slower, they just take hold of you
const WRECKED = 90; // damage that puts a police car out of the chase
const ARMED = 3; // stars from which officers on foot shoot
const FROM_CARS = 4; // and from which they shoot from the cars
const RANGE = 24; // m; further off they come closer first
const ON_DUTY = { lose: 3, crash: 0.35, drain: 0.05 }; // (drain: heat a second, below the first star)
const REPORT = 6; // s at least before a crime the police didn't see is phoned in
const GRIP = 1.4; // s an officer has to keep hold of you on foot before you're busted
// s an officer getting out takes in the doorway (the door is fully open after 0.2 s).
const STEP_OUT = 0.5;
const GRIP_CAR = 2.4; // s at the door of the car you've stopped in: time to drive off
// The PIT manoeuvre (see pitting), from two stars: the chance a car behind you tries one each
// time it thinks of it (about every second), and the seconds it waits before thinking of
// another.
const PITS = [0, 0, 0.25, 0.4, 0.55, 0.7];
const PIT_REST = [0, 0, 10, 8, 6, 4];
const PIT_FAST = 8; // m/s (about 30 km/h) at least: slower, they just ram you or stop you
// Roadblocks (roadblock.ts), from three stars: seconds from one to the next, the gap
// between the noses (a car is 1.75–1.9 m wide), the most cars in one, how far ahead of you
// (m) it's set up, how far off you are when it's given up, and how much harder than a
// moving car the parked ones are to shove.
const BLOCK_FROM = 3;
const BLOCK_REST = [0, 0, 0, 30, 22, 15];
const BLOCK_GAP = [0, 0, 0, 3, 2.7, 2.4];
const BLOCK_CARS = [0, 0, 0, 2, 4, 4];
const BLOCK_NEAR = 110, BLOCK_FAR = 330, BLOCK_GONE = 450;
const BLOCK_MASS = 1.6;
// Where officers stand once they've caught up with you on foot: at arm's length (from your
// middle to theirs), spread round you no closer than SPREAD radians to each other, not on
// top of you. While one of them arrests you, the others stand back at STAND_BY.
const ARM = 0.85; // m
const SPREAD = 1.1;
const STAND_BY = 2.6; // m
// What they see (Police.sees). This near they notice you whatever's between (they hear
// you); further off they need a clear line, and someone on another level (on the street
// over the tunnel you're in) doesn't see you at all. A car that isn't after you yet
// notices you behind it only within BEHIND m (they look ahead, not in the mirror). The
// dark, mist and rain or snow bring the range in (Police.dim, down to DIM_MOST less).
const HEAR = 8; // m
const BEHIND = 30; // m
const DIM_MOST = 0.55;
// Searching once they've lost you (Police.lookout): the car nearest goes to where you
// were; the others go to street corners round it, further out the longer it takes
// (SEARCH_NEAR m along the streets at first, SEARCH_GROW m more a second, SEARCH_FAR at
// most), ahead the way you were going, each to a different one. They drive at
// SEARCH_TOP m/s, looking. Officers out on foot look round the spot for LOOK_FOR s and
// go back to their car.
const SEARCH_NEAR = 70, SEARCH_GROW = 9, SEARCH_FAR = 360; // m, m/s, m
const SEARCH_THERE = 14; // m from a spot: they've looked there
const SEARCH_APART = 50; // m: two cars don't look at corners nearer each other than this
const SEARCH_TOP = 13; // m/s
const LOOK_GIVE_UP = 45; // s to get to a spot before it looks somewhere else
const LOOK_FOR = 6; // s
// Officers on foot find their way round the buildings, walls and fences in the way
// (Police.footway): over squares of FOOT_CELL m within FOOT_MARGIN m round the straight
// line, looking at no more than FOOT_MOST of them, again when where they're going has
// moved FOOT_MOVED m or after FOOT_AGAIN s. Nothing in the way, they go straight.
const FOOT_CELL = 0.7, FOOT_MARGIN = 30, FOOT_MOST = 9000, FOOT_MOVED = 3, FOOT_AGAIN = 1.5;

// Walking towards (tx, ty) at `speed`: round the cars and trams in the way, not into
// them: the first way clear a step ahead, turning further and further off the straight
// line, the same side as last time first (so they don't dither). Not `skip`.
export function steer(o: { x: number; y: number; vx: number; vy: number; h: number; detour?: number }, tx: number, ty: number, speed: number,
  bodyAt: (x: number, y: number, r: number, skip: Car | null) => boolean, skip: Car | null, rng: () => number) {
  const dx = tx - o.x, dy = ty - o.y, d = Math.hypot(dx, dy) || 1;
  let ang = Math.atan2(dy, dx);
  const step = Math.min(d, 0.9);
  const clear = (a: number) => !bodyAt(o.x + Math.cos(a) * step, o.y + Math.sin(a) * step, 0.4, skip);
  if (!clear(ang)) {
    const side = o.detour || (rng() < 0.5 ? 1 : -1);
    let found = false;
    for (let k = 1; k <= 5 && !found; k++) {
      for (const sgn of [side, -side]) {
        if (!clear(ang + sgn * k * 0.5)) continue;
        ang += sgn * k * 0.5;
        o.detour = sgn;
        found = true;
        break;
      }
    }
    // (Hemmed in all round: straight on, and the cars push them back out.)
  } else o.detour = 0;
  o.vx = Math.cos(ang) * speed;
  o.vy = Math.sin(ang) * speed;
  o.h = ang;
}

// What a car driving along a route needs to keep track of (police chasing, engines on call).
export interface Follower { path: Polyline | null; s: number; replan: number; stuck: number; reverse: number }

// Where a car on `p.path` should head (a little way ahead along it) and how fast: no
// more than `top` m/s, less for the bends coming up (`bendy` m/s off for a right angle).
// A car that's strayed off the route asks for a new one soon.
export function along(c: Car, p: Follower, path: Polyline, top = 24, bendy = 14) {
  const q = project(path, c.x, c.y, p.s - 10, p.s + 40);
  p.s = q.s;
  // Off the route: a new one soon (still no more than a few times a second).
  if (q.d > 12) p.replan = Math.min(p.replan, 0.3);
  // Slowly where people walk, from a little before.
  // And keeping to the middle through the bends: these ways have house corners where a
  // street has a kerb, and aiming far ahead cuts across them.
  const foot = !!path.foot?.some(([a, b]) => p.s + 15 > a && p.s < b);
  if (foot) top = Math.min(top, FOOT_SPEED);
  const t = path.at(p.s + (foot ? 4 + Math.abs(c.forwardSpeed) * 0.3 : 6 + Math.abs(c.forwardSpeed) * 0.6));
  let bend = 0;
  for (const d of [8, 18, 30]) bend = Math.max(bend, Math.abs(turnOf(c.h, path.at(p.s + d).ang)));
  return { tx: t.x, ty: t.y, want: clamp(top - bend * bendy, foot ? 4 : 7, top) };
}

// Steering and pedals for heading at (tx, ty) at `want` m/s, backing up and trying again
// when stuck.
export function pedals(c: Car, p: Follower, tx: number, ty: number, want: number, dt: number) {
  const vf = c.forwardSpeed;
  let steer = clamp(turnOf(c.h, Math.atan2(ty - c.y, tx - c.x)) * 2.2, -1, 1);
  let throttle = vf < want - 1 ? 1 : vf > want + 2 ? -1 : 0;
  if (throttle > 0 && Math.abs(vf) < 1.2) p.stuck += dt;
  else p.stuck = Math.max(0, p.stuck - dt);
  if (p.stuck > 1.2) { p.reverse = 1.1; p.stuck = 0; }
  if (p.reverse > 0) {
    p.reverse -= dt;
    throttle = -1;
    steer = -steer;
  }
  return { throttle, steer };
}

export class Police {
  scene: THREE.Scene; drive: DriveGraph; traffic: Traffic; grid: CarGrid;
  r: () => number; edgesNear: PoliceOptions['edgesNear']; offscreen: PoliceOptions['offscreen'];
  onBusted: PoliceOptions['onBusted']; kit: FigureKit; bodyAt: NonNullable<PoliceOptions['bodyAt']>;
  height: PoliceOptions['height']; onShot: NonNullable<PoliceOptions['onShot']>;
  trackNear: NonNullable<PoliceOptions['trackNear']>;
  private nextOfficerId = 0;
  spare: Figures[]; helis: Helicopters; heat: number; cars: ChaseCar[]; officers: Officer[];
  seen: boolean; lose: number; cool: Record<string, number>; spawnT: number; checkT: number; limit: number;
  nodes: Map<string, Point2>; links: Map<string, Link[]>; linked: number; walked = 0;
  paths: WalkGraph | null; walkNear: NonNullable<PoliceOptions['walkNear']>;
  stolen: WeakSet<Car>;
  // An arrest is being made (src/arrest.ts): nobody shoots, the other officers stand round.
  arresting = false;
  // The roadblock set up ahead of you, if there is one, and seconds before another may be.
  block: Roadblock | null = null;
  blockT = 4;
  private spots: Spot[] = [];
  private placed: Placed[] = [];
  // Where the police think you are: where they last saw you, or where a crime was
  // phoned in from. Out of sight, that is where they go, not to you.
  known: Point2 | null = null;
  // Crimes nobody from the police saw, on their way in by phone.
  reports: { heat: number; x: number; y: number; t: number }[] = [];
  // How fast you really got anywhere in the last step, m/s (running into a wall, the
  // legs go but you don't).
  moved = 0;
  private was: Point2 | null = null;
  // Driving a fire engine or an ambulance (PlayerTarget.duty), as of the last update.
  private duty = false;
  // How hard it is to see far (0 a clear day, 1 the darkest murk), from main.ts: see HEAR.
  dim = 0;
  // Your height and level as of the last update, for what they see (sees).
  private at = { z: 0, level: 0 };
  // The way you were going while they last saw you (a unit vector), if you were moving.
  private headed: Point2 | null = null;
  // Looking for you, once they've lost you (see Search).
  search: Search | null = null;

  constructor({ scene, drive, traffic, grid, height, rng, edgesNear, walk = undefined, walkNear = () => [], offscreen, onBusted, kit, bodyAt = () => false, onShot = () => {}, trackNear = () => false }: PoliceOptions) {
    this.scene = scene; this.drive = drive; this.traffic = traffic; this.grid = grid;
    this.r = rng; this.edgesNear = edgesNear; this.offscreen = offscreen;
    this.paths = walk ?? null; this.walkNear = walkNear;
    this.onBusted = onBusted; this.kit = kit; this.bodyAt = bodyAt;
    this.height = height; this.onShot = onShot; this.trackNear = trackNear;
    this.spare = []; // figures of officers who've gone, to reuse
    this.helis = new Helicopters(scene, height);
    this.heat = 0;
    this.cars = []; // chasing: { car, path, s, replan, stuck, reverse, calm, wrecked }
    this.officers = [];
    this.seen = false; // the police can see you right now
    this.lose = 0; // seconds out of sight
    this.cool = {};
    this.stolen = new WeakSet(); // police cars you've taken
    this.spawnT = 0;
    this.checkT = 0;
    this.limit = 50;
    // Street network for chasing, both ways along every street (the police ignore one-way signs).
    this.nodes = new Map();
    this.links = new Map();
    this.linked = 0;
  }

  get stars() { return STARS.filter((t) => this.heat >= t).length; }

  // Police cars that are after you, not wrecked or given up (nor standing in a roadblock).
  get chasing() { return this.cars.filter((p) => !p.calm && !p.wrecked && !p.block); }

  // Everyone who can spot you: patrols, chasing cars and officers on foot.
  *eyes() {
    for (const a of this.traffic.agents) if (a.car.type === 'police') yield a.car;
    for (const p of this.cars) if (!p.wrecked) yield p.car;
    for (const o of this.officers) if (o.down <= 0) yield o;
    yield* this.helis.watching;
  }

  // Whether a police car or an officer is on your level (not on the road over the
  // tunnel you're in, or under the bridge you're on).
  level(who: Car | Officer, me: PlayerTarget) {
    return Math.abs(this.height(who.x, who.y, who) - me.z) < LEVEL_APART;
  }

  clear(ax: number, ay: number, bx: number, by: number) {
    const d = Math.hypot(bx - ax, by - ay), n = Math.ceil(d / 2);
    for (let i = 1; i < n; i++) if (this.grid.at(ax + ((bx - ax) * i) / n, ay + ((by - ay) * i) / n) === 255) return false;
    return true;
  }

  // Whether any of them sees (x, y), at height `z` on `level` (yours, by default). See HEAR.
  sees(x: number, y: number, far = 110, z = this.at.z, level = this.at.level) {
    const reach = far * (1 - DIM_MOST * clamp(this.dim, 0, 1));
    for (const e of this.eyes()) {
      const d = Math.hypot(e.x - x, e.y - y);
      if ('air' in e && e.air) { if (d < HELI_SIGHT) return true; continue; }
      const who = e as Car | Officer;
      // On another level and well above or below: the street over the tunnel, the bridge
      // over the street. (Both, so a steep street or a bridge's ramp doesn't count.)
      if (Math.sign(who.level ?? 0) !== Math.sign(level) && Math.abs(this.height(who.x, who.y, who) - z) >= LEVEL_APART) continue;
      if (d < HEAR) return true;
      let r = reach;
      if (who instanceof Car && !this.seen && (x - who.x) * Math.cos(who.h) + (y - who.y) * Math.sin(who.h) < -0.3 * d) r = Math.min(r, BEHIND);
      if (d < r && this.clear(who.x, who.y, x, y)) return true;
    }
    return false;
  }

  // `car`: the police car that was hit (rammed or shot at), if any; its crew gets out and
  // comes after you, wrecked or not (but not out of one the blow has rolled over: they stay
  // belted in). Out of a moving car only once it has pulled up (`halt`): they used to jump
  // out at once and leave it rolling on behind you, the driver's door open.
  crime(kind: keyof typeof POINTS, x: number, y: number, car?: Car) {
    if (kind === 'hitCop' && car?.crew && !car.roll) {
      // A patrol riding along with the traffic has no one to drive it once its officer is
      // out (the traffic would carry on with an empty car, the door open): it joins the
      // chase cars, which wait for their officers.
      const ride = this.traffic.agents.find((a) => a.car === car);
      if (ride) {
        this.traffic.release(ride);
        car.mode = 'police';
        this.cars.push({ car, path: null, s: 0, replan: 0, stuck: 0, reverse: 0, calm: false, wrecked: false });
      }
      const p = this.cars.find((q) => q.car === car);
      if (p && car.speed > 1) p.halt = true;
      else this.getOut(car);
    }
    if (this.cool[kind] > 0) return;
    telemetry.did(`crime: ${CRIME_NAMES[kind]}`);
    this.cool[kind] = COOLDOWN[kind] || 0;
    const points = POINTS[kind] * (this.duty && this.stars === 0 && (kind === 'wreck' || kind === 'knock') ? ON_DUTY.crash : 1);
    if (this.sees(x, y)) {
      this.heat = Math.min(40, this.heat + points * 1.5);
      this.lose = 0;
      this.known = [x, y];
    } else this.reports.push({ heat: points * 0.5, x, y, t: REPORT + this.r() * 5 });
  }

  // You got into a police car, with its crew or one they've left to come after you on
  // foot: whoever was in it gets out and comes after you, and the car is yours, out of
  // the chase. Stealing it is a crime once; getting back into it later isn't another.
  take(car: Car) {
    const i = this.cars.findIndex((p) => p.car === car);
    if (i >= 0) this.cars.splice(i, 1);
    if (car.crew) this.getOut(car);
    if (this.stolen.has(car)) return;
    this.stolen.add(car);
    this.crime('stealCop', car.x, car.y);
  }

  knock(o: Officer, vx: number, vy: number) {
    Object.assign(o, { down: 3, vx, vy, h: Math.atan2(vy, vx) + Math.PI, dive: undefined });
    o.anim.play('fall', true, 0.08);
  }

  dismiss(o: Officer) {
    this.scene.remove(o.fig.mesh);
    this.spare.push(o.fig);
  }

  // Dev teleport: the chase doesn't follow you across town.
  reset() {
    for (const o of this.officers) this.dismiss(o);
    this.officers = [];
    this.cars = [];
    this.reports = [];
    this.known = null;
    this.headed = null;
    this.search = null;
    this.block = null;
    this.helis.reset();
  }

  // ---- Street network ----------------------------------------------------

  // Links the streets and paths learnt since the last time. (The graphs keep their
  // edges in the order they learnt them and number them, so the new ones are at the
  // end whatever has been taken out since.)
  sync() {
    const edges = this.drive.edges;
    let i = edges.length;
    while (i > 0 && edges[i - 1].n > this.linked) i--;
    for (; i < edges.length; i++) {
      const e = edges[i];
      e.mid = e.mid || new Polyline(e.pts);
      this.nodes.set(e.u, e.pts[0]);
      this.nodes.set(e.v, e.pts[e.pts.length - 1]);
      this.link(e, false);
    }
    this.linked = this.drive.count;
    const paths = this.paths?.edges ?? [];
    i = paths.length;
    while (i > 0 && paths[i - 1].n > this.walked) i--;
    const walked = this.paths?.count ?? 0;
    for (; i < paths.length; i++) {
      const e = paths[i];
      if (!this.drivable(e)) continue;
      (e as Way).mid = e.path;
      this.nodes.set(e.u, e.pts[0]);
      this.nodes.set(e.v, e.pts[e.pts.length - 1]);
      this.link(e, true, this.pavement(e) ? PAVEMENT_COST : FOOT_COST);
    }
    this.walked = walked;
  }

  // Streets and paths that have left the graphs (their tiles are far behind) leave the
  // chase network too.
  forget(edges: Way[]) {
    for (const e of edges) {
      for (const n of e.u === e.v ? [e.u] : [e.u, e.v]) {
        const list = this.links.get(n);
        if (!list) continue;
        const left = list.filter((l) => l.e !== e);
        if (left.length) this.links.set(n, left);
        else { this.links.delete(n); this.nodes.delete(n); }
      }
    }
  }

  link(e: Way, foot: boolean, cost = 1) {
    for (const [a, b, back] of [[e.u, e.v, false], [e.v, e.u, true]] as [string, string, boolean][]) {
      if (!this.links.has(a)) this.links.set(a, []);
      this.links.get(a)!.push({ to: b, e, back, foot, cost });
    }
  }

  // Whether a footpath is the pavement of a street: it runs along one, a few metres off.
  pavement(e: WalkEdge) {
    if (e.hw === 'pedestrian') return false;
    let beside = 0;
    for (const k of [0.25, 0.5, 0.75]) {
      const p = e.path.at(e.path.length * k), st = this.nearestStreet(p.x, p.y, 9);
      if (st && Math.abs(Math.cos(st.e.mid.at(st.s).ang - p.ang)) > 0.8) beside++;
    }
    return beside >= 2;
  }

  // Whether a police car or a fire engine may take this footpath. (The streets people
  // walk along are in the footpath network too, under other names: those it has already.)
  drivable(e: WalkEdge) {
    return FOOT_OK.has(e.hw) && !e.bridge && !e.tunnel && (e.hw === 'pedestrian' || e.width >= FOOT_WIDTH);
  }

  nearestStreet(x: number, y: number, radius = 40): { e: DriveEdge & { mid: Polyline }; s: number; d: number } | null {
    return this.nearestWay(x, y, radius, false) as { e: DriveEdge & { mid: Polyline }; s: number; d: number } | null;
  }

  // The same, with (`foot`) the footpaths an emergency vehicle may take. With a
  // `level`, a street on another one (the road over a tunnel you're in) counts only if
  // nothing on yours is much nearer.
  nearestWay(x: number, y: number, radius: number, foot: boolean, level?: number) {
    let best: { e: Way & { mid: Polyline }; s: number; d: number; foot: boolean } | null = null;
    for (const e of this.edgesNear(x, y, radius)) {
      e.mid = e.mid || new Polyline(e.pts);
      const p = project(e.mid, x, y), d = p.d + (level !== undefined && !onLevel(e, level) ? OTHER_LEVEL : 0);
      if (p.d < radius && (!best || d < best.d)) best = { e: e as DriveEdge & { mid: Polyline }, s: p.s, d, foot: false };
    }
    if (foot) for (const e of this.walkNear(x, y, radius)) {
      if (!this.drivable(e) || this.pavement(e)) continue;
      const p = project(e.path, x, y), d = p.d + FOOT_FAR;
      if (p.d < radius && (!best || d < best.d)) best = { e: Object.assign(e, { mid: e.path }), s: p.s, d, foot: true };
    }
    return best;
  }

  // Where a police car stops for you on foot: in the traffic lane nearest you, the
  // side of the street you're on. The lanes keep clear of the parked cars, so the car
  // doesn't drive over them (or up on the pavement) to get to you. A street on
  // another level than yours (a bridge or a tunnel, when you're on the ground; the
  // street above, when you're in the tunnel) counts only if nothing else is much nearer.
  roadside(x: number, y: number, foot = true, level = 0) {
    let best: { x: number; y: number } | null = null, bestD = 80;
    for (const e of this.edgesNear(x, y, 80)) {
      const q = project(e.path, x, y), d = q.d + (onLevel(e, level) ? 0 : OTHER_LEVEL);
      if (d >= bestD) continue;
      const p = e.path.at(q.s);
      best = { x: p.x, y: p.y };
      bestD = d;
    }
    // In a pedestrian zone or a park: on the path through it, if that's nearer than any street.
    if (foot && !level) for (const e of this.walkNear(x, y, 80)) {
      if (!this.drivable(e)) continue;
      const q = project(e.path, x, y);
      if (q.d + FOOT_FAR >= bestD || this.pavement(e)) continue;
      const p = e.path.at(q.s);
      best = { x: p.x, y: p.y };
      bestD = q.d + FOOT_FAR;
    }
    return best;
  }

  // Shortest way from (ax, ay) to (bx, by), as a Polyline, or null: by road, and where
  // there's none, through pedestrian zones and parks (police cars and fire engines
  // may). If the paths lead nowhere, by road as near as it gets.
  // (`foot` false: by road only. `levels`: those of the start and the end, so a way to
  // someone in a tunnel ends in the tunnel, not on the street above it.)
  route(ax: number, ay: number, bx: number, by: number, foot = true, levels?: [number, number]): Polyline | null {
    this.sync();
    return (foot && this.way(ax, ay, bx, by, true, levels)) || this.way(ax, ay, bx, by, false, levels);
  }

  way(ax: number, ay: number, bx: number, by: number, foot: boolean, levels?: [number, number]): Polyline | null {
    const A = this.nearestWay(ax, ay, 40, foot, levels?.[0]), B = this.nearestWay(bx, by, 40, foot, levels?.[1]);
    if (!A || !B) return null;
    const lenA = A.e.mid.length, lenB = B.e.mid.length;
    let pts: Point2[];
    // The stretches on footpaths, as ranges of `pts`.
    const spans: [number, number][] = [];
    const add = (more: Point2[], onFoot: boolean) => {
      if (onFoot && more.length) spans.push([pts.length, pts.length + more.length - 1]);
      pts.push(...more);
    };
    if (A.e === B.e || A.e.twin === B.e) {
      const sb = A.e === B.e ? B.s : lenA - B.s;
      pts = [];
      add(slice(A.e.mid, A.s, sb), A.foot);
    } else {
      const goal = new Map<string, number>([[B.e.u, B.s], [B.e.v, lenB - B.s]]);
      const [gx, gy] = [bx, by];
      const g = new Map<string, number>(), from = new Map<string, Link>(), heap = new Heap();
      for (const [n, cost] of [[A.e.u, A.s], [A.e.v, lenA - A.s]] as [string, number][]) {
        g.set(n, cost);
        heap.push([cost, n]);
      }
      let end: string | null = null;
      for (let pops = 0, most = foot ? 20000 : 6000; heap.size && pops < most; pops++) { // (the footpaths are a much finer net)
        const item = heap.pop();
        if (!item) break;
        const [f, n] = item;
        const gn = g.get(n);
        const node = this.nodes.get(n);
        if (gn === undefined || !node) continue;
        const [nx, ny] = node;
        if (f > gn + Math.hypot(gx - nx, gy - ny) + 1e-6) continue; // stale entry
        if (goal.has(n)) { end = n; break; }
        for (const l of this.links.get(n) || []) {
          if (l.foot && !foot) continue;
          const c = gn + (l.e.mid?.length ?? 0) * l.cost;
          if (c >= (g.get(l.to) ?? Infinity)) continue;
          g.set(l.to, c);
          from.set(l.to, l);
          const next = this.nodes.get(l.to);
          if (!next) continue;
          const [tx, ty] = next;
          heap.push([c + Math.hypot(gx - tx, gy - ty), l.to]);
        }
      }
      if (end === null) return null;
      const chain: Link[] = [];
      let first = end;
      for (let l = from.get(end); l; l = from.get(first)) { chain.unshift(l); first = l.back ? l.e.v : l.e.u; }
      pts = [];
      add(slice(A.e.mid, A.s, first === A.e.u ? 0 : lenA), A.foot);
      for (const l of chain) add(l.back ? [...l.e.pts].reverse() : l.e.pts, l.foot);
      add(slice(B.e.mid, end === B.e.u ? 0 : lenB, B.s), B.foot);
    }
    const path = new Polyline([[ax, ay], ...pts, [bx, by]]);
    // (One point was put in front of `pts`.)
    if (spans.length) path.foot = spans.map(([i, j]) => [path.cum[i + 1], path.cum[j + 1]]);
    return path;
  }

  // ---- Cars --------------------------------------------------------------

  // A new police car on a street out of view, 90–250 m from (x, y).
  spawn(x: number, y: number) {
    const edges = this.edgesNear(x, y, 250);
    for (let t = 0; t < 30 && edges.length; t++) {
      const e = edges[Math.floor(this.r() * edges.length)];
      if (e.bridge || e.tunnel || e.path.length < 12) continue;
      const q = e.path.at(this.r() * e.path.length), d = Math.hypot(q.x - x, q.y - y);
      if (d < 90 || d > 250 || !this.offscreen(q.x, q.y)) continue;
      const car = new Car('police', this.r, q.x, q.y, q.ang);
      if (car.worldSamples().some(([sx, sy]) => this.grid.at(sx, sy))) continue;
      if (this.r() < RAMS[this.stars]) car.armour();
      this.enlist(car);
      return true;
    }
    return false;
  }

  enlist(car: Car) {
    car.mode = 'police';
    car.crew = true;
    this.cars.push({ car, path: null, s: 0, replan: 0, stuck: 0, reverse: 0, calm: false, wrecked: false });
  }

  // A new police car joins the chase at (x, y), facing h (for the scenarios).
  dispatch(x: number, y: number, h: number) {
    this.enlist(new Car('police', this.r, x, y, h));
    return this.cars[this.cars.length - 1];
  }

  // Steering and pedals for a car chasing the player.
  chase(p: ChaseCar, dt: number, me: PlayerTarget) {
    const c = p.car, vf = c.forwardSpeed;
    const dx = me.x - c.x, dy = me.y - c.y, dist = Math.hypot(dx, dy);
    // (Not on the street over the tunnel you're in, nor in the tunnel under you.)
    const level = this.level(c, me);
    // Lost you: `me` is a spot it's looking at (lookout), driven to like a car would be, at
    // a looking pace, not rammed.
    const hunting = !this.seen && this.heat > 0, drives = !!me.car || hunting;
    let tx, ty, want;
    if (!me.car || dist >= 40 || !level || hunting) p.pit = undefined;
    const pit = !hunting && me.car && dist < 40 && level ? this.pitting(p, me, me.car, dt) : null;
    if (pit) ({ tx, ty, want } = pit);
    else if (!hunting && me.car && dist < 40 && level && this.clear(c.x, c.y, me.x, me.y)) {
      // In sight and you're driving: straight at you, to ram you.
      tx = me.x + me.vx * Math.min(0.8, dist / 25);
      ty = me.y + me.vy * Math.min(0.8, dist / 25);
      want = Math.max(12, me.speed + 6);
      // Another police car in the way, between it and you: past it on one side, to come
      // up alongside you and ram you from there, not into the back of the other one.
      const ux = (tx - c.x) / (Math.hypot(tx - c.x, ty - c.y) || 1), uy = (ty - c.y) / (Math.hypot(tx - c.x, ty - c.y) || 1);
      const block = this.cars.find((q) => {
        if (q === p || q.wrecked) return false;
        const fx = q.car.x - c.x, fy = q.car.y - c.y, along = fx * ux + fy * uy;
        return along > 2 && along < dist - 2 && Math.abs(fx * uy - fy * ux) < 2.6;
      });
      if (block) {
        // The side it's on already (or one picked once), across the way you're going.
        const hm = me.speed > 2 ? Math.atan2(me.vy, me.vx) : Math.atan2(uy, ux), nx = -Math.sin(hm), ny = Math.cos(hm);
        p.side ??= Math.sign((c.x - block.car.x) * nx + (c.y - block.car.y) * ny) || (this.r() < 0.5 ? -1 : 1);
        tx += nx * p.side * 3;
        ty += ny * p.side * 3;
        want += 3;
      } else p.side = undefined;
    } else {
      p.replan -= dt;
      // Where there's no way through (you're somewhere the street graph doesn't reach,
      // or it isn't loaded yet) it heads straight for you and tries again on the timer,
      // not every frame: a search that fails has looked at thousands of streets. On
      // foot the way ends at the roadside nearest you, and the car doesn't look for a
      // new one while its officer is out.
      if (c.crew && (p.replan < 0 || (drives && p.path && p.s > p.path.length - 6))) {
        const to = me.car ? null : this.roadside(me.x, me.y, true, me.level);
        p.path = this.route(c.x, c.y, to ? to.x : me.x, to ? to.y : me.y, true, [c.level ?? 0, me.level]);
        p.s = 0;
        p.replan = 1.2 + this.r() * 0.8;
      }
      if (!p.path) { tx = me.x; ty = me.y; want = 8; }
      else {
        ({ tx, ty, want } = along(c, p, p.path, hunting ? SEARCH_TOP : 24));
        // On foot: slow down for the end of the way and stop there.
        if (!drives) want = Math.min(want, clamp((p.path.length - p.s - 4) * 0.9, 0, 24));
      }
      // And stop short of you, should you be out in the road.
      if (!drives) want = Math.min(want, dist < 12 ? 0 : clamp((dist - 10) * 0.8, 3, 24));
    }
    // Another police car got there first and stands just ahead: stop behind it, not
    // squeeze past it over the parked cars.
    const behind = !drives && dist < 60 && this.cars.some((q) => q !== p && q.car.speed < 2
      && Math.hypot(q.car.x - c.x, q.car.y - c.y) < 9 && (q.car.x - c.x) * Math.cos(c.h) + (q.car.y - c.y) * Math.sin(c.h) > 0);
    if (behind) want = 0;
    // An officer out on foot: the car waits (and doesn't back up with its door open, if it
    // was backing out of somewhere as they got out). Pulling up to let them out: it stops.
    if (!c.crew || p.halt) want = 0;
    if (!c.crew) p.reverse = 0;
    // Through a red light with care.
    if (!p.calm && this.traffic.signals?.against(c.x, c.y, c.h, 22)) want = Math.min(want, 5);
    const { throttle, steer } = pedals(c, p, tx, ty, want, dt);
    // Close enough and you're not going anywhere: an officer gets out.
    // On foot, also once the car has got as near as the road goes: the officer runs
    // the rest of the way.
    const there = behind || (!me.car && dist < 60 && !!p.path && p.path.length - p.s < 8);
    if (c.crew && this.seen && !me.air && level && c.speed < 1 && (me.car ? me.speed < 2 && dist < 14 : dist < 18 || there)) this.getOut(c);
    // Near you and in sight, from four stars: a shot out of the window now and then.
    p.reload = (p.reload ?? 1) - dt;
    // (Only at you, in sight: not at where they're looking for you.)
    if (c.crew && !hunting && this.stars >= FROM_CARS && !me.air && level && dist < RANGE && p.reload <= 0 && this.clear(c.x, c.y, me.x, me.y)) {
      p.reload = this.pace() + 1;
      this.shoot(c.x, c.y, c, me);
    }
    return { throttle, steer, handbrake: want === 0 && Math.abs(vf) < 3 };
  }

  // The PIT manoeuvre: a car behind you pulls up alongside your back wheels, keeps pace,
  // then steers into your rear quarter, and the push swings your tail round (see
  // Car.upset): you spin out and stop, and they have you. From two stars, now and then
  // (PITS, PIT_REST), only at speed, and one car at a time. It can be beaten: brake or
  // swerve away as they come alongside (they give up when they can't keep there), steer
  // against the spin, or keep your speed down in the first place.
  // Returns where to head and how fast, or null when not trying one.
  pitting(p: ChaseCar, me: PlayerTarget, m: Car, dt: number) {
    const c = p.car;
    p.trick = (p.trick ?? 2 + this.r() * 3) - dt;
    const fx = Math.cos(m.h), fy = Math.sin(m.h), lx = -fy, ly = fx;
    const rx = c.x - m.x, ry = c.y - m.y, along = rx * fx + ry * fy, across = rx * lx + ry * ly;
    if (!p.pit) {
      if (p.trick > 0 || this.stars < 2 || me.speed < PIT_FAST || m.two || m.spec.heavy) return null;
      p.trick = 1 + this.r();
      // From behind you or beside you, not ahead; going your way; not while another
      // car is at it.
      if (along > 1 || along < -30 || Math.cos(c.h - m.h) < 0.7 || this.cars.some((q) => q.pit && q !== p)) return null;
      if (this.r() >= PITS[this.stars]) return null;
      p.pit = { phase: 'line', t: 0, side: Math.sign(across) || (this.r() < 0.5 ? -1 : 1), ok: 0, cramped: 0 };
    }
    const pit = p.pit;
    pit.t += dt;
    // Beside you, its front wheels level with your back ones, a little room between.
    const wide = (m.spec.W + c.spec.W) / 2, place = -m.spec.L / 2 + 0.9 - c.spec.L / 2 + 0.7;
    if (me.speed < PIT_FAST - 2 || Math.hypot(rx, ry) > 30) return this.endPit(p);
    let tx, ty, want;
    if (pit.phase === 'line') {
      const sx = m.x + fx * place + lx * pit.side * (wide + 0.6), sy = m.y + fy * place + ly * pit.side * (wide + 0.6);
      // No room that side (a wall, parked cars): not this time.
      pit.cramped = this.grid.at(sx, sy) || this.bodyAt(sx, sy, 0.8, c) ? pit.cramped + dt : 0;
      if (pit.cramped > 0.6) return this.endPit(p);
      const lead = 6 + me.speed * 0.4;
      tx = sx + fx * lead;
      ty = sy + fy * lead;
      want = me.speed + clamp((place - along) * 1.2, -6, 7);
      // There and keeping pace for a moment: in.
      const there = Math.abs(along - place) < 1.3 && Math.abs(across - pit.side * (wide + 0.6)) < 1 && Math.cos(c.h - m.h) > 0.96;
      pit.ok = there ? pit.ok + dt : 0;
      if (pit.ok > 0.35) { pit.phase = 'hit'; pit.t = 0; }
      else if (pit.t > 8) return this.endPit(p);
    } else if (pit.phase === 'hit') {
      // Steering into your back wheels, a touch quicker than you.
      const bx = m.x + fx * (-m.spec.L / 2 + 0.6), by = m.y + fy * (-m.spec.L / 2 + 0.6);
      tx = bx + fx * 4;
      ty = by + fy * 4;
      want = me.speed + 2;
      if (Math.abs(across) < wide + 0.15 || pit.t > 1.3) { pit.phase = 'off'; pit.t = 0; }
    } else {
      // Done: off the brakes behind you, out of the way of the spin.
      tx = c.x + Math.cos(c.h) * 10;
      ty = c.y + Math.sin(c.h) * 10;
      want = Math.max(0, me.speed - 5);
      if (pit.t > 1.5) return this.endPit(p);
    }
    return { tx, ty, want };
  }

  endPit(p: ChaseCar) {
    p.pit = undefined;
    p.trick = PIT_REST[this.stars] + this.r() * 4;
    return null;
  }

  // ---- Guns ----------------------------------------------------------------

  // Seconds to the next shot: quicker with more stars.
  pace() { return (this.stars >= 5 ? 0.5 : this.stars >= 4 ? 0.7 : 0.9) + this.r() * 0.5; }

  // A shot at you from (x, y). It's likelier to hit close up, with more stars, and when
  // you're standing still, and with the difficulty; a miss goes past you, a little to one side.
  shoot(x: number, y: number, who: Car | Officer, me: PlayerTarget) {
    if (this.arresting) return;
    const d = Math.hypot(me.x - x, me.y - y) || 1, ux = (me.x - x) / d, uy = (me.y - y) / d;
    const k = aim(), odds = clamp((0.5 + 0.07 * (this.stars - ARMED) - d / 60 - me.speed * 0.03) * k, 0.08 * k, 0.9);
    const hit = this.r() < odds;
    const from: Point3 = [x + ux * 0.6, y + uy * 0.6, this.height(x, y, who) + (who instanceof Car ? who.spec.H + 0.1 : 1.3)];
    const z = me.z + (me.car ? me.car.spec.H * 0.7 : 1.1);
    let to: Point3 = [me.x, me.y, z];
    if (!hit) {
      const a = Math.atan2(uy, ux) + (this.r() - 0.5) * 0.3, far = d + 4 + this.r() * 8;
      to = [x + Math.cos(a) * far, y + Math.sin(a) * far, z - this.r()];
    }
    this.onShot(from, to, hit);
  }

  // ---- Officers on foot --------------------------------------------------

  // (`away`: out of the door further from there, if it's free.)
  getOut(car: Car, away?: Point2) {
    car.crew = false;
    const lx = -Math.sin(car.h), ly = Math.cos(car.h);
    const first = away && (car.x - away[0]) * lx + (car.y - away[1]) * ly < 0 ? -1 : 1;
    let x = car.x + first * lx * (car.spec.W / 2 + 0.7), y = car.y + first * ly * (car.spec.W / 2 + 0.7), door = first > 0 ? 1 : 2;
    // Out of the other door if a wall or another car is on this side.
    if (this.grid.at(x, y) || this.bodyAt(x, y, 0.4, car)) { x = car.x - first * lx * (car.spec.W / 2 + 0.7); y = car.y - first * ly * (car.spec.W / 2 + 0.7); door = 3 - door; }
    // (It stays open till they're back.)
    car.open(door);
    let fig = this.spare.pop();
    if (!fig) {
      fig = new Figures(this.kit, 1);
      fig.lifeSize = 'police';
      fig.look(0, { shirt: '#1f3a68', trousers: '#1a2438', skin: '#e3b99a', hair: '#15233f', sleeves: true });
    }
    this.scene.add(fig.mesh);
    // On the car's level: out of a car in a tunnel, in the tunnel (not on the street above).
    // (`out`: still in the doorway while the door swings open; seen once it's half open.)
    this.officers.push({ avatarId: this.nextOfficerId++, x, y, h: car.h, vx: 0, vy: 0, car, fig, anim: new Anim(this.kit, 'idle'), down: 0, back: false, out: STEP_OUT, door, level: car.level, gz: car.gz });
  }

  blocked(x: number, y: number) {
    const g = this.grid, r = 0.3;
    return g.at(x, y) || g.at(x + r, y) || g.at(x - r, y) || g.at(x, y + r) || g.at(x, y - r);
  }

  walk(o: Officer, dt: number, me: PlayerTarget, goal = me) {
    if (o.led) return;
    if (o.out && o.out > 0) { o.out -= dt; o.vx = o.vy = 0; return; }
    o.diveRest = Math.max(0, (o.diveRest ?? 0) - dt);
    if (o.winded) o.winded = Math.max(0, o.winded - dt);
    if (o.dive) { this.diving(o, o.dive, dt, me); return; }
    if (o.down > 0) {
      o.down -= dt;
      const k = Math.exp(-4 * dt);
      o.vx *= k;
      o.vy *= k;
    } else {
      const ride = this.cars.find((p) => p.car === o.car && !p.wrecked);
      // Back to the car when you drive off (or the chase is over); after you otherwise.
      // At a roadblock they keep their places (until it's cleared, below).
      const toMe = Math.hypot(me.x - o.x, me.y - o.y);
      // Lost you: they look round where you were for a while, then go back to their car to
      // look further off (lookout). Seeing you again, they're after you once more.
      const lost = goal !== me && !o.post;
      if (!lost) o.looked = 0;
      else if (Math.hypot(goal.x - o.x, goal.y - o.y) < 4) o.looked = (o.looked ?? 0) + dt;
      o.back = this.heat <= 0 || (lost && (o.looked ?? 0) > LOOK_FOR) || (!o.post && !!(ride && me.car && me.speed > 6 && toMe > 12));
      // At a roadblock: behind their car while you drive up (or are far off). Once you've
      // stopped near them, they come for you as anyone would.
      const posted = !o.back && !!o.post && (toMe > 30 || (!!me.car && me.speed > 2));
      // You in a car: they make for the nearer of its front doors, not for its middle
      // (which they can't get near from the front or the back), and not for the one
      // another officer is making for.
      // Out of sight, to where they last knew you to be.
      let gx = goal.x, gy = goal.y, door = Infinity;
      o.at = undefined;
      for (const d of goal === me ? me.car?.doors ?? [] : []) {
        if (d.n > 2) continue;
        const [x, y] = me.car!.beside(d, 0.9), far = Math.hypot(x - o.x, y - o.y);
        if (far >= door || this.blocked(x, y) || this.officers.some((q) => q !== o && q.at === d.n && !q.back && q.down <= 0)) continue;
        door = far; gx = x; gy = y; o.at = d.n;
      }
      // Armed, in range and in sight: they stand and shoot. Closer in they still come to
      // arrest you.
      o.reload = (o.reload ?? 0.5 + this.r() * 0.6) - dt;
      const level = this.level(o, me);
      const aiming = !o.back && !this.arresting && this.stars >= ARMED && !me.air && level && toMe > 5 && toMe < RANGE && this.clear(o.x, o.y, me.x, me.y);
      if (this.arresting && !o.back) {
        // Someone else has you: they come up and stand round, a few steps off.
        this.standRound(o, me.x, me.y, STAND_BY, dt);
      } else if (aiming) {
        o.vx = o.vy = 0;
        o.h = Math.atan2(me.y - o.y, me.x - o.x);
        if (o.reload <= 0) { o.reload = this.pace(); this.shoot(o.x, o.y, o, me); }
      } else if (o.back) {
        // No car to go back to: they walk off.
        const tx = ride ? o.car.x : 2 * o.x - me.x, ty = ride ? o.car.y : 2 * o.y - me.y;
        const d = Math.hypot(tx - o.x, ty - o.y) || 1, [wx, wy] = ride ? this.towards(o, tx, ty, dt) : [tx, ty];
        steer(o, wx, wy, ride ? RUN : 1.4, this.bodyAt, o.car, this.r);
        if (ride && d < 2.6) { o.gone = true; o.car.crew = true; if (o.door) o.car.open(o.door, false); return; }
      } else if (posted) {
        this.arrive(o, o.post![0], o.post![1], Math.atan2(me.y - o.y, me.x - o.x), dt);
        o.grip = 0;
      } else {
        // After you on foot and you're running: a sprint while you're near, and a dive at
        // your legs once they'd reach you.
        const after = goal === me && !me.car && this.heat > 0 && !me.air && level && !this.arresting, running = after && this.moved > DIVE_FAST;
        if (running && toMe < SPRINT_NEAR && !o.winded) {
          o.sprint = (o.sprint ?? 0) + dt;
          if (o.sprint > SPRINT_FOR) { o.sprint = 0; o.winded = WINDED; }
        } else o.sprint = 0;
        if (running && this.lunge(o, me)) return;
        // Caught up: at your door, or at arm's length (round your car when both doors are
        // taken), facing you. On your heels while you walk: they keep up with you.
        // Lost you: to where you were, and they stand there looking round.
        if (lost) this.lookRound(o, goal.x, goal.y, dt);
        else if (o.at !== undefined) this.arrive(o, gx, gy, Math.atan2(me.car!.y - o.y, me.car!.x - o.x), dt);
        else this.standRound(o, goal.x, goal.y, goal === me && me.car ? me.car.spec.L / 2 + 1.2 : ARM, dt, after ? this.moved : 0, o.sprint ? SPRINT : RUN);
        if (this.heat > 0 && !me.air && level) {
          // Hold of you, or at the door of the car you've stopped in: it takes a moment, and
          // you can still run out of their hands (walking, you can't) or drive off.
          const reach = me.car ? me.car.spec.L / 2 + 1 : 1.1;
          const hold = (toMe < reach + 0.4 || door < 0.8) && (me.car ? me.speed < 2 : this.moved < 4.5);
          o.grip = hold ? (o.grip ?? 0) + dt : Math.max(0, (o.grip ?? 0) - 2 * dt);
          if (o.grip >= (me.car ? GRIP_CAR : GRIP)) { o.grip = 0; this.onBusted(o); }
        } else o.grip = 0;
      }
    }
    const nx = o.x + o.vx * dt, ny = o.y + o.vy * dt;
    if (!this.blocked(nx, o.y)) o.x = nx;
    if (!this.blocked(o.x, ny)) o.y = ny;
    if (o.down > 0) knocked(o.anim, dt, o.down);
    else locomote(o.anim, dt, Math.hypot(o.vx, o.vy));
    if (o.back && !this.cars.some((p) => p.car === o.car) && this.offscreen(o.x, o.y)) o.gone = true;
  }

  // Runs to (tx, ty), slowing to stop on the spot rather than overshooting it (and
  // turning on it, back and forth, as they did), and faces `face` once close. `pace`: how
  // fast the spot itself is moving (it's beside you and you're walking off), which they
  // keep up with on top of closing in; `top`, as fast as they'll go.
  arrive(o: Officer, tx: number, ty: number, face: number, dt: number, pace = 0, top = RUN) {
    const d = Math.hypot(tx - o.x, ty - o.y), h = o.h;
    if (d < 0.12 && pace < 0.2) { o.vx = o.vy = 0; o.detour = 0; }
    else {
      const [wx, wy] = d > 1.5 ? this.towards(o, tx, ty, dt) : [tx, ty];
      steer(o, wx, wy, Math.min(top, pace + 0.5 + d * 3), this.bodyAt, null, this.r);
    }
    if (d < 1.5) o.h = h + turnOf(h, face) * Math.min(1, 10 * dt);
  }

  // Whether an officer can walk straight from (ax, ay) to (bx, by): no building, wall or
  // fence on the line (in 0.4 m steps).
  walkable(ax: number, ay: number, bx: number, by: number) {
    const n = Math.ceil(Math.hypot(bx - ax, by - ay) / 0.4);
    for (let i = 1; i < n; i++) if (this.blocked(ax + ((bx - ax) * i) / n, ay + ((by - ay) * i) / n)) return false;
    return true;
  }

  // Where an officer heads for on the way to (tx, ty): straight there when nothing's in
  // the way; otherwise along their way round (footway), at the furthest point of it they
  // can walk straight to. With no way round found, straight on, as before.
  towards(o: Officer, tx: number, ty: number, dt: number): Point2 {
    if (this.walkable(o.x, o.y, tx, ty)) { o.way = undefined; return [tx, ty]; }
    let w = o.way;
    if (w) w.t -= dt;
    if (!w || w.t < 0 || Math.hypot(w.tx - tx, w.ty - ty) > FOOT_MOVED) {
      // (None found: not looking again so soon, a search that fails having looked at them all.)
      const pts = this.footway(o.x, o.y, tx, ty);
      w = o.way = { pts: pts ?? [], tx, ty, t: (pts ? FOOT_AGAIN : 4) + this.r() * 0.5 };
    }
    if (!w.pts.length) return [tx, ty];
    for (let i = w.pts.length - 1; i >= 0; i--) {
      if (i > 0 && !this.walkable(o.x, o.y, w.pts[i][0], w.pts[i][1])) continue;
      w.pts.splice(0, i);
      return w.pts[0];
    }
    return w.pts[0];
  }

  // The shortest way on foot from (ax, ay) to (bx, by) round whatever's in the way (an A*
  // search over squares of FOOT_CELL m, diagonals too but not across a corner), as points
  // ending at (bx, by); or null when there's none near enough. Somewhere blocked at the
  // end (beside a wall, or you're in a car against one) counts as reached from a square
  // next to it.
  footway(ax: number, ay: number, bx: number, by: number): Point2[] | null {
    const C = FOOT_CELL, x0 = Math.min(ax, bx) - FOOT_MARGIN, y0 = Math.min(ay, by) - FOOT_MARGIN;
    const W = Math.ceil((Math.max(ax, bx) + FOOT_MARGIN - x0) / C), H = Math.ceil((Math.max(ay, by) + FOOT_MARGIN - y0) / C);
    if (W * H > 250000) return null;
    const cx = (i: number) => x0 + (i % W + 0.5) * C, cy = (i: number) => y0 + (Math.floor(i / W) + 0.5) * C;
    const cell = (x: number, y: number) => Math.floor((y - y0) / C) * W + Math.floor((x - x0) / C);
    // (0 not looked at yet, 1 free, 2 blocked.)
    const state = new Uint8Array(W * H);
    const free = (i: number) => (state[i] ||= this.blocked(cx(i), cy(i)) ? 2 : 1) === 1;
    const start = cell(ax, ay), goal = cell(bx, by), gx = goal % W, gy = Math.floor(goal / W);
    const near = (i: number) => Math.max(Math.abs(i % W - gx), Math.abs(Math.floor(i / W) - gy)) <= 1;
    const est = (i: number) => { const dx = Math.abs(i % W - gx), dy = Math.abs(Math.floor(i / W) - gy); return Math.max(dx, dy) + 0.414 * Math.min(dx, dy); };
    const g = new Float32Array(W * H).fill(Infinity), from = new Int32Array(W * H).fill(-1);
    // A binary heap of cells by their estimate.
    const heap: number[] = [], f: number[] = [];
    const push = (i: number, k: number) => {
      let n = heap.length;
      heap.push(i); f.push(k);
      while (n > 0) {
        const p = (n - 1) >> 1;
        if (f[p] <= f[n]) break;
        [heap[p], heap[n]] = [heap[n], heap[p]]; [f[p], f[n]] = [f[n], f[p]];
        n = p;
      }
    };
    const pop = () => {
      const top = heap[0], lastI = heap.pop()!, lastF = f.pop()!;
      if (heap.length) {
        heap[0] = lastI; f[0] = lastF;
        for (let n = 0; ;) {
          const l = 2 * n + 1, r = l + 1;
          let m = n;
          if (l < heap.length && f[l] < f[m]) m = l;
          if (r < heap.length && f[r] < f[m]) m = r;
          if (m === n) break;
          [heap[m], heap[n]] = [heap[n], heap[m]]; [f[m], f[n]] = [f[n], f[m]];
          n = m;
        }
      }
      return top;
    };
    g[start] = 0;
    push(start, est(start));
    let end = -1;
    for (let pops = 0; heap.length && pops < FOOT_MOST; pops++) {
      const i = pop(), x = i % W, y = Math.floor(i / W);
      if (i === goal || (near(i) && !free(goal))) { end = i; break; }
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const j = ny * W + nx;
        if (!free(j) && j !== goal) continue;
        if (dx && dy && (!free(y * W + nx) || !free(ny * W + x))) continue;
        const c = g[i] + (dx && dy ? 1.414 : 1);
        if (c >= g[j]) continue;
        g[j] = c;
        from[j] = i;
        push(j, c + est(j));
      }
    }
    if (end < 0) return null;
    const pts: Point2[] = [[bx, by]];
    for (let i = from[end]; i >= 0 && i !== start; i = from[i]) pts.unshift([cx(i), cy(i)]);
    if (end !== goal) pts.unshift([cx(end), cy(end)]);
    return pts;
  }

  // Whether the officer dives at you now: when, setting off as fast as it takes (no
  // faster than a dive goes), their arms would be where you'll be when it's decided, and
  // nothing stands between.
  lunge(o: Officer, me: PlayerTarget) {
    if (o.diveRest || this.officers.some((q) => q.dive)) return false;
    const px = me.x + me.vx * DIVE_CONTACT, py = me.y + me.vy * DIVE_CONTACT;
    const dx = px - o.x, dy = py - o.y, d = Math.hypot(dx, dy), v = Math.max(1, (d - DIVE_ARMS) / DIVE_TRAVEL);
    if (d < 1 || v > DIVE_MAX || !this.clear(o.x, o.y, me.x, me.y)) return false;
    const ux = dx / d, uy = dy / d;
    for (const k of [0.8, 1.6, 2.4]) if (k < d && (this.blocked(o.x + ux * k, o.y + uy * k) || this.bodyAt(o.x + ux * k, o.y + uy * k, 0.35, null))) return false;
    o.dive = { t: 0, ux, uy, v, done: false };
    o.h = Math.atan2(uy, ux);
    o.vx = o.vy = 0;
    o.grip = 0;
    o.anim.play('tackle', true, 0.06);
    return true;
  }

  // Through the air and along the ground, slowing to a stop; whether they've got you is
  // decided at DIVE_CONTACT. Missed: up again once the clip has them on their knees.
  diving(o: Officer, d: Dive, dt: number, me: PlayerTarget) {
    d.t += dt;
    const v = d.v * Math.max(0, 1 - d.t / DIVE_SLIDE);
    const nx = o.x + d.ux * v * dt, ny = o.y + d.uy * v * dt;
    if (!this.blocked(nx, o.y)) o.x = nx;
    if (!this.blocked(o.x, ny)) o.y = ny;
    o.vx = o.vy = 0;
    o.anim.step(dt);
    if (!d.done && d.t >= DIVE_CONTACT) {
      d.done = true;
      const ax = o.x + d.ux * DIVE_ARMS, ay = o.y + d.uy * DIVE_ARMS;
      if (this.heat > 0 && !this.arresting && !me.car && !me.air && this.level(o, me) && Math.hypot(me.x - ax, me.y - ay) < DIVE_HIT) {
        // (Unless the arrest is off: for the tests, or you were busted already.)
        this.onBusted(o, true);
        if (this.arresting) { o.dive = undefined; return; }
      }
    }
    if (d.t > DIVE_UP) {
      o.dive = undefined;
      o.diveRest = DIVE_REST;
      o.anim.play('idle', true, 0.3);
    }
  }

  // To (x, y), where they last knew you to be, at a jog; there they stop and turn this way
  // and that, looking for you (not standing round the empty spot as if they had you).
  lookRound(o: Officer, x: number, y: number, dt: number) {
    // (Each a step or so off it, not all on the one spot.)
    x += Math.cos(o.avatarId * 2.4) * 1.5;
    y += Math.sin(o.avatarId * 2.4) * 1.5;
    if (Math.hypot(x - o.x, y - o.y) > 1) { this.arrive(o, x, y, o.h, dt, 0, RUN * 0.7); return; }
    o.vx = o.vy = 0;
    o.h += Math.sin((o.looked ?? 0) * 1.1 + o.avatarId) * 1.4 * dt;
  }

  standable(x: number, y: number) { return !this.blocked(x, y) && !this.bodyAt(x, y, 0.3, null); }

  // Stands r m from (cx, cy) (you, or where they last knew you to be), facing it: on the
  // side they came from, but not where another officer stands (they spread round you,
  // SPREAD apart), nor in a wall or a car; and they go round you to get there, not
  // through you. The way round is picked once they're near, and kept.
  standRound(o: Officer, cx: number, cy: number, r: number, dt: number, pace = 0, top = RUN) {
    const dx = o.x - cx, dy = o.y - cy, d = Math.hypot(dx, dy), here = Math.atan2(dy, dx);
    if (o.slot === undefined || d > r + 4) o.slot = here;
    let a = o.slot;
    for (let pass = 0; pass < 3; pass++) {
      for (const q of this.officers) {
        if (q === o || q.down > 0 || q.back || Math.hypot(q.x - cx, q.y - cy) > r + 4) continue;
        const qa = q.led ? Math.atan2(q.y - cy, q.x - cx) : q.slot;
        if (qa === undefined) continue;
        const off = turnOf(qa, a);
        if (Math.abs(off) < SPREAD) a = qa + (off >= 0 ? SPREAD : -SPREAD);
      }
    }
    for (let k = 1, base = a; k <= 8 && !this.standable(cx + Math.cos(a) * r, cy + Math.sin(a) * r); k++) a = base + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 0.45;
    o.slot = a;
    let tx = cx + Math.cos(a) * r, ty = cy + Math.sin(a) * r;
    const round = turnOf(here, a);
    if (Math.abs(round) > 0.7 && d < r + 2) {
      const b = here + Math.sign(round) * 0.7, rr = Math.max(d, r + 0.3);
      tx = cx + Math.cos(b) * rr;
      ty = cy + Math.sin(b) * rr;
    }
    this.arrive(o, tx, ty, Math.atan2(cy - o.y, cx - o.x), dt, pace, top);
  }

  // ---- Every frame -------------------------------------------------------

  // `me`: { x, y, vx, vy, speed, car, air, riding } for the player (car is null on
  // foot; air while flying a helicopter or riding a tram, out of the officers' reach).
  update(dt: number, me: PlayerTarget) {
    for (const k in this.cool) this.cool[k] -= dt;
    const stars = this.stars;
    this.duty = !!me.duty;
    this.moved = this.was && dt > 0 ? Math.hypot(me.x - this.was[0], me.y - this.was[1]) / dt : 0;
    this.was = [me.x, me.y];
    this.at = { z: me.z, level: me.level };

    // Patrols ride along with the traffic.
    const patrols = this.traffic.agents.filter((a) => a.car.type === 'police');
    for (const a of patrols) a.car.crew = true;
    this.spawnT -= dt;
    if (patrols.length < PATROLS && this.spawnT < 0) {
      this.spawnT = 2;
      const patrol = this.traffic.spawn((x, y) => {
        const d = Math.hypot(x - me.x, y - me.y);
        return d > 80 && d < 320 && this.offscreen(x, y);
      }, this.edgesNear(me.x, me.y, 320), 'police');
      if (patrol && this.r() < RAMS[0]) patrol.car.armour();
    }

    // Speeding past the police.
    this.checkT -= dt;
    if (this.checkT < 0) {
      this.checkT = 0.5;
      if (me.car) this.limit = speedLimit(this.nearestStreet(me.x, me.y)?.e);
      // Up to 10 km/h over the limit is never noticed. From there the chance at each check
      // (twice a second, and police see you for a few seconds) grows steeply: about 6% of
      // passes at 15 over, 40% at 20, most at 25, nearly all at 30.
      const over = me.speed * 3.6 - this.limit;
      if (me.car && !(me.duty && stars === 0) && over > 10 && this.r() < 0.5 * ((over - 10) / 20) ** 3 && this.sees(me.x, me.y, 60)) this.heat = Math.max(this.heat, STARS[0]);
    }

    // Out of sight long enough, you lose a star.
    this.seen = stars > 0 && this.sees(me.x, me.y);
    if (stars === 0 || this.seen) this.lose = 0;
    else if ((this.lose += dt * (me.riding ? 2 : me.duty ? ON_DUTY.lose : 1)) > 8 + 3 * stars) { // faster on a tram
      this.heat = stars >= 2 ? STARS[stars - 2] : 0;
      this.lose = 0;
    }

    // Crimes phoned in: the heat, and the police go to where it happened (unless
    // they're watching you already).
    for (const p of this.reports) {
      if ((p.t -= dt) > 0) continue;
      this.heat = Math.min(40, this.heat + p.heat);
      // (Where it happened, not which way you went from there.)
      if (!this.seen) { this.known = [p.x, p.y]; this.headed = null; }
    }
    this.reports = this.reports.filter((p) => p.t > 0);
    if (me.duty && this.stars === 0) this.heat = Math.max(0, this.heat - ON_DUTY.drain * dt);
    if (this.heat <= 0) this.known = null;
    // Where they're after you: where you are while they see you, otherwise where they
    // last knew you to be. (Wanted by other means, say a job's, they know.)
    if (this.seen || !this.known) this.known = [me.x, me.y];
    if (this.seen) this.headed = me.speed > 2 ? [me.vx / me.speed, me.vy / me.speed] : null;
    const goal: PlayerTarget = this.seen ? me : { ...me, x: this.known[0], y: this.known[1], vx: 0, vy: 0, speed: 0 };
    // Out of sight: a search from there (a new one when they hear of somewhere else).
    if (this.seen || this.heat <= 0) this.search = null;
    else {
      const [x, y] = this.known, [hx, hy] = this.headed ?? [0, 0];
      if (!this.search || this.search.x !== x || this.search.y !== y) this.search = { x, y, hx, hy, t: 0, checked: false, been: new Set() };
      this.search.t += dt;
    }

    // As many cars on your tail as your stars call for: patrols nearby join in first.
    const want = CHASERS[this.stars];
    let chasing = this.chasing;
    for (const a of patrols) {
      if (chasing.length >= want) break;
      if (Math.hypot(a.car.x - goal.x, a.car.y - goal.y) > 250) continue;
      this.traffic.release(a);
      this.enlist(a.car);
      chasing = this.chasing;
    }
    if (chasing.length < want && this.spawnT < 0) {
      this.spawnT = 1.5;
      this.spawn(goal.x, goal.y);
    }
    if (chasing.length > want) {
      const far = [...chasing].sort((a, b) => Math.hypot(b.car.x - goal.x, b.car.y - goal.y) - Math.hypot(a.car.x - goal.x, a.car.y - goal.y));
      for (const p of far.slice(0, chasing.length - want)) p.calm = true;
    }

    // A roadblock ahead of you, now and then from three stars, while they can see you
    // driving.
    this.blockT -= dt;
    if (this.block) this.tend(this.block, me, dt);
    else if (this.blockT < 0) {
      this.blockT = 1.5;
      if (this.stars >= BLOCK_FROM && this.seen && me.car && !me.level && me.speed > 6) this.roadblock(me);
    }

    for (const p of this.cars) {
      const c = p.car;
      if (!p.wrecked && (c.damage > WRECKED || c.roll)) p.wrecked = true;
      let ctl = null;
      if (p.block && !p.wrecked) {
        // Parked across the road, the handbrake on, nobody at the wheel: once it's knocked
        // moving it turns as it's shoved (one with a driver would keep its line).
        if (c.speed > 1.5) c.mode = 'loose';
        ctl = BRAKED;
      } else if (!p.wrecked && !p.calm) ctl = this.chase(p, dt, this.search ? this.lookout(p, goal, this.search, dt) : goal);
      else if (!p.wrecked) ctl = { throttle: c.forwardSpeed > 0.3 ? -1 : 0, steer: 0, handbrake: false };
      // (Rolled over, it keeps its crew, belted in their seats.)
      if (p.wrecked && !c.roll) c.mode = 'loose';
      c.update(dt, ctl, this.grid);
      if (p.halt && c.speed < 1) {
        p.halt = false;
        if (c.crew && !c.roll) this.getOut(c);
      }
      const d = Math.hypot(c.x - me.x, c.y - me.y);
      const waiting = this.officers.some((o) => o.car === c);
      p.gone = !waiting && this.offscreen(c.x, c.y) && (p.calm || p.wrecked ? d > 120 : d > 450);
      // Once its officers are back aboard, a car that has given up pulls out into the traffic
      // instead of standing in the lane.
      if (!p.gone && p.calm && !p.wrecked && !waiting && c.crew && Math.abs(c.forwardSpeed) < 0.5 && this.rejoin(c)) p.gone = true;
    }
    this.cars = this.cars.filter((p) => !p.gone);

    // Searching, the helicopter sweeps its light round the spot, wider as it goes on.
    const s = this.search, sweep = s ? Math.min(70, 15 + s.t * 4) : 0;
    this.helis.update(dt, s ? { ...goal, x: s.x + Math.cos(s.t * 0.3) * sweep, y: s.y + Math.sin(s.t * 0.3) * sweep } : goal, HELIS[this.stars]);
    for (const o of this.officers) this.walk(o, dt, me, goal);
    for (const o of this.officers) if (o.gone) this.dismiss(o);
    this.officers = this.officers.filter((o) => !o.gone);
  }

  // ---- Searching ----------------------------------------------------------

  // Where a car that has lost you goes to look (as a target for chase): the spot it was
  // given, until it gets there or gives up on it, and then another (pickSpot).
  lookout(p: ChaseCar, goal: PlayerTarget, s: Search, dt: number): PlayerTarget {
    const c = p.car, l = p.look;
    if (l && (l.of !== s || (l.t -= dt) < 0)) p.look = undefined;
    else if (l && Math.hypot(l.x - c.x, l.y - c.y) < SEARCH_THERE) {
      if (l.node) s.been.add(l.node);
      else s.checked = true;
      p.look = undefined;
    }
    if (!p.look) {
      p.look = this.pickSpot(p, s);
      p.replan = 0;
    }
    return { ...goal, x: p.look.x, y: p.look.y };
  }

  // The next place for a car to look. The one nearest goes to the spot itself first; the
  // others, and then everyone, to the street corners round it: within SEARCH_NEAR m by
  // road at first and further out as time goes on, ahead the way you were going, at
  // corners nobody has looked at yet and away from where the other cars are looking.
  pickSpot(p: ChaseCar, s: Search): Look {
    const others = this.chasing.filter((q) => q !== p && q.look?.of === s);
    if (!s.checked && !others.some((q) => !q.look!.node)) {
      const d = (q: ChaseCar) => Math.hypot(q.car.x - s.x, q.car.y - s.y);
      // (As near it as the road goes: you were in a park, say.)
      const to = this.roadside(s.x, s.y, true, this.at.level) ?? { x: s.x, y: s.y };
      if (!this.chasing.some((q) => q !== p && q.look?.of !== s && d(q) < d(p))) return { x: to.x, y: to.y, of: s, t: LOOK_GIVE_UP };
    }
    this.sync();
    const st = this.nearestStreet(s.x, s.y, 60);
    if (!st) return { x: s.x, y: s.y, of: s, t: 10 };
    const far = Math.min(SEARCH_FAR, SEARCH_NEAR + s.t * SEARCH_GROW);
    const g = new Map<string, number>(), heap = new Heap();
    for (const [n, d] of [[st.e.u, st.s], [st.e.v, st.e.mid.length - st.s]] as [string, number][]) { g.set(n, d); heap.push([d, n]); }
    let best: Look | null = null, top = -Infinity;
    for (let pops = 0; heap.size && pops < 3000; pops++) {
      const [d, n] = heap.pop()!;
      if (d > (g.get(n) ?? Infinity)) continue; // stale entry
      const at = this.nodes.get(n);
      if (!at) continue;
      if (d > 25) {
        const dx = at[0] - s.x, dy = at[1] - s.y, r = Math.hypot(dx, dy) || 1;
        let score = -Math.abs(d - far * 0.7) / far + 0.7 * (dx * s.hx + dy * s.hy) / r + this.r() * 0.35;
        if (s.been.has(n)) score -= 1;
        for (const q of others) if (Math.hypot(q.look!.x - at[0], q.look!.y - at[1]) < SEARCH_APART) score -= 0.8;
        if (score > top) { top = score; best = { x: at[0], y: at[1], node: n, of: s, t: LOOK_GIVE_UP }; }
      }
      for (const l of this.links.get(n) || []) {
        if (l.foot) continue;
        const c = d + (l.e.mid?.length ?? 0);
        if (c > far || c >= (g.get(l.to) ?? Infinity)) continue;
        g.set(l.to, c);
        heap.push([c, l.to]);
      }
    }
    return best ?? { x: s.x, y: s.y, of: s, t: 10 };
  }

  // Hands a stopped police car to the traffic, on the lane that's nearest and runs most the way
  // it's facing (it stopped wherever the chase ended, often at an angle; if it's facing
  // against a one-way street it turns round in the lane).
  rejoin(car: Car) {
    let best: { e: DriveEdge; s: number; score: number } | null = null;
    for (const e of this.edgesNear(car.x, car.y, 15)) {
      const q = project(e.path, car.x, car.y), cos = Math.cos(car.h - e.path.at(q.s).ang);
      const score = q.d + 8 * (1 - cos);
      if (q.d > 12 || (best && score >= best.score)) continue;
      best = { e, s: q.s, score };
    }
    if (!best) return false;
    this.traffic.adopt(car, best.e, best.s, 0);
    return true;
  }

  // ---- Roadblocks ----------------------------------------------------------

  // Sets up a roadblock on the way you're driving, out of your sight (roadblock.ts): the
  // first place along it where the cars fit across the street and close it. Whether it did.
  roadblock(me: PlayerTarget) {
    this.sync();
    const st = this.nearestStreet(me.x, me.y, 12);
    if (!st) return false;
    const p = st.e.mid.at(st.s), fwd = me.vx * Math.cos(p.ang) + me.vy * Math.sin(p.ang) >= 0;
    const { L, W } = TYPES.police, stars = this.stars;
    let tried = 0;
    for (const sp of ahead(st.e, st.s, fwd, this.links, BLOCK_NEAR, BLOCK_FAR, this.spots)) {
      // (Round a bend it can be nearer than it is along the street.)
      if (!this.offscreen(sp.x, sp.y) || Math.hypot(sp.x - me.x, sp.y - me.y) < BLOCK_NEAR * 0.7) continue;
      if (tried++ > 8) break;
      if (this.grid.at(sp.x, sp.y) || this.bodyAt(sp.x, sp.y, 1, null)) continue;
      const right = this.open(sp, -1, sp.right + 0.5, L * 0.3), left = this.open(sp, 1, sp.left + 0.5, L * 0.3);
      const cars = layout(sp, right, left, BLOCK_GAP[stars], BLOCK_CARS[stars], L, W, this.placed);
      if (!cars || !cars.every((q) => this.fits(q, L, W))) continue;
      this.setUp(sp, cars);
      return true;
    }
    return false;
  }

  // How far across the street from the spot (`a` m on along it) a car can stand, to the
  // `side` (1 left, -1 right): to a wall, a car, or `most`.
  private open(sp: Spot, side: number, most: number, a: number) {
    const fx = Math.cos(sp.ang), fy = Math.sin(sp.ang), lx = -fy * side, ly = fx * side;
    const ox = sp.x + fx * a, oy = sp.y + fy * a;
    for (let c = 0; c < most; c += 0.4) {
      const x = ox + lx * c, y = oy + ly * c;
      if (this.grid.at(x, y) || this.bodyAt(x, y, 0.3, null)) return Math.max(0, c - 0.5);
    }
    return most;
  }

  // Whether a car of the block has room where it would stand: clear of walls, other cars
  // and trams, and of the tram tracks (trams couldn't get by).
  private fits(q: Placed, L: number, W: number) {
    const c = Math.cos(q.h), s = Math.sin(q.h);
    for (let i = 0; i <= 4; i++) {
      for (let j = -1; j <= 1; j++) {
        const a = (i / 4 - 0.5) * (L - 0.2), b = j * (W / 2 - 0.1);
        if (this.grid.at(q.x + c * a - s * b, q.y + s * a + c * b)) return false;
      }
    }
    for (let i = -1; i <= 1; i++) if (this.bodyAt(q.x + c * i * (L - W) / 2, q.y + s * i * (L - W) / 2, W / 2, null)) return false;
    return !this.trackNear(q.x, q.y, L / 2 + 1);
  }

  // The cars, each with an officer out of the door away from you, standing a step behind it.
  private setUp(sp: Spot, cars: Placed[]) {
    const b: Roadblock = { x: sp.x, y: sp.y, ang: sp.ang, cars: [], t: 0, done: false };
    const fx = Math.cos(sp.ang), fy = Math.sin(sp.ang), you: Point2 = [sp.x - fx * 60, sp.y - fy * 60];
    for (const q of cars) {
      const car = new Car('police', this.r, q.x, q.y, q.h);
      if (this.r() < RAMS[this.stars]) car.armour();
      car.mode = 'police';
      car.crew = true;
      car.mass = car.spec.mass * BLOCK_MASS;
      this.cars.push({ car, path: null, s: 0, replan: 0, stuck: 0, reverse: 0, calm: false, wrecked: false, block: b });
      b.cars.push(car);
      this.getOut(car, you);
      const o = this.officers[this.officers.length - 1], px = o.x + fx * 1.2, py = o.y + fy * 1.2;
      o.block = b;
      o.post = this.blocked(px, py) ? [o.x, o.y] : [px, py];
      o.h = sp.ang + Math.PI;
    }
    this.block = b;
    // (And a while before the next.)
    this.blockT = BLOCK_REST[this.stars] + this.r() * 8;
  }

  // Clears the roadblock away once you're past it, far off, it has stood long enough, or
  // the chase is over: the officers go back to their cars, which drive off as cars that
  // have given up do (in sight), or are simply gone (out of it).
  tend(b: Roadblock, me: PlayerTarget, dt: number) {
    b.t += dt;
    const dx = me.x - b.x, dy = me.y - b.y, d = Math.hypot(dx, dy), past = dx * Math.cos(b.ang) + dy * Math.sin(b.ang);
    if (this.heat > 0 && !(past > 20 && d > 25) && d < BLOCK_GONE && !(b.t > 90 && d > 150)) return;
    b.done = true;
    this.block = null;
    const seen = b.cars.some((c) => !this.offscreen(c.x, c.y)) || this.officers.some((o) => o.block === b && !this.offscreen(o.x, o.y));
    for (const o of this.officers) {
      if (o.block !== b) continue;
      o.block = o.post = undefined;
      if (!seen) o.gone = true;
    }
    for (const p of this.cars) {
      if (p.block !== b) continue;
      p.block = undefined;
      p.calm = true;
      p.car.mass = p.car.spec.mass;
      if (!p.wrecked) p.car.mode = 'police';
    }
    if (!seen) this.cars = this.cars.filter((p) => !b.cars.includes(p.car));
  }

  // After an arrest: the stars go, the officers go back to their cars.
  forgive() {
    this.heat = 0;
    this.lose = 0;
    this.reports = [];
    this.known = null;
    this.headed = null;
    this.search = null;
    for (const p of this.cars) p.calm = true;
  }

  // The cars chasing you, which have their lights going. (One you're driving has them
  // as you set them: Car.beacon, in main.ts.)
  get lit() { return this.cars.filter((p) => !p.calm && !p.wrecked).map((p) => p.car); }

  render(height: (x: number, y: number, who: Car | Officer) => number, time: number, eye?: THREE.Vector3) {
    this.helis.render(time, eye);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), sc = new THREE.Vector3(SCALE, SCALE, SCALE);
    for (const o of this.officers) {
      m.compose(p.set(o.x, height(o.x, o.y, o), -o.y), q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, o.h), sc);
      // Still behind the opening door: not drawn yet, life size or not.
      if (o.out && o.out > STEP_OUT / 2) { o.fig.place(0, m.makeScale(0, 0, 0), o.anim); o.fig.commit(1); continue; }
      o.fig.set(0, m, o.anim, -1, m, o.avatarId);
      o.fig.commit(1);
    }
  }
}
