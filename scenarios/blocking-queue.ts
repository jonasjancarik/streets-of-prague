import type { Scenario } from '../src/testkit.ts';
import type { Car } from '../src/car.ts';

// You stand in the lane in Resslova at night and a queue builds up behind you
// (the user's "drivers are too polite" report, 13 Nov 2026).
export default {
  title: 'Drivers held up behind you in a queue honk too, and go round you after a while',
  async run(t) {
    await t.go([50.07581, 14.41882], { heading: 98 });
    t.time('20:54');
    t.weather('clear');
    t.season('07-15');
    t.set({ health: 100 });
    // A car heading east down this side of the street, and you a few metres ahead of it.
    let c: Car | undefined;
    for (let i = 0; !c && i < 30; i++) {
      await t.wait(1);
      const me = t.where();
      c = t.trafficAgents().map((a) => a.car)
        .filter((k) => !k.two && Math.cos(k.h + 0.14) > 0.9 && Math.hypot(k.x - me.x, k.y - me.y) < 60)
        .sort((a, b) => Math.hypot(a.x - me.x, a.y - me.y) - Math.hypot(b.x - me.x, b.y - me.y))[0];
    }
    if (!t.check('a car heading east nearby', !!c)) return;
    // (Far enough ahead for it to stop: a bus at 30 km/h needs some 15 m.)
    t.standAhead(c!, c!.spec.L / 2 + 18);
    const me = t.where(), hx = Math.cos(c!.h), hy = Math.sin(c!.h);
    const honks = t.watchHonks(), drivers = t.trafficAgents();
    // Who stood queued in your lane behind you, and who of them then got past you.
    const behind = new Set<Car>(), past = new Set<Car>();
    let shot = false;
    for (let i = 0; i < 500; i++) {
      await t.wait(0.1);
      t.stand([me.lat, me.lon]);
      for (const a of drivers) {
        const k = a.car, along = (k.x - me.x) * hx + (k.y - me.y) * hy, across = (k.x - me.x) * hy - (k.y - me.y) * hx;
        if (Math.cos(k.h - c!.h) < 0.7 || Math.abs(across) > 6) continue;
        if (along < -2 && along > -40 && Math.abs(across) < 1.8 && k.speed < 0.5) behind.add(k);
        else if (along > k.spec.L / 2 + 2 && behind.has(k)) past.add(k);
      }
      if (i === 120) await t.shot('blocking-queue-wait');
      if (past.size && !shot) { shot = true; await t.shot('blocking-queue-round'); }
    }
    const honkers = new Map<Car, number>();
    for (const k of honks.cars) honkers.set(k, (honkers.get(k) ?? 0) + 1);
    // (How many queue up depends on the traffic that comes along.)
    const said = { honkers: [...honkers].map(([k, n]) => `${k.type}×${n}`), past: [...past].map((k) => k.type), queued: behind.size };
    t.check('drivers queue up behind you', behind.size >= 1, said);
    t.check('the drivers queued behind you honk, not only the first', honkers.size >= Math.min(2, behind.size), said);
    t.check('and they go round you', past.size >= Math.min(2, behind.size), said);
    t.check('and nobody runs you over', t.probe().health === 100, { health: t.probe().health });
  },
} satisfies Scenario;
