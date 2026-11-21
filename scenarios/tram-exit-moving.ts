import type { Scenario } from '../src/testkit.ts';

export default {
  title: 'Jumping out of a moving tram drops you hurt on the ground; the empty tram rolls on without braking',
  async run(t) {
    await t.go('ujezd', { heading: 0 });
    t.time('14:00');
    t.weather('clear');
    await t.wait(2);
    t.unhurt = false;
    // At Újezd the nearest tram can be stopped at a platform or in a queue.
    // Board a tram that is already above the speed at which stepping off hurts.
    let aboard = t.takeTram(22);
    for (let i = 0; !aboard && i < 30; i++) { await t.wait(1); aboard = t.takeTram(22); }
    if (!t.check('a moving tram is available', aboard)) return;
    await t.wait(.15, { move: 1 });
    const before = t.tram()?.speed ?? 0;
    const health = t.probe().health;
    t.check('the tram is moving fast enough to hurt on exit', before > 14.4, before);
    t.press();
    t.check('on foot, though the tram was moving', t.probe().mode === 'foot', t.probe().mode);
    t.check('and hurt by the fall', t.probe().health < health, { health, now: t.probe().health });
    await t.wait(1);
    const mid = t.rolling();
    t.check('the tram rolls on, hardly slower', mid.speed > before * 0.9, { before, mid });
    await t.wait(240);
    t.check('and in the end it has stopped or gone', t.rolling().n === 0, t.rolling());
  },
} satisfies Scenario;
