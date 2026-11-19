import type { Scenario } from '../src/testkit.ts';

export default {
  title: 'A driver stopped close behind you backs up before pulling out',
  async run(t) {
    await t.go([50.07581, 14.41882], { heading: 98 });
    t.time('20:54');
    t.weather('clear');
    t.season('07-15');
    t.set({ health: 100 });

    for (let i = 0; i < 30; i++) {
      await t.wait(1);
      const me = t.where(), drivers = t.trafficAgents();
      const a = drivers.find(({ car, route, off, kerb }) =>
        !car.two && !car.spec.heavy && !kerb && Math.abs(off) < 0.01 &&
        Math.cos(car.h + 0.14) > 0.99 && Math.hypot(car.x - me.x, car.y - me.y) < 45 &&
        !!route.leg.edge && route.s - route.leg.s0 > 5 && route.leg.s1 - route.s > 14 &&
        drivers.every(b => b.car === car || Math.hypot(b.car.x - car.x, b.car.y - car.y) > 13));
      if (!a) continue;

      const { car } = a, x = car.x, y = car.y, h = car.h;
      a.speed = car.vx = car.vy = 0;
      t.standAhead(car, car.spec.L / 2 + 1.4);
      // Start at the decision to pass; blocking-queue exercises the wait and honks.
      a.around = 8;
      await t.wait(0.15);
      const forward = (car.x - x) * Math.cos(h) + (car.y - y) * Math.sin(h);
      t.check('the car moves backwards before steering out', forward < -0.12 && Math.abs(a.off) < 0.05,
        { forward, offset: a.off });
      await t.wait(14);
      const progress = (car.x - x) * Math.cos(h) + (car.y - y) * Math.sin(h);
      t.check('the car gets past you without hitting you', progress > car.spec.L + 2 && t.probe().health === 100,
        { progress, offset: a.off, speed: car.speed, health: t.probe().health });
      return;
    }
    t.check('a car with room behind it on a straight approach', false);
  },
} satisfies Scenario;
