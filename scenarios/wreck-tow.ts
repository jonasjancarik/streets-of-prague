import type { Scenario } from '../src/testkit.ts';

export default {
  title: 'A wreck left out of sight is towed after a minute, one in view stays',
  async run(t) {
    await t.go('karlak', { heading: 0 });
    t.time('14:00');
    t.weather('clear');
    t.set({ stars: 0 });
    const near = t.car('hatch', { ahead: 8 });
    const far = t.car('hatch', { ahead: -160 });
    near.damage = far.damage = 50;
    if (!t.check('both there to start with', t.standing(near) && t.standing(far))) return;
    const closeView = t.carView(near), farView = t.carView(far);
    if (!t.check('the near wreck starts in view', !closeView.outOfSight, JSON.stringify(closeView))) return;
    if (!t.check('the far wreck starts beyond the cleanup view', farView.outOfSight && farView.playerDistance >= 40 && farView.playerDistance < 600,
      JSON.stringify(farView))) return;
    if (!t.check('both wrecks start stationary', near.speed <= 0.5 && far.speed <= 0.5)) return;
    await t.wait(90);
    t.check('the one out of sight is gone', !t.standing(far), JSON.stringify(t.carView(far)));
    t.check('the one beside you stays', t.standing(near), JSON.stringify(t.carView(near)));
  },
} satisfies Scenario;
