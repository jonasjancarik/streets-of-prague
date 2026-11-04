// The launch video's shots, one function each (after lib.js; film.sh runs SHOTS[SHOT]).
// Places are the map's metres; days are a late summer's, so evenings are still light.
const SHOTS = {
  // High over the Castle on a summer morning, coming down on St. Vitus.
  async castle() {
    const c = { x: -4700, y: 3440 };
    await begin(at(c.x, c.y), { time: '09:30' });
    t.cam = above(c, 560); await settle(8000);
    return record((k, n) => {
      const u = k / (n - 1), e = 1 - (1 - u) ** 2;
      t.cam = above({ x: c.x + mix(-20, 5, u), y: c.y + mix(-40, 0, u) }, mix(560, 230, e), mix(-9, 0, e));
    });
  },

  // A red car pulls away along Ječná from the lights by Karlovo náměstí, the camera just ahead of it.
  async getin() {
    await begin([50.0755, 14.4200], { time: '13:30' });
    const line = route([50.0755, 14.4200], [50.0752, 14.4280], 1.6);
    const c = await redCar('sedan');
    // Stands a moment, then pulls away hard (m/s at frame k).
    const v = (k) => Math.min(13, Math.max(0, (k / 30 - 0.35) * 4.2));
    const sAt = [0];
    for (let k = 1; k <= FRAMES; k++) sAt.push(sAt[k - 1] + v(k) / 30);
    put(c, line, 30, 0); clear(c);
    t.cam = above(ahead(c, 5), 36, compass(c.h)); await settle();
    return record((k, n) => {
      const u = k / (n - 1);
      put(c, line, 30 + sAt[k], v(k)); clear(c, 30);
      t.cam = above(ahead(c, mix(5, 13, ease(u))), mix(36, 46, u), compass(c.h) + mix(-7, 0, u));
    }, { pedal: (k) => v(k) > 0 });
  },

  // Into the cab of a tram by the National Theatre and away, the game's own camera on it.
  async tram() {
    const spot = { x: -3725, y: 2410 };
    await begin(at(spot.x, spot.y), { time: '19:00' });
    await settle(3000);
    // The nearest tram may be a stop away along Národní: wait for one at the junction.
    const near = () => d.trams.list.some((v) => Math.hypot(v.parts[1].x - spot.x, v.parts[1].y - spot.y) < 25);
    for (let i = 0; i < 120 && !near(); i++) await t.wait(1);
    t.takeTram();
    t.view(0.55);
    await t.wait(1.5, { move: 1 }); await settle(3000);
    return record(() => {}, { ctl: { move: 1 }, pedal: () => true });
  },

  // A helicopter low over the river, across Charles Bridge in the evening sun.
  async heli() {
    const from = { x: -3895, y: 2905 }, to = { x: -3885, y: 3025 };
    // (It needs open ground to stand on: on the quay by the bridge, then over the water.)
    await begin('most', { time: '17:40' });
    if (!d.addChopper()) throw new Error('No helicopter');
    const c = d.choppers[d.choppers.length - 1];
    d.walker.x = c.x + 2; d.walker.y = c.y;
    d.enterOrExit();
    if (t.where().mode !== 'helicopter') throw new Error('Not in the helicopter');
    d.teleport(from.x, from.y);
    const h = Math.atan2(to.y - from.y, to.x - from.x), z = d.world.terrainAt(from.x, from.y) + 36;
    const place = (u) => {
      const v = Math.hypot(to.x - from.x, to.y - from.y) / (FRAMES / 30);
      Object.assign(c, { x: mix(from.x, to.x, u), y: mix(from.y, to.y, u), z, h, vx: Math.cos(h) * v, vy: Math.sin(h) * v, vz: 0 });
    };
    place(0);
    t.cam = above({ x: from.x, y: from.y + 10 }, 96); await settle(6000);
    return record((k, n) => {
      const u = k / (n - 1);
      place(u);
      t.cam = above({ x: c.x + 3, y: c.y + mix(12, 4, u) }, mix(96, 88, u), mix(-5, 5, u));
    }, { ctl: { move: 1 } });
  },

  // St. Nicholas in Malá Strana at the end of the day, turning a little.
  async mikulas() {
    const c = { x: -4480, y: 3165 };
    await begin(at(c.x, c.y), { time: '19:20' });
    t.cam = above(c, 190); await settle(7000);
    return record((k, n) => {
      const u = k / (n - 1);
      t.cam = above({ x: c.x + mix(-6, 6, u), y: c.y }, mix(190, 172, u), mix(-3, 5, u));
    });
  },

  // A river cruise below Charles Bridge, the camera going with it.
  async boat() {
    const p = { x: -3900, y: 2660 };
    await begin(at(p.x, p.y), { time: '19:30' });
    if (!t.cruiseAt(at(p.x, p.y), 1)) throw new Error('No cruise boat');
    const b = d.boats.list.find((o) => o.kind === 'cruise' && o.live && o.course);
    t.cam = above(b, 85, compass(b.h)); await settle(6000);
    return record((k, n) => {
      const u = k / (n - 1);
      t.cam = above(ahead(b, 8), mix(84, 78, u), compass(b.h) + mix(4, -4, u));
    });
  },

  // A car on fire on Újezd at dusk, and the brigade's hoses on it (where the fire-brigade
  // scenario has it: on Karlovo náměstí the engine stopped short and its crew never sprayed).
  async fire() {
    await begin('ujezd', { time: '21:10' });
    await t.go('ujezd', { heading: 180 });
    await settle(2000);
    const car = t.car('hatch', { ahead: 14 });
    t.ignite(car);
    // Until the crew have the water on it.
    let s = 0;
    for (; s < 150 && !(t.fire(car).spraying > 0 || t.fire(car).cannon); s++) await t.wait(1);
    if (!t.fire(car).burning) throw new Error(`The fire was out before filming (${s} s)`);
    await t.wait(1.5);
    t.cam = above(car, 46); await settle(3000);
    return record((k, n) => {
      const u = k / (n - 1);
      t.cam = above({ x: car.x + mix(-3, 3, u), y: car.y }, mix(46, 40, u), mix(-6, 6, u));
    });
  },

  // A wet night on Vodičkova, the car's lights on the tram rails.
  async rain() {
    await begin('vodickova', { time: '23:20', weather: 'rain' });
    const line = route('vodickova', [50.0795, 14.4222]);
    const c = await redCar('sedan');
    put(c, line, 10, 11); clear(c);
    t.cam = above(ahead(c, 8), 40, compass(c.h)); await settle(6000);
    return record((k, n) => {
      const u = k / (n - 1);
      put(c, line, 10 + k * 11 / 30, 11); clear(c, 30);
      t.cam = above(ahead(c, 9), mix(42, 38, u), compass(c.h) + mix(-8, 8, u));
    }, { pedal: () => true });
  },

  // The police after you from Národní onto the bridge: wide, close and turning, then high.
  async chase() {
    const start = at(-3470, 2480);
    await begin(start, { time: '01:30', heading: 270 });
    const line = route(start, at(-3815, 2412));
    const c = await redCar('sedan');
    // From the embankment by the National Theatre onto the bridge, as far as the island: put
    // down on the bridge over the island, the car was taken for being under it now and then,
    // and the game opened its hole in the deck round it.
    const V = 19, s0 = 328;
    put(c, line, s0, 0); clear(c, 60);
    t.cam = above(ahead(c, 14), 70); await settle(4000);
    t.set({ stars: 3 });
    // The police helicopter that joins in at three stars flies at 55 m and can cross under
    // the camera, filling the picture: kept above it instead, its searchlight still on you.
    const aloft = () => { for (const h of d.police.helis.list) h.z = d.world.terrainAt(h.x, h.y) + 150; };
    // Wait where you are until a police car is close and another is out, then run for it.
    for (let i = 0; i < 60; i++) {
      put(c, line, s0, 0); aloft();
      await t.wait(1);
      if (d.police.cars.length > 1 && d.police.cars.some((p) => Math.hypot(p.car.x - c.x, p.car.y - c.y) < 40)) break;
    }
    let cop = null, other = null;
    return record((k, n) => {
      const s = s0 + k * V / 30;
      put(c, line, s, V); clear(c, 25); aloft();
      // The nearest police car right behind, every take (left to itself it may stop to shoot).
      cop ??= d.police.cars.map((p) => p.car).sort((a, b) => Math.hypot(a.x - c.x, a.y - c.y) - Math.hypot(b.x - c.x, b.y - c.y))[0];
      if (cop) put(cop, line, s - 7.5, V);
      // And a second one starting behind it, left to itself: it pulls out and comes past
      // the first to ram you from the side.
      if (k === 0) {
        other = d.police.cars.map((p) => p.car).find((q) => q !== cop) ?? null;
        if (other) put(other, line, s - 17, V);
      }
      if (k < 55) t.cam = above(ahead(c, 16), 72);
      else if (k < 110) t.cam = above(ahead(c, 3), 34, compass(c.h) + mix(-35, 25, (k - 55) / 55));
      else t.cam = above(ahead(c, -12), mix(88, 100, (k - 110) / (n - 110)), compass(c.h));
    }, { pedal: () => true });
  },

  // The car standing on most Legií at night, the camera going straight up from it: the
  // start of the pull back (heights from plan.json; the map pictures take over at the top).
  async rise() {
    const p = PLAN.rise;
    await begin([p.lat, p.lon], { time: '01:40' });
    const line = route(at(p.x + 40, p.y + 5), at(p.x - 60, p.y - 5));
    const c = await redCar('sedan');
    let best = 0;
    for (let s = 0; s < lengthOf(line); s += 0.5) { const q = along(line, s); if (Math.hypot(q.x - p.x, q.y - p.y) < Math.hypot(along(line, best).x - p.x, along(line, best).y - p.y)) best = s; }
    put(c, line, best, 0); c.hint = 'bridge'; clear(c, 60);
    t.cam = above(c, 600); await settle(9000);
    t.cam = above(c, PLAN.height[0]); await settle(2000);
    return record((k) => {
      put(c, line, best, 0);
      t.cam = above(c, PLAN.height[Math.min(PLAN.height.length - 1, k)]);
    });
  },
};
