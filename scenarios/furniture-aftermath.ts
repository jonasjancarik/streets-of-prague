import type { Scenario } from '../src/testkit.ts';
import type { Car } from '../src/car.ts';
import { KIND } from '../src/map/furniture.ts';
import { onCrash } from '../src/impacts.ts';

// Plan 040, phase 3: what happens to furniture once it's loose, and on foot. A bin run into
// on foot goes over and a container walked into rolls away; a piece thrown at a parked car
// dents it and bounces off, one thrown at another knocks it on; traffic coming on one
// lying in the street waits for it or goes round it, never through it.
interface Drive {
  grid: { at(x: number, y: number): number };
  walker: { x: number; y: number; h: number };
  world: { surfaceAt(x: number, y: number, l: number): number };
}

export default {
  title: 'Furniture kicked on foot, thrown at a parked car and at another piece, and lying in the traffic’s way',
  async run(t) {
    t.time('14:00');
    t.weather('clear');
    const g = window.__drive as unknown as Drive;
    const it = (from: [number, number]) => t.pieces().find((b) => Math.hypot(b.from[0] - from[0], b.from[1] - from[1]) < 0.01);

    // On foot, `back` m from a standing piece of one of `kinds` with clear ground up to it:
    // stood there facing it. Its place, or null.
    const approach = (kinds: number[], back: number) => {
      const me = g.walker;
      const list = t.standingNear(me.x, me.y, 250).filter((s) => kinds.includes(s.kind))
        .sort((a, b) => Math.hypot(a.x - me.x, a.y - me.y) - Math.hypot(b.x - me.x, b.y - me.y));
      for (const p of list) for (let a = 0; a < 16; a++) {
        const h = (a * Math.PI) / 8, c = Math.cos(h), s = Math.sin(h);
        let clear = true;
        for (let d = 1.1; d <= back + 0.5 && clear; d += 0.25) for (const o of [-0.3, 0, 0.3]) {
          if (g.grid.at(p.x + c * d - s * o, p.y + s * d + c * o) !== 0) { clear = false; break; }
        }
        if (!clear) continue;
        me.x = p.x + c * back; me.y = p.y + s * back; me.h = h + Math.PI;
        return p;
      }
      return null;
    };

    for (const k of [
      { name: 'bin', kinds: [KIND.bin], run: true, far: 0.8 },
      { name: 'container', kinds: [KIND.plastic, KIND.paper, KIND.cartons, KIND.metal], run: false, far: 0.3 },
    ]) {
      let p = null;
      for (const place of ['vodickova', 'karlak', 'mustek', 'staromak']) {
        await t.go(place, { heading: 315 });
        await t.onFoot();
        if ((p = approach(k.kinds, 3))) break;
      }
      if (!p) { t.check(`a ${k.name} to walk up to`, true, 'none found: skipped'); continue; }
      await t.wait(0.3);
      await t.wait(1.6, { move: 1, run: k.run });
      await t.wait(1.5);
      const b = it([p.x, p.y]);
      t.check(`a ${k.name} ${k.run ? 'run' : 'walked'} into on foot came loose`, !!b, b ? '' : `${t.standingNear(p.x, p.y, 0.5).length} still standing there`);
      if (!b) continue;
      const moved = Math.hypot(b.x - p.x, b.y - p.y);
      t.check(`the ${k.name} was pushed away`, moved > k.far && moved < 8, `${moved.toFixed(1)} m`);
      await t.look({ x: b.x, y: b.y, h: g.walker.h }, { name: `furniture-aftermath-kick-${k.name}`, views: ['third', 'front-left'] });
    }

    // Loose pieces for the rest: bins set loose where they stand, near the street.
    await t.go('vodickova', { heading: 315 });
    await t.onFoot();
    const free: number[] = [];
    {
      const me = g.walker;
      for (const s of t.standingNear(me.x, me.y, 200).filter((s) => s.kind === KIND.bin || s.kind === KIND.plastic)) {
        if (free.length >= 3) break;
        const i = t.freePiece(s.x, s.y, 0.2);
        if (i >= 0) free.push(i);
      }
    }
    if (free.length < 3) { t.check('three bins to throw', false, `${free.length}`); return; }

    // Thrown sideways at a parked car at 50 km/h, as a car's blow throws one.
    {
      const car = t.car('hatch', { ahead: 10 }) as Car;
      await t.wait(0.5);
      const blows = car.blows.length, crashes = t.watchCrashes();
      let struck = 0;
      const stop = onCrash((e) => { if (e.b === car) struck = Math.max(struck, e.speed); });
      const nx = -Math.sin(car.h), ny = Math.cos(car.h); // its left
      t.placePiece(free[0], car.x + nx * 4, car.y + ny * 4, -nx * 14, -ny * 14);
      await t.wait(2.5);
      stop(); crashes.stop();
      const b = t.pieces()[free[0]];
      const side = (b.x - car.x) * nx + (b.y - car.y) * ny;
      t.check('a piece thrown at a parked car bounced off it', side > car.spec.W / 2, `${side.toFixed(2)} m from its middle`);
      t.check('the parked car was struck and dented', struck > 0 && car.blows.length > blows, `heard at ${(struck * 3.6).toFixed(0)} km/h, ${car.blows.length - blows} dents`);
      await t.look({ x: car.x, y: car.y, h: car.h }, { name: 'furniture-aftermath-parked-car', views: ['top', 'front-left'] });
    }

    // Thrown at another lying on the pavement.
    {
      const me = g.walker;
      // (Somewhere clear: 6 m of open ground.)
      let at: [number, number] | null = null;
      for (let a = 0; a < 32 && !at; a++) {
        const h = (a * Math.PI) / 16, r = 6 + (a % 4) * 3, x = me.x + Math.cos(h) * r, y = me.y + Math.sin(h) * r;
        let ok = true;
        for (let d = -1; d <= 5 && ok; d += 0.5) for (const o of [-1, 0, 1]) if (g.grid.at(x + d + 0 * o, y + o) !== 0) { ok = false; break; }
        if (ok) at = [x, y];
      }
      if (!at) t.check('open ground for two pieces', false);
      else {
        t.placePiece(free[1], at[0], at[1]);
        t.placePiece(free[2], at[0] + 4, at[1], -7, 0);
        await t.wait(2.5);
        const a = t.pieces()[free[1]], b = t.pieces()[free[2]];
        const moved = Math.hypot(a.x - at[0], a.y - at[1]);
        t.check('a piece thrown at another knocked it on', moved > 0.3, `${moved.toFixed(2)} m`);
        t.check('they ended up apart', Math.hypot(a.x - b.x, a.y - b.y) > 0.5, `${Math.hypot(a.x - b.x, a.y - b.y).toFixed(2)} m`);
      }
    }

    // Lying in the lane 25 m ahead of a traffic car: it waits or goes round, never through.
    {
      let met = false;
      for (let tries = 0; tries < 6 && !met; tries++) {
        const car = t.trafficCar();
        if (!car || car.speed < 3) { await t.wait(1); continue; }
        const x = car.x + Math.cos(car.h) * 25, y = car.y + Math.sin(car.h) * 25;
        if (g.grid.at(x, y) !== 0) { await t.wait(1); continue; }
        t.placePiece(free[0], x, y);
        await t.wait(0.5);
        const p0 = t.pieces()[free[0]];
        // How near it came, how slow it went near it, and how fast it was going when it
        // first touched it (if it did, squeezing past after a wait).
        let near = Infinity, slow = Infinity, touched = -1, waited = 0;
        for (let i = 0; i < 60; i++) {
          await t.wait(0.25);
          const d = Math.hypot(car.x - p0.x, car.y - p0.y), p = t.pieces()[free[0]];
          near = Math.min(near, d);
          if (d < 12) { slow = Math.min(slow, car.speed); if (car.speed < 0.3) waited += 0.25; }
          if (touched < 0 && Math.hypot(p.x - p0.x, p.y - p0.y) > 0.05) touched = car.speed;
        }
        if (near > 10) continue; // (it turned off before it got there)
        met = true;
        const p = t.pieces()[free[0]], shoved = Math.hypot(p.x - p0.x, p.y - p0.y);
        t.check('a traffic car met a piece lying in its lane and never ran into it at speed', touched < 2.5,
          `${touched < 0 ? 'never touched it' : `touched it at ${(touched * 3.6).toFixed(0)} km/h and moved it ${shoved.toFixed(2)} m`}, came within ${near.toFixed(1)} m, slowest ${(slow * 3.6).toFixed(0)} km/h, stood ${waited.toFixed(1)} s`);
        await t.look({ x: p.x, y: p.y, h: car.h }, { name: 'furniture-aftermath-traffic', views: ['top', 'third'] });
      }
      if (!met) t.check('a traffic car coming on a piece in its lane', true, 'none met one: skipped');
    }
  },
} satisfies Scenario;
