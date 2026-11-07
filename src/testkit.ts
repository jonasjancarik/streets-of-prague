import { Car, COURIER_BOXES } from './car.ts';
import { courierLook } from './figures.ts';
import { posts } from './posts.ts';
import { fences } from './fences.ts';
import type { Post } from './posts.ts';
import type { Point2 } from './map/geo.ts';
import { segDist } from './network.ts';
import { stickOnly } from './touch.ts';
import type { DriveEdge, DriveGraph } from './network.ts';
import type { Wallet } from './money.ts';
import type { Police } from './police.ts';
import type { Health } from './guns.ts';
import type { Clock } from './clock.ts';
import type { Fires } from './fire.ts';
import type { Brigade } from './brigade.ts';
import type { Ambulances } from './ambulance.ts';
import type { Refuse } from './refuse.ts';
import type { Pedestrian } from './people.ts';
import type { Traffic } from './traffic.ts';
import type { TramBody } from './trams.ts';
import type { Kind } from './weather.ts';
import type { Boats } from './boats.ts';
import type { Ferries } from './ferries.ts';
import type { Bags } from './bags.ts';
import type { Missions } from './missions.ts';
import type { Satnav } from './satnav.ts';
import type { Standing } from './factions.ts';
import type { Hit } from './pistol.ts';
import { gunOn, setGun } from './pistol.ts';
import { upgrade } from './save.ts';

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
// `level`: the picture's top is the way the camera faces (the horizon stays level whatever
// the heading); without it the top is north, as on the map.
export interface FreeCam { x: number; y: number; height: number; tilt: number; heading: number; level?: boolean; targetY?: number }

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
  // Busted where you stand, by the nearest officer on foot if there is one.
  bust: () => void;
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
  grid: { at: (x: number, y: number) => number; view?: (who: Car) => { at: (x: number, y: number) => number } };
  steps: (x: number, y: number, r: number) => { edges: StepEdge[]; crossings: { x: number; y: number; dx: number; dy: number; drop: number; hw: string }[] };
  ground: (x: number, y: number) => number;
  streets: DriveGraph;
  // Whether the countryside past the map's edge is being made (?countryside).
  countryside: () => boolean;
  // Coverage by the prebuilt tiles and their exact extent, excluding countryside.
  builtMap: (x: number, y: number) => boolean;
  // The last title shown for the part of town, town or village you came into.
  place: () => string | null;
  taxi: { state: string; dest: number | null; key(code: string, onFoot: boolean): boolean; near(): boolean; enter(): boolean; cancel(): void };
  boats: Boats;
  ferries: Ferries;
  pid: { state: string | null; buy: (now: number) => boolean };
  inspector: { phase: string; where: string; owed: number; pay: () => void };
  carsNear: (x: number, y: number, r: number) => Car[];
  tramsNear: (x: number, y: number, r: number) => TramBody[];
  // Stands you by the door of a tram waiting at a stop near you, if there is one.
  tramStop: () => boolean;
  // Where the camera looks now, and how high it is (for starting the free camera there).
  view0: () => { x: number; y: number; height: number };
  viewRadius: () => number;
  offscreen: (x: number, y: number) => boolean;
  canvas: HTMLElement; fov: number;
  wallet: Wallet; police: Police; health: Health; clock: Clock; fires: Fires; brigade: Brigade; ambulances: Ambulances; refuse: Refuse; traffic: Traffic; crowd: { people: { state: string; x: number; y: number }[] }; hurtNearest: (grave?: boolean) => Pedestrian | null;
  weather: { set: (k: Kind | 'auto') => void; kind: () => string };
  season: { set: (when: string | number) => void; date: () => string };
  rng: () => number;
  bags: Bags;
  missions: Missions;
  satnav: Satnav;
  // Holds the fire engine's water cannon on (F).
  cannon: (on: boolean) => void;
  // A shot from your pistol, along `h` (the game's radians) or at the car ahead; null when you can't shoot now.
  shoot: (h?: number) => Hit | null;
  standing: Standing;
  // Trams: the ride you're on (ride.ts) and every tram running.
  tram: {
    ride: { on: boolean; driving: boolean; v: { speed: number } | null; atName: string | null; next: { stop: { name: string }; dist: number } | null; passengers: { doors: boolean; on: number; off: number } | null; board: (v: never) => void; steal: () => boolean; doors: () => void };
    list: () => { parts: { x: number; y: number }[]; look?: unknown; line: { ref: string } }[];
  };
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
  // And the posts it aimed a car at, stood up again before the next one: knocked over, a
  // post stays down for the rest of the game, and a later scenario at the same place found
  // none left with a clear run up to it.
  const aimed: Post[] = [];
  const kit = {
    PLACES,
    // The live game's clock: paused, or running at this speed (0.25 = slow motion).
    paused: false,
    speed: 1,
    // While filming: how far the next frame drawn moves on what follows the clock of
    // real frames (the camera after you, smoothing), so it keeps pace with the game,
    // stepped a fixed 1/fps a frame. The draws after it move nothing.
    frameDt: undefined as number | undefined,
    // Nothing hurts you (for looking round a chase).
    unhurt: false,
    // The dice for a ticket inspection on a ferry: 0 always checks you, 1 never (null: chance).
    roll: null as number | null,
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
    // Set: the camera looks out of your eyes (or your car's windscreen) instead of down
    // from above; yaw and pitch (degrees) turn the view from the way you face.
    eyes: null as { yaw: number; pitch: number } | null,

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
      // Put somewhere else, however near: what you stood on says nothing about what you
      // stand on now. (The game keeps you on a bridge's deck over a move of a few metres,
      // as walking does: from the deck over a quay, t.go to the quay left you on the deck.)
      if (g.mode() === 'foot') (g.me() as { level?: number }).level = undefined;
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

    // On foot, `m` metres ahead of a car (in its way).
    standAhead(c: Car, m: number) {
      const me = g.me();
      me.x = c.x + Math.cos(c.h) * m;
      me.y = c.y + Math.sin(c.h) * m;
    },

    // The horns drivers sound at you from now on (true for a long one), as the game plays them.
    watchHonks() {
      const log: boolean[] = [], prev = g.traffic.onHonk;
      g.traffic.onHonk = (c, long) => { log.push(long); prev?.(c, long); };
      return log;
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
      kit.cam = kit.eyes = null;
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
      return g.crowd.people.filter((p) => Math.hypot(p.x - x, p.y - y) < r).map((p) => ({ state: p.state, away: round(Math.hypot(p.x - x, p.y - y)), x: round(p.x), y: round(p.y) }));
    },
    // Stands the nearest pedestrian `m` metres in front of the car and returns them.
    pedestrianAhead(m: number, c = g.car()!) {
      const p = g.crowd.people.filter((q) => q.state === 'walk').sort((a, b) => Math.hypot(a.x - c.x, a.y - c.y) - Math.hypot(b.x - c.x, b.y - c.y))[0];
      if (!p) return null;
      p.x = c.x + Math.cos(c.h) * m;
      p.y = c.y + Math.sin(c.h) * m;
      return p;
    },
    downNear(x: number, y: number, r: number) { return g.crowd.people.filter((p) => p.state === 'down' && Math.hypot(p.x - x, p.y - y) < r).length; },
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
    // Makes the ground a wall (as a building's would be) for `len` m along the car and `depth` m out,
    // beside door n, from `gap` m out of the car's side. Returns a function that takes it away again.
    wallBeside(c: Car, n = 1, { gap = 0.2, depth = 3, len = 5 } = {}) {
      const door = c.doors.find((d) => d.n === n);
      if (!door) throw new Error(`No door ${n} on a ${c.type}`);
      const grid = g.grid, at = grid.at, view = grid.view, along = (door.front + door.back) / 2;
      const walled = (x: number, y: number) => {
        const dx = x - c.x, dy = y - c.y, f = dx * Math.cos(c.h) + dy * Math.sin(c.h), l = (dy * Math.cos(c.h) - dx * Math.sin(c.h)) * door.side;
        return Math.abs(f - along) < len / 2 && l > c.spec.W / 2 + gap && l < c.spec.W / 2 + gap + depth;
      };
      grid.at = (x: number, y: number) => (walled(x, y) ? 1 : at.call(grid, x, y));
      // (What walks and drives on a bridge deck or under it is given its own view of the ground.)
      if (view) grid.view = (who: Car) => { const v = view.call(grid, who); return { ...v, at: (x: number, y: number) => (walled(x, y) ? 1 : v.at(x, y)) }; };
      return () => { grid.at = at; grid.view = view; };
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
    // Busted here and now, as an officer catching you would have it (even in a scenario,
    // which can't be arrested otherwise).
    bust() {
      const was = kit.unarrested;
      kit.unarrested = false;
      try { g.bust(); } finally { kit.unarrested = was; }
    },
    // Until the last move to a cell or a hospital has finished loading.
    settled() { return g.settled(); },

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

    // A dustcart on its round from a street within `r` m of you (in view too), or null.
    dustcart(r = 80) { const m = g.me(); return g.refuse.send(m.x, m.y, r)?.car ?? null; },
    // How the dustcarts' rounds stand: each cart's phase and speed, and what its crew are doing.
    rounds() {
      return g.refuse.rounds.map((k) => ({ phase: k.phase, speed: round(k.agent.speed), crew: k.crew.map((m) => m.job), bins: g.refuse.bins.length, car: k.car }));
    },

    // Sets a car on fire (a parked one burns for a minute or so before it blows up, the one
    // you're driving for a few seconds).
    // Crumples a car where a blow `along` and `left` of its middle (metres) would land, by
    // `levels` (see DENT in car.ts).
    dent(c: Car, along: number, left: number, levels = 3) { c.dent(along, left, levels); return [...c.crush]; },
    ignite(c: Car) {
      c.damage = Math.max(c.damage, 95);
      g.fires.check(c);
    },
    // The traffic car nearest to you with a driver in it, and whether it still has one.
    // The nearest car in traffic. `roomy`: one with open ground at its driver's door, no
    // other car within reach of it and no tram near enough to board, so E there means
    // that door; and not a police car, whose officer gets out and comes after you
    // instead of being pulled out.
    trafficCar(roomy = false) {
      const m = g.me();
      const room = (c: Car) => {
        const door = c.doors.find((d) => d.n === 1);
        if (!door) return false;
        const [x, y] = c.beside(door, 1);
        return c.type !== 'police' && g.grid.at(x, y) === 0 && g.carsNear(x, y, 8).every((o) => o === c || o.gap(x, y) > 2) && !g.tramsNear(x, y, 25).length;
      };
      return g.traffic.agents.map((k) => k.car).filter((c) => !c.two && (!roomy || room(c))).sort((a, b) => Math.hypot(a.x - m.x, a.y - m.y) - Math.hypot(b.x - m.x, b.y - m.y))[0] ?? null;
    },
    driven(c: Car) { return g.traffic.agents.some((k) => k.car === c); },
    // Everything driving in traffic, with its route (and `kerb` while up on the pavement).
    trafficAgents() { return g.traffic.agents; },
    fleeing(c: Car) { return g.crowd.people.filter((p) => p.state === 'flee' && Math.hypot(p.x - c.x, p.y - c.y) < 16).length; },
    // How a car's fire and the brigade's call to it stand.
    fire(c: Car) {
      const b = g.fires.blazes.get(c), e = g.brigade.engines.find((k) => k.target === c);
      return {
        burning: !c.burnt && !!b && b.fuse >= 0, wreck: !!c.burnt, flames: g.fires.onFire(c),
        engine: e ? e.phase : null, spraying: g.brigade.crew.filter((k) => k.engine.target === c && k.spraying).length, cannon: !!e && !!e.spraying,
        away: e ? round(Math.hypot(e.car.x - c.x, e.car.y - c.y)) : null,
      };
    },

    // ---- Work (missions.ts) ----
    // What's on: 'idle', 'offer' or 'on', the job's id, its step and objective, the seconds
    // left, the pay, where it wants you (lat, lon), the last outcome, and the books.
    job() {
      const p = g.missions.probe();
      const at = p.at ? g.toLonLat(p.at.x, p.at.y) : null;
      return { ...p, out: p.away, at: at ? [round(at[1], 5), round(at[0], 5)] as Point2 : null, away: p.at ? Math.round(Math.hypot(p.at.x - g.me().x, p.at.y - g.me().y)) : null, rep: { ...g.standing.rep } };
    },
    // ---- Directions (satnav.ts) ----
    // The way shown: where to, whether it gets there or only as far as the streets have
    // loaded, its length and how far along it you are (m), its streets and its turns, and
    // which way your indicators flash (blinkers.ts).
    nav() { return { ...g.satnav.probe(), signal: g.satnav.signal(g.car()?.speed ?? 0) }; },
    // Directions to (lat, lon), as if picked on the map; with nothing, they stop.
    navTo(lat?: number, lon?: number) {
      if (lat === undefined || lon === undefined) { g.satnav.pick(null); return kit.nav(); }
      const [x, y] = g.toLocal(lon, lat);
      g.satnav.pick({ x, y, name: `${lat}, ${lon}` });
      return kit.nav();
    },
    // The jobs there are, and what each needs you to be driving.
    jobs() { return g.missions.defs.map((d) => ({ id: d.id, needs: d.needs ?? null })); },
    // Starts a job straight away, without the first-time talk. Throws when it can't be done from here.
    startJob(id: string) {
      const def = g.missions.defs.find((d) => d.id === id);
      if (!def) throw new Error(`No job called ${id}; there are ${g.missions.defs.map((d) => d.id).join(', ')}`);
      if (!g.missions.start(def, undefined, false)) throw new Error(`The ${id} job can't be done from here`);
      return kit.job();
    },
    // The phone: J (ask for work, take the offer, give up: twice), or an offer of one job.
    pressJ() { g.missions.key('KeyJ'); return kit.job(); },
    offerJob(id: string) { const def = g.missions.defs.find((d) => d.id === id); return !!def && g.missions.propose(def); },
    // Offers nobody asked for (off in test runs unless turned on).
    autoJobs(on: boolean) { g.missions.auto = on; },
    // The seconds left for the step under way (to test running out of time).
    jobTime(seconds: number) { if (g.missions.run) g.missions.run.left = seconds; },
    // Starts the books again: nothing done, nobody knows you.
    clearJobs() { g.missions.stop(); g.missions.note = null; g.missions.progress = { done: {}, failed: 0, earned: 0 }; g.standing.rep = {}; },
    // Puts you (and what you drive) where the job wants you, `back` m short of it.
    async toJob(back = 0) {
      const at = g.missions.target();
      if (!at) throw new Error('The job has no place to go to right now');
      const m = g.me(), d = Math.hypot(at.x - m.x, at.y - m.y) || 1;
      await g.teleport(at.x - ((at.x - m.x) / d) * back, at.y - ((at.y - m.y) / d) * back);
      await frame();
      return kit.job();
    },
    // The car a fire call has set burning (once you're near enough for it to be lit).
    jobCar() { return [...(g.missions.run?.owned ?? [])][0] ?? null; },
    // Your fire engine `back` m from a car, facing it on a clear run, as aimAt does for a post.
    aimAtCar(c: Car, back = 14) { kit.aimAt({ x: c.x, y: c.y, r: 4 } as Post, back); },
    // The water cannon of the fire engine you drive, held on or let go.
    cannon(on: boolean) { g.cannon(on); },
    // The pistol handed out (as the developer panel does) or taken away again, for this
    // page only; players have none. Whether you have it now.
    gun(on?: boolean) { if (on !== undefined) setGun(on, false); return gunOn(); },
    // A shot from your pistol (null without one, see gun): toward a compass heading, at a car (or a spot), or, with
    // nothing, the way you face with the aim helping, as F does. Where it went and what it hit.
    shoot(at?: number | { x: number; y: number }) {
      const me = g.me();
      const h = at === undefined ? undefined : typeof at === 'number' ? rad(at) : Math.atan2(at.y - me.y, at.x - me.x);
      const hit = g.shoot(h);
      return hit && { x: round(hit.x), y: round(hit.y), d: round(hit.d), car: hit.car, tram: hit.tram };
    },
    // What a saved game of an older format becomes (null: can't be opened).
    upgradeSave(old: unknown) { return upgrade(old); },
    // Onto the nearest tram and into its cab, as F does once you ride one.
    takeTram() {
      const m = g.me(), ride = g.tram.ride;
      const v = g.tram.list().slice().sort((a, b) => Math.hypot(a.parts[1].x - m.x, a.parts[1].y - m.y) - Math.hypot(b.parts[1].x - m.x, b.parts[1].y - m.y))[0];
      if (!v) throw new Error('No tram running near here');
      if (g.mode() !== 'foot') g.enterOrExit();
      ride.board(v as never);
      if (!ride.steal()) throw new Error('Could not take the tram over');
    },
    // The tram you drive: its speed (km/h), the stop its front is at, the next one ahead and whether the doors are open.
    tram() {
      const r = g.tram.ride;
      return r.driving && r.v ? { speed: round(r.v.speed * 3.6), at: r.atName, next: r.next ? { name: r.next.stop.name, dist: Math.round(r.next.dist) } : null, doors: !!r.passengers?.doors, on: r.passengers?.on ?? 0, off: r.passengers?.off ?? 0 } : null;
    },
    tramDoors() { g.tram.ride.doors(); },
    // How many trams each line has out, across the city.
    tramsOut() {
      const out: Record<string, number> = {};
      for (const v of g.tram.list()) out[v.line.ref] = (out[v.line.ref] ?? 0) + 1;
      return out;
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
    // How a ticket inspection stands: 'off', 'decide' (pay or run), 'chase', 'leaving'.
    inspection() { return { phase: g.inspector.phase, where: g.inspector.where, owed: g.inspector.owed }; },
    payFine() { g.inspector.pay(); },
    // A moment of the live game between waits: what the game looks at once a frame
    // (inspections, the HUD) sees the state as it is now.
    async frames(n = 2) { for (let k = 0; k < n; k++) await new Promise(requestAnimationFrame); },
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

    // Orders a taxi through the first app (T, then 2), on foot. `t.taxi()`: how it stands:
    // 'off', 'coming', 'waiting' (at the kerb for you) or 'riding', whether it is close
    // enough to get into, and the place it is going to. `t.boardTaxi()` gets in, `t.cancelTaxi()` sends it away;
    // `t.taxiTo(n)` picks the n-th place of its list (1: Old Town Square … 9: Letná).
    orderTaxi() {
      if (g.taxi.state === 'off') g.taxi.key('KeyT', true);
      g.taxi.key('Digit2', true);
      return kit.taxi();
    },
    taxi() { return { state: g.taxi.state, near: g.taxi.near(), to: g.taxi.dest }; },
    // Waits (up to `seconds`) for a tram to stop near you, then gets on it as E does.
    async boardTram(seconds = 120) {
      let at = g.tramStop();
      for (let s = 0; s < seconds && !at; s += 2) { await kit.wait(2); at = g.tramStop(); }
      if (at) g.enterOrExit();
      return g.mode() === 'tram';
    },
    boardTaxi() { return g.taxi.enter(); },
    cancelTaxi() { g.taxi.cancel(); },
    taxiTo(n: number) { g.taxi.key(`Digit${n % 10}`, false); return kit.taxi(); },

    // Whether the game makes countryside past the map's edge (it was opened with ?countryside).
    countryside() { return g.countryside(); },
    builtMap() { const m = g.me(); return g.builtMap(m.x, m.y); },

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
    // `runUp`: the nearest one your car has a clear run of that many metres up to (see
    // aimAt, which this leaves the car set for, `beyond` too): a lamp between parked cars has none.
    post(r = 60, runUp = 0, beyond = 0): Post | null {
      const m = g.me();
      const near = posts.near(m.x, m.y, r).filter((p) => !p.down).sort((a, b) => Math.hypot(a.x - m.x, a.y - m.y) - Math.hypot(b.x - m.x, b.y - m.y));
      if (!runUp) return near[0] ?? null;
      for (const p of near) { try { return kit.aimAt(p, runUp, beyond); } catch { /* the next one */ } }
      return null;
    },

    // Put your car `back` m from a post on a clear run up to it, facing it. Tries the
    // directions round it until one is clear (and clear for `beyond` m past the post, for
    // a car that is to knock it over and drive on). Returns the post.
    aimAt(p: Post, back = 15, beyond = 0) {
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
        for (let s = 0; s <= (beyond ? back + beyond : back - p.r - c.spec.L / 2) && ok; s += 0.5) {
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
        aimed.push(p);
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

    // Put the car on a clear approach to a broad wall. Unlike wallAhead(), this
    // checks the whole moving body and other street objects, then starts it only
    // `back` metres from the wall so a coast reaches it near the requested speed.
    wallRun(back = 12, max = 60) {
      const c = g.car();
      if (!c) throw new Error('Not in a car');
      const before = { x: c.x, y: c.y, h: c.h, vx: c.vx, vy: c.vy, w: c.w };
      let placed = false;
      try {
        for (let heading = 0; heading < 360; heading += 5) {
          const h = rad(heading), dx = Math.cos(h), dy = Math.sin(h);
          let distance = 0;
          for (; distance < max; distance += 0.5) {
            if (g.grid.at(before.x + dx * distance, before.y + dy * distance) !== 0) break;
          }
          if (distance < back + c.spec.L / 2 || distance >= max) continue;
          const x = before.x + dx * distance, y = before.y + dy * distance;
          // Open just before a solid face across more than the car's full width;
          // a corner, narrow post or a visibly slanted approach is unsuitable.
          const across = c.spec.W / 2 + 1;
          if (![-across, -across / 2, 0, across / 2, across].every((side) =>
            g.grid.at(x - dy * side - dx * 0.7, y + dx * side - dy * 0.7) === 0
            && g.grid.at(x - dy * side + dx * 0.7, y + dx * side + dy * 0.7) !== 0)) continue;
          const sx = x - dx * back, sy = y - dy * back;
          const others = g.carsNear(x, y, back + c.spec.L + 5).filter((o) => o !== c);
          const trams = g.tramsNear(x, y, back + c.spec.L + 30);
          let clear = true;
          for (let s = 0; s <= back - c.spec.L / 2 - 0.8 && clear; s += 0.25) {
            Object.assign(c, { x: sx + dx * s, y: sy + dy * s, h });
            clear = c.worldOutline().every(([px, py]) => g.grid.at(px, py) === 0)
              && !posts.touches(c)
              && others.every((o) => o.gap(c.x, c.y) > c.spec.L / 2 + 0.5)
              && c.offsets.every((off) => {
                const px = c.x + dx * off, py = c.y + dy * off;
                return !fences.blocks(px, py, c.r + 0.2, -1)
                  && trams.every((body) => body.circles.every(([tx, ty]) => Math.hypot(px - tx, py - ty) >= c.r + 1.25 + 0.2));
              });
          }
          if (!clear) continue;
          Object.assign(c, { x: sx, y: sy, h, vx: 0, vy: 0, w: 0 });
          placed = true;
          return { heading, x, y, dx, dy, back };
        }
        return null;
      } finally {
        if (!placed) Object.assign(c, before);
      }
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
    // Drive your car this long with the stick alone (the "Stick only" setting), a thumb
    // holding it toward `heading` (compass degrees) pushed `mag` of the way.
    async thumb(seconds: number, heading: number, mag = 1) {
      const was = kit.paused;
      kit.paused = true;
      const n = Math.round(seconds * 60);
      try {
        for (let i = 0; i < n; i++) {
          const c = g.car();
          if (!c) throw new Error('Not in a car');
          g.simulate(1 / 60, stickOnly(c, { h: rad(heading), mag }));
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
    async camera(opt: { at?: Where; height?: number; tilt?: number; heading?: number; level?: boolean; targetY?: number } | null) {
      if (!opt) { kit.cam = null; return; }
      const v = g.view0();
      const cam = kit.cam ?? { x: v.x, y: v.y, height: v.height, tilt: 0, heading: 0 };
      if (opt.at) [cam.x, cam.y] = kit.toLocal(opt.at);
      Object.assign(cam, { height: opt.height ?? cam.height, tilt: Math.max(0, Math.min(75, opt.tilt ?? cam.tilt)), heading: opt.heading ?? cam.heading, level: opt.level ?? cam.level, targetY: opt.targetY ?? cam.targetY });
      kit.cam = cam;
      if (opt.at) await g.loaded(cam.x, cam.y);
      await frame();
    },
    // Orbit the point in the middle of the view without changing its apparent size.
    orbit(heading: number, tilt: number) {
      const cam = kit.cam;
      if (!cam) return;
      const next = Math.max(0, Math.min(75, tilt));
      if (next !== cam.tilt) {
        const distance = cam.height / Math.cos(cam.tilt * Math.PI / 180);
        cam.height = Math.max(5, Math.min(1500, distance * Math.cos(next * Math.PI / 180)));
        cam.tilt = next;
      }
      cam.heading = ((heading % 360) + 360) % 360;
      cam.level = true;
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
          kit.frameDt = 1 / fps;
          await frame();
          await frame();
          await save(`${name}-${String(i + 1).padStart(4, '0')}`);
        }
      } finally {
        kit.frameDt = undefined;
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
        traffic: g.traffic.agents.length, people: g.crowd.people.length, place: g.place(),
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
        for (const p of aimed.splice(0)) p.down = null;
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
  let drag: { id: number; x: number; y: number; turn: boolean } | null = null;
  g.canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch' || drag || (e.button !== 0 && e.button !== 2)) return;
    // First person: a click takes the mouse to look round with (Esc lets it go);
    // right-drag or Shift-drag looks round too.
    if (!kit.cam && kit.eyes && e.button === 0 && !e.shiftKey && document.pointerLockElement !== g.canvas) {
      void Promise.resolve(g.canvas.requestPointerLock?.()).catch(() => { /* refused (headless, or straight after Esc) */ });
      return;
    }
    if (!kit.cam && kit.eyes && !(e.button === 2 || e.shiftKey)) return;
    if (!kit.cam && !kit.eyes) return;
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, turn: e.button === 2 || e.shiftKey };
    try { g.canvas.setPointerCapture(e.pointerId); } catch { /* a synthetic event (tests) */ }
  });
  // Yaw all the way round either way, pitch up to 60° up or down.
  const look = (dx: number, dy: number) => {
    kit.eyes!.yaw = ((kit.eyes!.yaw - dx + 540) % 360) - 180;
    kit.eyes!.pitch = Math.max(-60, Math.min(60, kit.eyes!.pitch - dy));
  };
  g.canvas.addEventListener('pointermove', (e) => {
    if (document.pointerLockElement === g.canvas) {
      if (kit.eyes && !kit.cam) look(e.movementX * 0.12, e.movementY * 0.1);
      return;
    }
    const cam = kit.cam;
    if (!drag || e.pointerId !== drag.id || (!cam && !kit.eyes)) return;
    let dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    drag.x = e.clientX;
    drag.y = e.clientY;
    if (!cam && kit.eyes) {
      look(dx * 0.25, dy * 0.2);
      return;
    }
    if (!cam) return;
    if (drag.turn) {
      kit.orbit(cam.heading + dx * 0.25, cam.tilt - dy * 0.2);
      return;
    }
    const cosTilt = Math.cos(cam.tilt * Math.PI / 180);
    const metres = 2 * cam.height * Math.tan(g.fov * Math.PI / 360) / (g.canvas.clientHeight * cosTilt);
    const h = rad(cam.heading), east = Math.cos(h), north = Math.sin(h);
    if (!cam.level) {
      // Scripted north-up views can have a different screen orientation from
      // the orbit camera. Project north into the orbit camera's screen axes.
      const x = -east, y = north * cosTilt, len = Math.hypot(x, y);
      [dx, dy] = [(y * dx - x * dy) / len, (x * dx + y * dy) / len];
    }
    const across = -dx * metres, forward = dy * metres / cosTilt;
    cam.x += across * north + forward * east;
    cam.y += -across * east + forward * north;
  });
  const end = (e: PointerEvent) => { if (drag?.id === e.pointerId) drag = null; };
  g.canvas.addEventListener('pointerup', end);
  g.canvas.addEventListener('pointercancel', end);
  g.canvas.addEventListener('lostpointercapture', end);
  g.canvas.addEventListener('contextmenu', (e) => { if (kit.cam || kit.eyes) e.preventDefault(); });
  return kit;
}

export type Testkit = ReturnType<typeof setupTestkit>;
