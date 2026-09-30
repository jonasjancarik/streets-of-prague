import type { Scenario } from '../src/testkit.ts';

export default {
  title: 'Two stars bring police cars after you',
  async run(t) {
    await t.go('karlak');
    t.time('14:00');
    t.weather('clear');
    t.set({ stars: 0 });
    await t.wait(1);
    t.check('no police to start with', t.probe().police === 0);
    t.set({ stars: 2 });
    await t.wait(20);
    const p = t.probe();
    t.check('police cars are after you', p.police > 0, `${p.police} cars`);
    t.check('still wanted', p.stars >= 1, `${p.stars} stars`);
    t.set({ stars: 0 });
  },
} satisfies Scenario;
