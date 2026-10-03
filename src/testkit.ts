import { Car } from './car.ts';
import { posts } from './posts.ts';
import type { Post } from './posts.ts';
import type { Point2 } from './map/geo.ts';
import type { Wallet } from './money.ts';
import type { Police } from './police.ts';
import type { Health } from './guns.ts';
import type { Clock } from './clock.ts';
import type { Fires } from './fire.ts';
import type { Brigade } from './brigade.ts';
import type { Ambulances } from './ambulance.ts';
import type { Pedestrian } from './people.ts';
import type { Kind } from './weather.ts';
import type { Boats } from './boats.ts';

// Test API for scenarios (scenarios/*.ts), the developer panel and scripts/scene.mjs,
// as window.__test. Positions are latitude/longitude in and out, headings are compass
// degrees (0 north, 90 east), speeds km/h: the units you'd use talking about a place.

export const PLACES: Record<string, { at: Point2; note: string }> = {
  staromak: { at: [50.0873, 14.4206], note: 'Old Town Square' },
  ujezd: { at: [50.0808, 14.4052], note: 'Újezd, where the game starts' },
  vodickova: { at: [50.0808, 14.4245], note: 'Vodičkova: a tram street' },
  karlova: { at: [50.0862, 14.4170], note: 'Karlova: a narrow old-town lane' },
  karlak: { at: [50.0760, 14.4185], note: 'Karlovo náměstí: main roads and buses' },
  mustek: { at: [50.0835, 14.4235], note: 'Můstek: metro entrances' },
  most: { at: [50.0862, 14.4125], note: 'By Charles Bridge: the river and quays' },
  petrin: { at: [50.0830, 14.3965], note: 'Petřín: trees and slopes' },
  letna: { at: [50.0930, 14.4275], note: 'Letná park' },
  malostranske: { at: [50.0883, 14.4030], note: 'Malostranské náměstí: courtyards and lanes' },
};

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
  mode: () => string;
  street: () => string | null;
  enterOrExit: () => void;
  addCar: (c: Car) => void;
  loose: Car[];
  simulate: (dt: number, ctl?: Partial<Controls>) => void;
  view: (zoom: number) => void;
  loaded: (x: number, y: number) => Promise<void>;
  grid: { at: (x: number, y: number) => number };
  boats: Boats;
  carsNear: (x: number, y: number, r: number) => Car[];
  // Where the camera looks now, and how high it is (for starting the free camera there).
  view0: () => { x: number; y: number; height: number };
  canvas: HTMLElement; fov: number;
  wallet: Wallet; police: Police; health: Health; clock: Clock; fires: Fires; brigade: Brigade; ambulances: Ambulances; traffic: { agents: { car: Car }[] }; crowd: { people: { state: string; x: number; y: number }[] }; hurtNearest: (grave?: boolean) => Pedestrian | null;
  weather: { set: (k: Kind | 'auto') => void; kind: () => string };
  season: { set: (when: string | number) => void; date: () => string };
  rng: () => number;
}

type Controls = { move: number; turn: number; run: boolean; brake: boolean; jump: boolean };

const rad = (deg: number) => ((90 - deg) * Math.PI) / 180;
const deg = (h: number) => ((((90 - (h * 180) / Math.PI) % 360) + 360) % 360);
const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
const round = (x: number, n = 1) => Math.round(x * 10 ** n) / 10 ** n;

export function setupTestkit(g: Game) {
  const scenarios = import.meta.glob<{ default: Scenario }>('../scenarios/*.ts');
  const names = Object.keys(scenarios).map((p) => p.replace(/^.*\/(.*)\.ts$/, '$1')).sort();

  const kit = {
    PLACES,
    // The live game's clock: paused, or running at this speed (0.25 = slow motion).
    paused: false,
    speed: 1,
    // Nothing hurts you (for looking round a chase).
    unhurt: false,
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
          return c;
        }
      }
      throw new Error('No clear ground for a car here');
    },

    // Whether a loose car (a wreck, a parked or left car) is still in the world.
    standing(c: Car) { return g.loose.includes(c); },

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
      g.enterOrExit();
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
    trafficCar() { const m = g.me(); return g.traffic.agents.map((k) => k.car).filter((c) => !c.two).sort((a, b) => Math.hypot(a.x - m.x, a.y - m.y) - Math.hypot(b.x - m.x, b.y - m.y))[0] ?? null; },
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
      const m = g.me();
      m.x = c.x - Math.sin(c.h) * (c.spec.W / 2 + 0.6);
      m.y = c.y + Math.cos(c.h) * (c.spec.W / 2 + 0.6);
      g.enterOrExit();
      if (g.car() !== c) throw new Error('Could not get into the car');
      await frame();
      return c;
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
    boardBoat() {
      if (g.mode() === 'foot') g.enterOrExit();
      return g.mode() === 'boat';
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
      for (let a = 0; a < 24; a++) {
        const h = (a * Math.PI) / 12, sx = p.x - Math.cos(h) * back, sy = p.y - Math.sin(h) * back;
        let ok = true;
        const others = g.carsNear(p.x, p.y, back + 10).filter((o) => o !== c);
        for (let s = 0; s <= back - p.r - c.spec.L / 2 && ok; s += 0.5) {
          const x = sx + Math.cos(h) * s, y = sy + Math.sin(h) * s;
          for (const off of [-c.spec.W / 2, 0, c.spec.W / 2]) ok &&= clear(x - Math.sin(h) * off, y + Math.cos(h) * off);
          ok &&= others.every((o) => o.gap(x, y) > c.spec.L / 2 + 0.5);
        }
        if (!ok) continue;
        Object.assign(c, { x: sx, y: sy, h, vx: 0, vy: 0, w: 0 });
        return p;
      }
      throw new Error('No clear run up to that post');
    },

    // How far you could go this way (compass degrees) before hitting a wall, up to max m.
    runway(heading: number, max = 80) {
      const m = g.me(), h = rad(heading);
      for (let d = 0; d < max; d += 0.5) if (g.grid.at(m.x + Math.cos(h) * d, m.y + Math.sin(h) * d) !== 0) return d;
      return max;
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
        car: c ? { type: c.type, damage: round(c.damage), burning: !!c.burnt } : null,
        money: g.wallet.balance, stars: g.police.stars, police: g.police.cars.length, health: Math.round(g.health.value),
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
      try {
        await s.run(kit);
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
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
