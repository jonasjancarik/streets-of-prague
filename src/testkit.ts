import { Car, COURIER_BOXES } from './car.ts';
import { courierLook } from './figures.ts';
import { posts } from './posts.ts';
import type { Post } from './posts.ts';
import type { Point2 } from './map/geo.ts';
import { segDist } from './network.ts';
import type { DriveEdge, DriveGraph } from './network.ts';
import type { Wallet } from './money.ts';
import type { Police } from './police.ts';
import type { Health } from './guns.ts';
import type { Clock } from './clock.ts';
import type { Fires } from './fire.ts';
import type { Brigade } from './brigade.ts';
import type { Ambulances } from './ambulance.ts';
import type { Pedestrian } from './people.ts';
import type { Traffic } from './traffic.ts';
import type { TramBody } from './trams.ts';
import type { Kind } from './weather.ts';
import type { Boats } from './boats.ts';
import type { Ferries } from './ferries.ts';
import type { Bags } from './bags.ts';

// Test API for scenarios (scenarios/*.ts), the developer panel and scripts/scene.mjs,
// as window.__test. Positions are latitude/longitude in and out, headings are compass
// degrees (0 north, 90 east), speeds km/h: the units you'd use talking about a place.

export const PLACES: Record<string, { at: Point2; note: string }> = {
  staromak: { at: [50.0873, 14.4206], note: 'Old Town Square' },
  ujezd: { at: [50.0808, 14.4052], note: 'Újezd: trams and the park' },
  vodickova: { at: [50.0808, 14.4245], note: 'Vodičkova: a tram street' },
  karlova: { at: [50.0862, 14.4170], note: 'Karlova: a narrow old-town lane' },
  karlak: { at: [50.0760, 14.4185], note: 'Karlovo náměstí: main roads and buses' },
  mustek: { at: [50.0835, 14.4235], note: 'Můstek: metro entrances' },
  most: { at: [50.0862, 14.4125], note: 'By Charles Bridge: the river and quays' },
  petrin: { at: [50.0830, 14.3965], note: 'Petřín: trees and slopes' },
  letna: { at: [50.0930, 14.4275], note: 'Letná park' },
  malostranske: { at: [50.0883, 14.4030], note: 'Malostranské náměstí: courtyards and lanes' },
};

import type { StepEdge } from './stepEdges.ts';

export type Where = string | Point2 | { lat: number; lon: number };

// The free camera: looking at (x, y) from `height` m up, tilted `tilt`° from straight
// down, facing `heading` (compass degrees).
export interface FreeCam { x: number; y: number; height: number; tilt: number; heading: number }

export interface Check { name: string; pass: boolean; detail?: string }
export interface Result { name: string; title: string; pass: boolean; checks: Check[]; ms: number; error?: string }
export interface Scenario { title: string; run: (t: Testkit) => Promise<void> }

interface Game {
  toLocal: (lon: number, lat: number) => Point2;
  toLonLat: (x: number, y: number) => Point2;
  teleport: (x: number, y: number) => Promise<void>;
  me: () => { x: number; y: number; h: number; vx: number; vy: number };
  car: () => Car | null;
  heli: () => { readonly landed: boolean } | null;
  mode: () => string;
  street: () => string | null;
  enterOrExit: () => void;
  interact: () => void;
  arrest: { readonly now: { phase: string } | null };
  // Wasted and not yet come round; and the move to the hospital or the cell, once under way.
  recovering: () => boolean;
  // E beside this car, meaning this car: not a nearer one, a taxi, a tram or a bag.
  enterCar: (c: Car) => void;
  settled: () => Promise<void>;
  addCar: (c: Car) => void;
  loose: Car[];
  simulate: (dt: number, ctl?: Partial<Controls>) => void;
  view: (zoom: number) => void;
  loaded: (x: number, y: number) => Promise<void>;
  grid: { at: (x: number, y: number) => number };
  steps: (x: number, y: number, r: number) => { edges: StepEdge[]; crossings: { x: number; y: number; dx: number; dy: number; drop: number; hw: string }[] };
  ground: (x: number, y: number) => number;
  streets: DriveGraph;
  // Whether the countryside past the map's edge is being made (?countryside).
  countryside: () => boolean;
  boats: Boats;
  ferries: Ferries;
  pid: { state: string | null; buy: (now: number) => boolean };
  carsNear: (x: number, y: number, r: number) => Car[];
  tramsNear: (x: number, y: number, r: number) => TramBody[];
  // Where the camera looks now, and how high it is (for starting the free camera there).
  view0: () => { x: number; y: number; height: number };
  viewRadius: () => number;
  offscreen: (x: number, y: number) => boolean;
  canvas: HTMLElement; fov: number;
  wallet: Wallet; police: Police; health: Health; clock: Clock; fires: Fires; brigade: Brigade; ambulances: Ambulances; traffic: Traffic; crowd: { people: { state: string; x: number; y: number }[] }; hurtNearest: (grave?: boolean) => Pedestrian | null;
  weather: { set: (k: Kind | 'auto') => void; kind: () => string };
  season: { set: (when: string | number) => void; date: () => string };
  rng: () => number;
  bags: Bags;
}

type Controls = { move: number; turn: number; run: boolean; brake: boolean; jump: boolean; aim: { h: number; mag: number } | null };

const rad = (deg: number) => ((90 - deg) * Math.PI) / 180;
const deg = (h: number) => ((((90 - (h * 180) / Math.PI) % 360) + 360) % 360);
const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
const round = (x: number, n = 1) => Math.round(x * 10 ** n) / 10 ** n;

export function setupTestkit(g: Game, scenarios = import.meta.glob<{ default: Scenario }>('../scenarios/*.ts')) {
  const names = Object.keys(scenarios).map((p) => p.replace(/^.*\/(.*)\.ts$/, '$1')).sort();

  // The cars the kit has put down, taken away again before the next scenario.
  const made: Car[] = [];
  const kit = {
    PLACES,
    // The live game's clock: paused, or running at this speed (0.25 = slow motion).
    paused: false,
    speed: 1,
    // Nothing hurts you (for looking round a chase).
    unhurt: false,
    // No traffic: nothing new drives in (t.empty() also sends away what is there).
    quiet: false,
    // The police can't arrest you. On while a scenario runs, unless it turns it off: an
    // arrest leads you away, keeps you out of cars and leaves you at the station.
    unarrested: false,
    // true while the developer panel runs a scenario: waits play out in real time so
    // you can watch; headless, they run as fast as they can.
    watch: false,
    checks: [] as Check[],
    // Set: the camera stays here instead of following you (the world still streams in
    // round it).
    cam: null as FreeCam | null,

    toLocal(w: Where): Point2 {
      if (typeof w === 'string') {
        const p = PLACES[w];
        if (!p) throw new Error(`No place called ${w}; there are ${Object.keys(PLACES).join(', ')}`);
        return g.toLocal(p.at[1], p.at[0]);
      }
      const [lat, lon] = Array.isArray(w) ? w : [w.lat, w.lon];
      return g.toLocal(lon, lat);
    },

    // Where you are, as data (and as a line to paste into a conversation).
    where() {
      const m = g.me(), [lon, lat] = g.toLonLat(m.x, m.y);
      return { lat: round(lat, 5), lon: round(lon, 5), heading: Math.round(deg(m.h)), street: g.street(), mode: g.mode(), x: round(m.x), y: round(m.y) };
    },

    async go(w: Where, opt: { heading?: number } = {}) {
      const [x, y] = kit.toLocal(w);
      await g.teleport(x, y);
      if (opt.heading !== undefined) g.me().h = rad(opt.heading);
      await frame();
    },

    // Exactly here, on foot (go() first: it loads the place, and then stands you on the
    // nearest walkable ground, which can be a step or two away).
    stand(w: Where) {
      const m = g.me();
      [m.x, m.y] = kit.toLocal(w);
    },

    // Scenario preparation uses the ordinary descent/exit controls. Teleporting a
    // flying vehicle alone keeps it flying, so first find open landing ground away
    // from the next test's cars, land through simulation, then get out normally.
    async onFoot() {
      const heli = g.heli();
      if (heli && !heli.landed) {
        const { x, y } = g.me();
        await g.loaded(x, y);
        let landing: Point2 | null = null;
        for (let r = 100; r <= 200 && !landing; r += 25) for (let i = 0; i < 24; i++) {
          const a = i * Math.PI / 12, lx = x + Math.cos(a) * r, ly = y + Math.sin(a) * r;
          if ([[0, 0], [3, 0], [-3, 0], [0, 3], [0, -3]].every(([dx, dy]) => g.grid.at(lx + dx, ly + dy) === 0)) {
            landing = [lx, ly];
            break;
          }
        }
        if (!landing) throw new Error('No clear landing ground near the scenario start');
        await g.teleport(...landing);
        for (let seconds = 0; seconds < 45 && !heli.landed; seconds++) await kit.wait(1, { run: true });
        if (!heli.landed) throw new Error('The helicopter did not land during scenario preparation');
      }
      kit.exit();
      if (g.mode() !== 'foot') throw new Error(`Could not start the scenario on foot from ${g.mode()}`);
      kit.cam = null;
      g.view(1);
      await frame();
    },

    time(hhmm: string) {
      const m = /^(\d{1,2})[:.](\d{2})$/.exec(hhmm);
      if (!m) throw new Error(`Time as 14:30, not ${hhmm}`);
      const sec = (+m[1] * 60 + +m[2]) * 60;
      g.clock.advance(sec - (g.clock.t % 86400));
    },
    weather(kind: Kind | 'auto') { g.weather.set(kind); },
    // The date: 'spring', 'summer', 'autumn' or 'winter' (a typical day of it), '10-20' or a day of the year.
    season(when: string | number) { g.season.set(when); },

    // What the arrest does to the chase: the stars go and the police cars stand down.
    forgive() { g.police.forgive(); },

    policeLights(c: Car) { return g.police.lit(g.car()).includes(c); },
    policeCar() {
      const m = g.me();
      return [...g.police.cars.map((p) => p.car), ...g.traffic.agents.map((a) => a.car)]
        .filter((c) => c.type === 'police' && !c.burnt)
        .sort((a, b) => Math.hypot(a.x - m.x, a.y - m.y) - Math.hypot(b.x - m.x, b.y - m.y))[0] ?? null;
    },

    // The nearest delivery courier riding in traffic. `make`: with none about, the
    // nearest rider of a bike or moped is given a courier's box (traffic makes about
    // half its riders couriers, so now and then a street has none for a while).
    courier(make = false) {
      const m = g.me();
      const riders = g.traffic.agents.map((a) => a.car).filter((c) => c.two && c.rider)
        .sort((a, b) => Math.hypot(a.x - m.x, a.y - m.y) - Math.hypot(b.x - m.x, b.y - m.y));
      const c = riders.find((k) => k.courier) ?? (make ? riders[0] : null) ?? null;
      if (c && !c.courier) {
        c.setBox(COURIER_BOXES[0]);
        c.rider = courierLook(g.rng, COURIER_BOXES[0]);
      }
      return c;
    },
    // Couriers' bags: the one you carry, and those lying about (how far from you, in metres).
    bags() {
      const m = g.me();
      return { carried: g.bags.carried, lying: g.bags.list.map((b) => ({ colour: b.colour, away: round(Math.hypot(b.x - m.x, b.y - m.y)) })) };
    },
    // People on foot near a spot, and what each is doing.
    peopleNear(x: number, y: number, r: number) {
      return g.crowd.people.filter((p) => Math.hypot(p.x - x, p.y - y) < r).map((p) => ({ state: p.state, away: round(Math.hypot(p.x - x, p.y - y)) }));
    },
    // Picks up everything: no bags on the ground, none carried.
    clearBags() { for (const b of [...g.bags.list]) g.bags.remove(b); g.bags.carry(null); },
    // Stand next to the nearest bag lying about.
    toBag() {
      const m = g.me();
      const b = g.bags.list.slice().sort((p, q) => Math.hypot(p.x - m.x, p.y - m.y) - Math.hypot(q.x - m.x, q.y - m.y))[0];
      if (!b) throw new Error('No bag lying about');
      // Beside it, on the side with the most room to the vehicles round it (the bike it
      // came off, a car parked at the kerb): E means the nearer of bag and vehicle.
      const cars = g.carsNear(b.x, b.y, 8);
      let best = -Infinity;
      for (let i = 0; i < 12; i++) {
        const x = b.x + Math.cos(i * Math.PI / 6) * 0.4, y = b.y + Math.sin(i * Math.PI / 6) * 0.4;
        const room = Math.min(99, ...cars.map((c) => (c.two ? Math.hypot(c.x - x, c.y - y) : c.gap(x, y))));
        if (room > best) { best = room; m.x = x; m.y = y; }
      }
    },
    // E, on foot: get in, pick up, put down.
    interact() { g.enterOrExit(); },
    // The streets without traffic, for a drive nothing should get in the way of (until
    // the scenario ends, or t.empty(false)).
    empty(on = true) {
      kit.quiet = on;
      if (on) for (const a of [...g.traffic.agents]) g.traffic.release(a);
    },
    // How far the nearest vehicle's side is, in metres (E gets you into one within 1.8 m).
    vehicleGap() {
      const m = g.me();
      return Math.min(99, ...g.carsNear(m.x, m.y, 12).filter((c) => c !== g.car() && !c.burnt).map((c) => c.gap(m.x, m.y)));
    },
    // E as the player presses it: into and out of a car through its door, which takes a
    // moment (t.wait for it).
    press() { g.interact(); },
    // Stands you beside a car's door (1: the driver's, 2: the other front one), `out` m from its side.
    toDoor(c: Car, n = 1, out = 1.2) {
      const door = c.doors.find((d) => d.n === n);
      if (!door) throw new Error(`No door ${n} on a ${c.type}`);
      const m = g.me();
      [m.x, m.y] = c.beside(door, out);
      return Math.hypot(m.x - c.x, m.y - c.y);
    },
    // How far you are from where you'd stand to use a car's door.
    fromDoor(c: Car, n = 1) {
      const door = c.doors.find((d) => d.n === n), m = g.me();
      if (!door) throw new Error(`No door ${n} on a ${c.type}`);
      const [x, y] = c.beside(door);
      return round(Math.hypot(m.x - x, m.y - y));
    },
    // How far an arrest has got ('door', 'out', 'hands', 'cuff', 'lead', 'seat', 'back'), or null.
    arrested() { return g.arrest.now?.phase ?? null; },

    set({ money, stars, health }: { money?: number; stars?: number; health?: number }) {
      if (money !== undefined) g.wallet.balance = Math.max(0, Math.floor(money));
      if (stars !== undefined) {
        g.police.heat = Math.max(0, Math.min(5, stars)) ** 2;
        if (!stars) g.police.reset();
      }
      if (health !== undefined) g.health.value = Math.max(1, Math.min(100, health));
    },

    // A car on clear ground just ahead of you (or where you say), facing your way.
    car(type = 'hatch', opt: { ahead?: number; at?: Where; heading?: number } = {}) {
      const m = g.me(), h = opt.heading !== undefined ? rad(opt.heading) : m.h;
      const base = opt.at ? kit.toLocal(opt.at) : [m.x, m.y];
      for (let d = opt.ahead ?? 5; d < 60; d += 1.5) for (const side of [0, 2.5, -2.5, 5, -5]) {
        const x = base[0] + Math.cos(h) * d - Math.sin(h) * side, y = base[1] + Math.sin(h) * d + Math.cos(h) * side;
        const c = new Car(type, g.rng, x, y, h);
        if (c.worldSamples().every(([sx, sy]) => g.grid.at(sx, sy) === 0) && !posts.touches(c)) {
          c.mode = 'loose';
          g.addCar(c);
          made.push(c);
          return c;
        }
      }
      throw new Error('No clear ground for a car here');
    },

    // Whether a loose car (a wreck, a parked or left car) is still in the world.
    standing(c: Car) { return g.loose.includes(c); },
    // The current production cleanup view, using the car's actual position.
    carView(c: Car) {
      const player = g.me(), camera = g.view0();
      return { playerDistance: Math.hypot(c.x - player.x, c.y - player.y),
        cameraDistance: Math.hypot(c.x - camera.x, c.y - camera.y),
        radius: g.viewRadius(), outOfSight: g.offscreen(c.x, c.y) };
    },

    // Leaves the nearest person on the pavement lying hurt: an ambulance is called.
    hurt(grave = false) { return g.hurtNearest(grave); },
    // How a hurt person and the ambulance sent to them stand.
    rescue(p: Pedestrian) {
      const r = g.ambulances.rigs.find((k) => k.patient === p);
      return { hurt: p.hurt !== undefined, ambulance: r ? r.phase : null, treated: r ? Math.round(r.treated * 10) / 10 : 0, medics: g.ambulances.crew.filter((m) => m.rig.patient === p).length, speed: r ? round(r.car.speed) : 0, carried: !!r?.carried, load: r ? Math.round(r.load) : 0, away: r ? Math.round(Math.hypot(r.car.x - p.x, r.car.y - p.y)) : 0, path: r ? (r.path ? Math.round(r.path.length - r.s) : null) : null, stuck: r ? round(r.t) : 0 };
    },

    // Steps up to the ambulance sent to this person and takes it: how many of its crew run after you.
    steal(p: Pedestrian) {
      const r = g.ambulances.rigs.find((k) => k.patient === p);
      if (!r) return -1;
      const m = g.me(), c = r.car;
      m.x = c.x - Math.sin(c.h) * (c.spec.W / 2 + 0.8);
      m.y = c.y + Math.cos(c.h) * (c.spec.W / 2 + 0.8);
      g.enterCar(c);
      const crew = g.ambulances.crew;
      return g.car() === c ? crew.filter((k) => k.chase !== undefined).length : -1;
    },

    // Sets a car on fire (a parked one burns for a minute or so before it blows up, the one
    // you're driving for a few seconds).
    ignite(c: Car) {
      c.damage = Math.max(c.damage, 95);
      g.fires.check(c);
    },
    // The traffic car nearest to you with a driver in it, and whether it still has one.
    // The nearest car in traffic. `roomy`: one with open ground at its driver's door and
    // no other car within reach of it, so E there means that door.
    trafficCar(roomy = false) {
      const m = g.me();
      const room = (c: Car) => {
        const door = c.doors.find((d) => d.n === 1);
        if (!door) return false;
        const [x, y] = c.beside(door, 1);
        return g.grid.at(x, y) === 0 && g.carsNear(x, y, 8).every((o) => o === c || o.gap(x, y) > 2);
      };
      return g.traffic.agents.map((k) => k.car).filter((c) => !c.two && (!roomy || room(c))).sort((a, b) => Math.hypot(a.x - m.x, a.y - m.y) - Math.hypot(b.x - m.x, b.y - m.y))[0] ?? null;
    },
    driven(c: Car) { return g.traffic.agents.some((k) => k.car === c); },
    fleeing(c: Car) { return g.crowd.people.filter((p) => p.state === 'flee' && Math.hypot(p.x - c.x, p.y - c.y) < 16).length; },
    // How a car's fire and the brigade's call to it stand.
    fire(c: Car) {
      const b = g.fires.blazes.get(c), e = g.brigade.engines.find((k) => k.target === c);
      return {
        burning: !c.burnt && !!b && b.fuse >= 0, wreck: !!c.burnt, flames: g.fires.onFire(c),
        engine: e ? e.phase : null, spraying: g.brigade.crew.filter((k) => k.engine.target === c && k.spraying).length, cannon: !!e && !!e.spraying,
      };
    },

    // Into a new car of this type (out of whatever you were in first).
    async drive(type = 'hatch') {
      if (g.mode() !== 'foot') g.enterOrExit();
      const c = kit.car(type, { ahead: 3 });
      await kit.enter(c);
      return c;
    },

    // Take an existing car through the ordinary enter/exit path, including theft.
    async enter(c: Car) {
      if (g.car() === c) return;
      if (g.mode() !== 'foot') g.enterOrExit();
      const m = g.me();
      m.x = c.x - Math.sin(c.h) * (c.spec.W / 2 + 0.6);
      m.y = c.y + Math.cos(c.h) * (c.spec.W / 2 + 0.6);
      g.enterCar(c);
      if (g.car() !== c) throw new Error('Could not get into the car');
      await frame();
      return c;
    },

    // Assign a loaded PID line to a test bus; never invent a route identifier.
    busLines() { return g.traffic.busLines.map(({ ref, to }) => ({ ref, to })); },
    busLine(c: Car, ref: string) {
      if (c.type !== 'bus' && c.type !== 'minibus') throw new Error('Not a bus');
      const line = g.traffic.busLines.find((l) => l.ref === ref);
      if (!line) throw new Error(`No loaded bus line ${ref}`);
      c.line = { ref: line.ref, to: line.to };
    },

    // Out of whatever you're in.
    exit() { if (g.mode() !== 'foot') g.enterOrExit(); },
    // Loaded boats and their safe bank access, in latitude/longitude like go().
    boats() {
      const at = (p: Point2): Point2 => { const [lon, lat] = g.toLonLat(...p); return [lat, lon]; };
      return g.boats.list.filter(b => b.live).map(b => {
        const bank = b.kind === 'cruise' ? null : g.boats.landing(b);
        return { kind: b.kind, moored: b.moored, at: at([b.x, b.y]), bank: bank ? at(bank) : null,
          waterHeight: g.boats.waterHeight(b), bankHeight: bank ? g.boats.water.terrainAt(...bank) : null };
      });
    },
    // PID's ferries: where each is, whether it sails now, the landing it lies at (or
    // null under way), the one it goes to next, and each landing's spot on the bank.
    ferries() {
      const at = (p: Point2): Point2 => { const [lon, lat] = g.toLonLat(...p); return [lat, lon]; };
      return g.ferries.list.map(f => ({ ref: f.line.ref, open: f.open, loaded: f.z !== null, stop: f.stop, to: f.to, at: at([f.x, f.y]),
        landings: f.line.stops.map(s => ({ name: s.name, gate: at(s.gate), berth: at(s.berth) })) }));
    },
    // E by a ferry's landing; whether you're aboard. `t.ticket()`: how the fare stands
    // ('grace' or 'dodging' without a ticket, null with one or off PID's vehicles);
    // `t.ticket(true)` buys the 90-minute one first.
    boardFerry() {
      if (g.mode() === 'foot') g.enterOrExit();
      return g.mode() === 'ferry';
    },
    ticket(buy = false) {
      if (buy && !g.pid.buy(g.clock.t)) g.wallet.buyTicket(g.clock.t); // (aboard, as B does; on foot, straight from the wallet)
      return { held: g.wallet.hasTicket(g.clock.t), fare: g.pid.state };
    },
    // The first cruise boat, put on the fairway `back` metres before the end of the
    // stretch nearest you and heading for it; then where it is and which way it goes.
    cruiseToEnd(back = 200) {
      const B = g.boats, b = B.list.find(o => o.kind === 'cruise'), me = g.me();
      if (!b || !B.courses.length) return false;
      let best: { c: typeof B.courses[number]; end: number; d: number } | null = null;
      for (const c of B.courses) for (const end of [0, c.length]) {
        const p = c.at(end), d = Math.hypot(p.x - me.x, p.y - me.y);
        if (!best || d < best.d) best = { c, end, d };
      }
      const { c, end } = best!, dir = end ? 1 : -1, along = end ? end - back : back, p = c.at(along);
      for (const o of B.list) if (o !== b && o.kind === 'cruise' && Math.hypot(o.x - p.x, o.y - p.y) < 300) { o.live = false; o.mesh.visible = false; } // (not on top of another)
      Object.assign(b, { x: p.x, y: p.y, h: dir > 0 ? p.ang : p.ang + Math.PI, v: b.s.speed, w: 0, course: c, along, dir, about: 0, live: true, z: null });
      b.mesh.visible = true;
      return true;
    },
    // The first cruise boat onto the fairway at the point nearest `where`, going up the
    // line (`dir` 1) or down it (-1).
    cruiseAt(where: Where, dir: 1 | -1 = 1) {
      const B = g.boats, b = B.list.find(o => o.kind === 'cruise'), [x, y] = kit.toLocal(where);
      const near = B.courses.map(c => ({ c, ...c.project(x, y) })).sort((p, q) => p.d - q.d)[0];
      if (!b || !near) return false;
      const p = near.c.at(near.s);
      for (const o of B.list) if (o !== b && o.kind === 'cruise' && Math.hypot(o.x - p.x, o.y - p.y) < 300) { o.live = false; o.mesh.visible = false; } // (not on top of another)
      Object.assign(b, { x: p.x, y: p.y, h: dir > 0 ? p.ang : p.ang + Math.PI, v: b.s.speed, w: 0, course: near.c, along: near.s, dir, about: 0, live: true, z: null });
      b.mesh.visible = true;
      return true;
    },
    cruise() {
      const b = g.boats.list.find(o => o.kind === 'cruise' && o.course);
      if (!b || !b.course) return null;
      const [lon, lat] = g.toLonLat(b.x, b.y);
      return { live: b.live, at: [lat, lon] as Point2, dir: b.dir, turning: b.about > 0, speed: b.v, toEnd: b.dir > 0 ? b.course.length - b.along : b.along, along: b.along, toBank: b.course.at(b.along).w,
        onWater: g.boats.water.waterAt(b.x, b.y) === true, height: b.z };
    },
    boardBoat() {
      if (g.mode() === 'foot') g.enterOrExit();
      return g.mode() === 'boat';
    },

    // Whether the game makes countryside past the map's edge (it was opened with ?countryside).
    countryside() { return g.countryside(); },

    // The shortest way by car from the street nearest one place to the street nearest
    // another, through the streets loaded now (those within some 700 m of you): its
    // length in metres and its line as [lat, lon] points, or null where the streets
    // don't join up.
    route(from: Where, to: Where): { length: number; line: Point2[] } | null {
      const nearest = (w: Where) => {
        const [x, y] = kit.toLocal(w);
        let best: DriveEdge | null = null, at = Infinity;
        for (const e of g.streets.edges) {
          for (let i = 0; i < e.pts.length - 1; i++) {
            const d = segDist(x, y, e.pts[i], e.pts[i + 1]);
            if (d < at) { at = d; best = e; }
          }
        }
        return best;
      };
      const first = nearest(from), last = nearest(to);
      if (!first || !last) return null;
      // Dijkstra over the edges, from the first street (either way along it) to the last.
      const starts = [first, ...(first.twin ? [first.twin] : [])], goals = new Set([last, ...(last.twin ? [last.twin] : [])]);
      const cost = new Map<DriveEdge, number>(starts.map((e) => [e, 0])), came = new Map<DriveEdge, DriveEdge>(), open = [...starts], done = new Set<DriveEdge>();
      let b: DriveEdge | null = null;
      while (open.length) {
        open.sort((p, q) => cost.get(q)! - cost.get(p)!);
        const e = open.pop()!;
        if (goals.has(e)) { b = e; break; }
        if (done.has(e)) continue;
        done.add(e);
        for (const f of g.streets.out.get(e.v) || []) {
          const c = cost.get(e)! + f.path.length;
          if (c < (cost.get(f) ?? Infinity)) { cost.set(f, c); came.set(f, e); open.push(f); }
        }
      }
      if (!b) return null;
      const edges = [b];
      while (came.has(edges[0])) edges.unshift(came.get(edges[0])!);
      const line: Point2[] = [];
      for (const e of edges) for (const [x, y] of e.pts) { const [lon, lat] = g.toLonLat(x, y); line.push([lat, lon]); }
      return { length: round(edges.reduce((sum, e) => sum + e.path.length, 0)), line };
    },

    // Drives your car along a line of [lat, lon] points at about this speed, steering as
    // the touch stick does. Says whether it got to the end, how long it took, the biggest
    // change in the ground's height under the car from one sixth of a second to the next
    // (`jump`, metres) and how far it strayed from the line (`strayed`, metres).
    async follow(line: Point2[], kmh = 40) {
      const c = g.car();
      if (!c) throw new Error('Not in a car');
      const pts = line.map((p) => kit.toLocal(p));
      let length = 0;
      for (let i = 1; i < pts.length; i++) length += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      const was = kit.paused;
      kit.paused = true;
      let next = 1, jump = 0, strayed = 0, seconds = 0, last = g.ground(c.x, c.y);
      try {
        for (const limit = (length / (kmh / 3.6)) * 3 + 20; next < pts.length && seconds < limit; seconds += 1 / 6) {
          // The point to steer for: the first one still more than a few car lengths ahead.
          while (next < pts.length - 1 && Math.hypot(pts[next][0] - c.x, pts[next][1] - c.y) < 9) next++;
          if (next === pts.length - 1 && Math.hypot(pts[next][0] - c.x, pts[next][1] - c.y) < 6) { next++; break; }
          const h = Math.atan2(pts[next][1] - c.y, pts[next][0] - c.x), fast = Math.hypot(c.vx, c.vy) > kmh / 3.6;
          for (let i = 0; i < 10; i++) g.simulate(1 / 60, { move: fast ? 0 : 1, aim: { h, mag: 1 } });
          const now = g.ground(c.x, c.y);
          jump = Math.max(jump, Math.abs(now - last));
          last = now;
          let off = Infinity;
          for (let i = Math.max(0, next - 3); i < Math.min(pts.length - 1, next + 1); i++) off = Math.min(off, segDist(c.x, c.y, pts[i], pts[i + 1]));
          strayed = Math.max(strayed, off);
          // The tiles ahead: headless, the drive runs faster than they would stream in.
          if (Math.round(seconds * 6) % 12 === 0) await g.loaded(c.x, c.y);
          if (kit.watch || Math.round(seconds * 6) % 3 === 0) await frame();
        }
      } finally {
        kit.paused = was;
      }
      return { arrived: next >= pts.length, seconds: round(seconds), jump: round(jump, 2), strayed: round(strayed) };
    },

    // Your car (or c) going at this speed along the heading.
    push(kmh: number, heading?: number, c = g.car()) {
      if (!c) throw new Error('Not in a car');
      if (heading !== undefined) c.h = rad(heading);
      c.vx = Math.cos(c.h) * kmh / 3.6;
      c.vy = Math.sin(c.h) * kmh / 3.6;
      c.w = 0;
    },

    // The nearest standing post (lamp, pole) within r m, and how to reach it.
    post(r = 60): Post | null {
      const m = g.me();
      let best: Post | null = null, bestD = Infinity;
      for (const p of posts.near(m.x, m.y, r)) {
        const d = Math.hypot(p.x - m.x, p.y - m.y);
        if (d < bestD) { bestD = d; best = p; }
      }
      return best;
    },

    // Put your car `back` m from a post on a clear run up to it, facing it. Tries the
    // directions round it until one is clear. Returns the post.
    aimAt(p: Post, back = 15) {
      const c = g.car();
      if (!c) throw new Error('Not in a car');
      const clear = (x: number, y: number) => g.grid.at(x, y) === 0;
      // Use the same circle bodies/radius as gameplay collisions. A tram can be
      // standing across this run even when walls and parked cars are clear.
      const trams = g.tramsNear(p.x, p.y, back + c.spec.L + 30);
      for (let a = 0; a < 24; a++) {
        const h = (a * Math.PI) / 12, sx = p.x - Math.cos(h) * back, sy = p.y - Math.sin(h) * back;
        let ok = true;
        const others = g.carsNear(p.x, p.y, back + 10).filter((o) => o !== c);
        for (let s = 0; s <= back - p.r - c.spec.L / 2 && ok; s += 0.5) {
          const x = sx + Math.cos(h) * s, y = sy + Math.sin(h) * s;
          for (const off of [-c.spec.W / 2, 0, c.spec.W / 2]) ok &&= clear(x - Math.sin(h) * off, y + Math.cos(h) * off);
          ok &&= others.every((o) => o.gap(x, y) > c.spec.L / 2 + 0.5);
          ok &&= c.offsets.every((off) => {
            const cx = x + Math.cos(h) * off, cy = y + Math.sin(h) * off;
            return trams.every((body) => body.circles.every(([tx, ty]) => Math.hypot(cx - tx, cy - ty) >= c.r + 1.25 + 0.2));
          });
        }
        if (!ok) continue;
        Object.assign(c, { x: sx, y: sy, h, vx: 0, vy: 0, w: 0 });
        return p;
      }
      throw new Error('No clear run up to that post');
    },

    // The nearest top edge of a step in the ground (a quay wall, a retaining wall) within
    // r m that drops `drop` m or more, with a clear, level run of `back` m up to it:
    // where it is, how far the ground drops, the compass heading over the edge, and
    // `from`: the place `back` m before it. `water`: only above water, or only above land.
    stepEdge(opt: { r?: number; drop?: number; back?: number; water?: boolean } = {}) {
      const m = g.me(), back = opt.back ?? 14;
      let best: StepEdge | null = null, bestD = Infinity;
      for (const e of g.steps(m.x, m.y, opt.r ?? 150).edges) {
        if (e.drop < (opt.drop ?? 2) || (opt.water !== undefined && opt.water !== e.wet)) continue;
        const x = (e.a[0] + e.b[0]) / 2, y = (e.a[1] + e.b[1]) / 2, d = Math.hypot(x - m.x, y - m.y);
        if (d >= bestD) continue;
        const top = g.ground(x + e.nx * 1.5, y + e.ny * 1.5);
        let ok = true;
        for (let s = 1.5; s <= back + 3 && ok; s += 0.5) {
          for (const off of [-1.2, 0, 1.2]) {
            const px = x + e.nx * s - e.ny * off, py = y + e.ny * s + e.nx * off;
            ok &&= g.grid.at(px, py) === 0 && Math.abs(g.ground(px, py) - top) < 1;
          }
        }
        // Above land, open ground at the wall's foot too: nothing but the edge stops you.
        for (let s = 1.5; s <= 5 && ok && !e.wet; s += 0.5) ok &&= g.grid.at(x - e.nx * s, y - e.ny * s) === 0;
        if (ok) { best = e; bestD = d; }
      }
      if (!best) return null;
      const x = (best.a[0] + best.b[0]) / 2, y = (best.a[1] + best.b[1]) / 2;
      const ll = (px: number, py: number): Point2 => { const [lon, lat] = g.toLonLat(px, py); return [lat, lon]; };
      return { at: ll(x, y), from: ll(x + best.nx * back, y + best.ny * back), drop: round(best.drop), heading: Math.round(deg(Math.atan2(-best.ny, -best.nx))), x, y, nx: best.nx, ny: best.ny };
    },
    // The nearest place within r m where a way of this kind (`hw`: 'drive' for the car
    // streets, or a path's kind: 'steps', 'footway'…) crosses a step in the ground that
    // drops `drop` m or more, so the step's edge is open there: `from` and `to` are
    // `back` m before and after it along the way, going down.
    stepCrossing(opt: { hw?: string; r?: number; drop?: number; back?: number } = {}) {
      const m = g.me(), back = opt.back ?? 8;
      let best = null, bestD = Infinity;
      for (const c of g.steps(m.x, m.y, opt.r ?? 150).crossings) {
        const d = Math.hypot(c.x - m.x, c.y - m.y);
        if (c.drop >= (opt.drop ?? 1) && (!opt.hw || c.hw === opt.hw) && d < bestD) { best = c; bestD = d; }
      }
      if (!best) return null;
      const ll = (px: number, py: number): Point2 => { const [lon, lat] = g.toLonLat(px, py); return [lat, lon]; };
      // Downhill: towards the lower end.
      const s = g.ground(best.x + best.dx * 3, best.y + best.dy * 3) <= g.ground(best.x - best.dx * 3, best.y - best.dy * 3) ? 1 : -1;
      const dx = best.dx * s, dy = best.dy * s;
      return { at: ll(best.x, best.y), from: ll(best.x - dx * back, best.y - dy * back), to: ll(best.x + dx * back, best.y + dy * back),
        heading: Math.round(deg(Math.atan2(dy, dx))), drop: round(best.drop), hw: best.hw, x: best.x, y: best.y, nx: -dx, ny: -dy };
    },
    // How far past a step's edge (stepEdge) you are: negative on the higher ground.
    pastEdge(e: { x: number; y: number; nx: number; ny: number }) {
      const m = g.me();
      return round(-((m.x - e.x) * e.nx + (m.y - e.y) * e.ny), 2);
    },
    // The ground's height under you.
    groundHere() { const m = g.me(); return round(g.ground(m.x, m.y), 2); },

    // How far you could go this way (compass degrees) before hitting a wall, up to max m.
    // `side`: measured along a line this far to the left of you instead.
    runway(heading: number, max = 80, side = 0) {
      const m = g.me(), h = rad(heading), x0 = m.x - Math.sin(h) * side, y0 = m.y + Math.cos(h) * side;
      for (let d = 0; d < max; d += 0.5) if (g.grid.at(x0 + Math.cos(h) * d, y0 + Math.sin(h) * d) !== 0) return d;
      return max;
    },
    // The heading with a wall 15–40 m ahead, nothing in between, and the wall square to
    // it (as far away one metre to either side), so a car driven at it hits nose first.
    // -1 if there is none.
    wallAhead() {
      for (let a = 0; a < 360; a += 5) {
        const d = kit.runway(a);
        if (d > 15 && d < 40 && [1, -1].every((s) => Math.abs(kit.runway(a, 80, s) - d) < 0.6)) return a;
      }
      return -1;
    },

    // Run the world for this long with these controls (the live loop waits meanwhile).
    async wait(seconds: number, ctl: Partial<Controls> = {}) {
      const was = kit.paused;
      kit.paused = true;
      const n = Math.round(seconds * 60);
      try {
        for (let i = 0; i < n; i++) {
          g.simulate(1 / 60, ctl);
          if (kit.watch || i % 60 === 59) await frame();
        }
      } finally {
        kit.paused = was;
      }
      await frame();
    },
    // One step, for the panel's step button.
    step() { g.simulate(1 / 60); },

    view(zoom: number) { g.view(zoom); },

    // Look from somewhere without moving: t.camera({ at: 'staromak', height: 60, tilt: 40,
    // heading: 90 }); any field left out stays as it is. t.camera(null): back to you.
    async camera(opt: { at?: Where; height?: number; tilt?: number; heading?: number } | null) {
      if (!opt) { kit.cam = null; return; }
      const v = g.view0();
      const cam = kit.cam ?? { x: v.x, y: v.y, height: v.height, tilt: 0, heading: 0 };
      if (opt.at) [cam.x, cam.y] = kit.toLocal(opt.at);
      Object.assign(cam, { height: opt.height ?? cam.height, tilt: Math.max(0, Math.min(75, opt.tilt ?? cam.tilt)), heading: opt.heading ?? cam.heading });
      kit.cam = cam;
      if (opt.at) await g.loaded(cam.x, cam.y);
      await frame();
    },
    // A screenshot (headless only: scripts/scene.mjs saves it; in the panel it's skipped).
    async shot(name: string) {
      await frame();
      await frame();
      const save = (window as { __shot?: (n: string) => Promise<void> }).__shot;
      if (!save) return;
      // Without the car's name and the district's across the middle.
      const hide = ['banner', 'district'].map((id) => document.getElementById(id)).filter((el) => el !== null);
      for (const el of hide) el.style.visibility = 'hidden';
      try { await save(name); } finally { for (const el of hide) el.style.visibility = ''; }
    },

    // Footage: `seconds` of the world at `fps` frames a second, each saved as a screenshot
    // (name-0001.png …). The world runs in 1/60 s steps with `ctl` held, however long a
    // frame takes to save, so the film is smooth. Without `hud`, only the game's picture.
    // `each(i, n)` runs before every frame: move the free camera (set `t.cam`), set the
    // car's speed, note down numbers to go with the footage.
    async film(name: string, seconds: number, ctl: Partial<Controls> = {}, { fps = 30, hud = false, each }: { fps?: number; hud?: boolean; each?: (i: number, n: number) => void | Promise<void> } = {}) {
      const save = (window as { __shot?: (n: string) => Promise<void> }).__shot;
      if (!save) return;
      const canvas = g.canvas;
      const hide = hud ? [] : [...document.body.children].filter((el): el is HTMLElement => el instanceof HTMLElement && el !== canvas && !el.contains(canvas));
      const was = kit.paused, shown = hide.map((el) => el.style.visibility);
      kit.paused = true;
      for (const el of hide) el.style.visibility = 'hidden';
      try {
        for (let i = 0, n = Math.round(seconds * fps); i < n; i++) {
          if (each) await each(i, n);
          for (let k = 0; k < Math.round(60 / fps); k++) g.simulate(1 / 60, ctl);
          await frame();
          await frame();
          await save(`${name}-${String(i + 1).padStart(4, '0')}`);
        }
      } finally {
        kit.paused = was;
        hide.forEach((el, i) => { el.style.visibility = shown[i]; });
      }
    },

    // What's going on, as numbers.
    probe() {
      const c = g.car();
      return {
        ...kit.where(),
        speed: c ? round(c.speed * 3.6) : round(Math.hypot(g.me().vx, g.me().vy) * 3.6),
        car: c ? { type: c.type, damage: round(c.damage), burning: !!c.burnt, broken: c.broken, braking: c.braking, ram: !!c.ram } : null,
        money: g.wallet.balance, stars: g.police.stars, police: g.police.cars.length, health: Math.round(g.health.value),
        traffic: g.traffic.agents.length, people: g.crowd.people.length,
        ticket: g.wallet.hasTicket(g.clock.t),
        time: `${String(Math.floor((g.clock.t % 86400) / 3600)).padStart(2, '0')}:${String(Math.floor((g.clock.t % 3600) / 60)).padStart(2, '0')}`,
        weather: g.weather.kind(), date: g.season.date(),
      };
    },

    check(name: string, pass: boolean, detail?: unknown) {
      kit.checks.push({ name, pass: !!pass, detail: detail === undefined ? undefined : typeof detail === 'string' ? detail : JSON.stringify(detail) });
      return !!pass;
    },

    // Where you are now as the start of a scenario: paste it into a conversation to
    // show the spot and the situation.
    snapshot() {
      const p = kit.probe(), c = g.car(), cam = kit.cam;
      const [clon, clat] = cam ? g.toLonLat(cam.x, cam.y) : [0, 0];
      return [
        `// ${p.street ?? 'here'} · https://www.google.com/maps/search/?api=1&query=${p.lat},${p.lon}`,
        `await t.go([${p.lat}, ${p.lon}], { heading: ${p.heading} });`,
        `t.time('${p.time}');`,
        `t.weather('${p.weather}');`,
        `t.season('${p.date}');`,
        `t.set({ money: ${p.money}, stars: ${p.stars}, health: ${p.health} });`,
        ...(c ? [`await t.drive('${c.type}');`, `t.push(${Math.round(c.speed * 3.6)}, ${Math.round(deg(c.h))});`] : []),
        ...(p.mode !== 'foot' && !c ? [`// (you were ${p.mode})`] : []),
        ...(cam ? [`await t.camera({ at: [${round(clat, 5)}, ${round(clon, 5)}], height: ${Math.round(cam.height)}, tilt: ${Math.round(cam.tilt)}, heading: ${Math.round(cam.heading)} });`] : []),
      ].join('\n');
    },

    scenarios: names,
    async run(name: string): Promise<Result> {
      const load = scenarios[`../scenarios/${name}.ts`];
      if (!load) throw new Error(`No scenario called ${name}; there are ${names.join(', ')}`);
      const s = (await load()).default;
      kit.checks = [];
      const t0 = performance.now();
      let error: string | undefined;
      // Each scenario starts unwanted, with no police about and no arrest under way, and
      // can't be arrested unless it asks to be: what the one before left must not reach in.
      const calm = () => { g.police.heat = 0; g.police.reset(); };
      try {
        // (Wasted in the scenario before: you come round at the hospital a few seconds
        // later, which would carry you off in the middle of this one.)
        for (let i = 0; (g.arrest.now || g.recovering()) && i < 60; i++) await kit.wait(1);
        await g.settled();
        calm();
        kit.unarrested = true;
        await kit.onFoot();
        // The cars earlier scenarios put down are taken away: several use the same
        // places, and a car left there is in the next one's way.
        for (const c of made.splice(0)) if (c !== g.car() && g.loose.includes(c)) g.loose.splice(g.loose.indexOf(c), 1);
        await s.run(kit);
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      } finally {
        calm();
        kit.unarrested = false;
        kit.quiet = false;
      }
      const checks = kit.checks;
      return { name, title: s.title, checks, error, ms: Math.round(performance.now() - t0), pass: !error && checks.length > 0 && checks.every((c) => c.pass) };
    },
  };
  // The free camera with the mouse: drag to move it, the wheel (in main.ts) to zoom,
  // right-drag or Shift-drag to turn (sideways) and tilt (up and down).
  let drag: { x: number; y: number; turn: boolean } | null = null;
  g.canvas.addEventListener('pointerdown', (e) => {
    if (!kit.cam || e.pointerType === 'touch') return;
    drag = { x: e.clientX, y: e.clientY, turn: e.button === 2 || e.shiftKey };
    try { g.canvas.setPointerCapture(e.pointerId); } catch { /* a synthetic event (tests) */ }
  });
  g.canvas.addEventListener('pointermove', (e) => {
    const cam = kit.cam;
    if (!drag || !cam) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    drag.x = e.clientX;
    drag.y = e.clientY;
    if (drag.turn) {
      cam.heading = (cam.heading + dx * 0.3 + 360) % 360;
      cam.tilt = Math.max(0, Math.min(75, cam.tilt + dy * 0.2));
      return;
    }
    // Metres per pixel on the ground at the middle of the view.
    const m = (2 * cam.height * Math.tan((g.fov * Math.PI) / 360)) / innerHeight / Math.cos((cam.tilt * Math.PI) / 180);
    const h = rad(cam.heading), fx = Math.cos(h), fy = Math.sin(h);
    // Dragging pulls the ground along with the pointer: right moves the view left.
    cam.x += (-dx * fy + dy * fx) * m;
    cam.y += (dx * fx + dy * fy) * m;
  });
  const end = () => { drag = null; };
  g.canvas.addEventListener('pointerup', end);
  g.canvas.addEventListener('pointercancel', end);
  g.canvas.addEventListener('contextmenu', (e) => { if (kit.cam) e.preventDefault(); });
  return kit;
}

export type Testkit = ReturnType<typeof setupTestkit>;
