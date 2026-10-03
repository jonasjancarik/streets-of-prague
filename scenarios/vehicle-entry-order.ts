import type { Scenario, Result } from '../src/testkit.ts';

export default {
  title: 'A helicopter scenario cannot prevent the next scenario from entering a car',
  async run(t) {
    const checks = t.checks;
    let helicopter: Result, car: Result;
    try {
      helicopter = await t.run('heli-bridge');
      car = await t.run('lamp-knock');
    } finally {
      // Nested runs have their own assertions. Retain their complete results below
      // without losing this order regression's checks to the nested reset.
      t.checks = checks;
    }
    t.check('helicopter scenario still passes', helicopter.pass, helicopter);
    t.check('following car scenario still passes', car.pass, car);
  },
} satisfies Scenario;
