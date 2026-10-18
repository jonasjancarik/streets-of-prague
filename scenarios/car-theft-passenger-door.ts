import type { Scenario } from '../src/testkit.ts';

export default {
  title: 'Stealing a car through the passenger door gets its driver out, even with a wall at their own door',
  async run(t) {
    await t.go([50.06571, 14.4303], { heading: 198 });
    t.time('21:18');
    t.weather('clear');
    t.set({ money: 10000, stars: 0, health: 100 });
    // Cars in traffic, one after another, until a theft through the passenger's door has played.
    let tries = 0, done = false;
    while (!done && tries++ < 12) {
      // (One that is slow, at a crossing or in a queue: a car going fast has no door to be got into.)
      let v = t.trafficCar(true);
      for (let i = 0; (!v || v.speed > 2) && i < 120; i++) { await t.wait(1); v = t.trafficCar(true); }
      if (!v || v.speed > 2) { t.check('a slow car in traffic nearby', false); return; }
      const car = v;
      // The driver's own side is walled in (a building, a fence), so the passenger's door is the way in.
      const unwall = t.wallBeside(car, 1);
      t.toDoor(car, 2, 0.55);
      const before = t.peopleNear(car.x, car.y, 6).length;
      t.press();
      await t.wait(0.6);
      const people = t.peopleNear(car.x, car.y, 6);
      if (t.driven(car)) { unwall(); continue; } // (E found no door to go to: try another car)
      done = true;
      t.check('the driver is out', people.length > before, `${before} -> ${people.length} people about it`);
      // Where they stand, across the car from its driver's door: not inside the wall there.
      const c = Math.cos(car.h), s = Math.sin(car.h), W = car.spec.W;
      const inWall = people.filter((p) => {
        const left = (p.y - car.y) * c - (p.x - car.x) * s, along = (p.x - car.x) * c + (p.y - car.y) * s;
        return left > W / 2 + 0.2 && left < W / 2 + 3.2 && Math.abs(along) < 2.5;
      });
      t.check('nobody is stuck in the wall beside the driver\'s door', inWall.length === 0, JSON.stringify(inWall));
      await t.wait(3);
      unwall();
      t.check('the car is yours', t.probe().car?.type === car.type, t.where().mode);
      t.check('nobody is driving it for you', !t.driven(car));
      t.exit();
    }
    t.check('a theft played', done, `${tries} cars tried`);
  },
} satisfies Scenario;
