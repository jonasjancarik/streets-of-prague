import type { Scenario } from '../src/testkit.ts';

export default {
  title: 'The driver of a car from the traffic gets out when it catches fire',
  async run(t) {
    t.exit();
    await t.go('ujezd', { heading: 180 });
    t.time('14:00');
    t.weather('clear');
    t.unhurt = true;
    try {
      await t.wait(3);
      const car = t.trafficCar();
      t.check('there is a car in the traffic', !!car);
      if (!car) return;
      t.check('it has a driver', t.driven(car));
      t.ignite(car);
      await t.wait(1.5);
      t.check('the driver is out of it', !t.driven(car));
      t.check('and running away', t.fleeing(car) > 0);
    } finally {
      t.unhurt = false;
    }
  },
} satisfies Scenario;
