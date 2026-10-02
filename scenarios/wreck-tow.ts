import type { Scenario } from '../src/testkit.ts';

export default {
  title: 'A wreck left out of sight is towed after a minute, one in view stays',
  async run(t) {
    await t.go('karlak');
    t.time('14:00');
    t.weather('clear');
    t.set({ stars: 0 });
    const near = t.car('hatch', { ahead: 8 });
    const far = t.car('hatch', { ahead: -90 });
    near.damage = far.damage = 50;
    t.check('both there to start with', t.standing(near) && t.standing(far));
    await t.wait(90);
    t.check('the one out of sight is gone', !t.standing(far));
    t.check('the one beside you stays', t.standing(near));
  },
} satisfies Scenario;
