import type { Scenario } from '../src/testkit.ts';

export default {
  title: 'Getting out of a car doing 40 km/h leaves you hurt on the ground',
  async run(t) {
    await t.go('karlak', { heading: 324 });
    t.time('14:00');
    t.weather('clear');
    t.empty();
    const car = await t.drive('sedan');
    t.push(40, undefined, car);
    const health = t.probe().health;
    t.press();
    t.check('out of the car', t.probe().mode === 'foot', t.probe().mode);
    t.check('and hurt', t.probe().health < health, { health, now: t.probe().health });
  },
} satisfies Scenario;
