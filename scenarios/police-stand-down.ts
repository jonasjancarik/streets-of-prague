import type { Scenario } from '../src/testkit.ts';

export default {
  title: 'After an arrest the police cars drive off instead of standing in the street',
  async run(t) {
    await t.go('karlak');
    t.time('14:00');
    t.weather('clear');
    t.set({ stars: 2 });
    await t.wait(25);
    t.check('police cars came', t.probe().police > 0, `${t.probe().police} cars`);
    t.forgive();
    await t.wait(40);
    const p = t.probe();
    t.check('no police car is left standing', p.police === 0, `${t.probe().police} cars`);
  },
} satisfies Scenario;
