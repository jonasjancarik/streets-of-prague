import type { Scenario } from '../src/testkit.ts';

export default {
  title: 'Parked bikes and motorbikes fall over when hit by a car and stand up when mounted',
  async run(t) {
    await t.go('staromak', { heading: 90 });
    t.time('14:00');
    t.weather('clear');
    t.empty();
    for (const type of ['bike', 'moto']) {
      const car = await t.drive('sedan');
      const spot = t.clearing(15, 120);
      if (!t.check('a clear run up to the parked bike', !!spot)) return;
      car.x = spot!.x - 7;
      const bike = t.car(type, { ahead: 7, heading: 90 });
      if (!t.check(`the parked ${type} is in the car's path`,
        Math.hypot(bike.x - spot!.x, bike.y - spot!.y) < 0.1)) return;
      t.push(25, 90, car);
      await t.wait(1);
      await t.wait(3, { brake: true });
      // Lean is animated on rendered frames, independently of the physics steps.
      await t.frames(24);
      t.check(`the ${type} stays on its side`, Math.abs(bike.lean) > 1.4, bike.lean);
      await t.enter(bike);
      t.check(`the ${type} is upright when mounted`, !bike.tipped && Math.abs(bike.lean) < 0.3, bike.lean);
    }
  },
} satisfies Scenario;
