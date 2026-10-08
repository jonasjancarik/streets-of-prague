import type { Scenario } from '../src/testkit.ts';

export default {
  title: 'A driver held up by you standing in the road sounds the horn',
  async run(t) {
    await t.go('vodickova', { heading: 0 });
    t.time('14:00');
    t.weather('clear');
    let c = t.trafficCar();
    for (let i = 0; !c && i < 30; i++) { await t.wait(1); c = t.trafficCar(); }
    if (!t.check('a car in traffic nearby', !!c)) return;
    const honks = t.watchHonks();
    t.standAhead(c!, 5);
    await t.wait(2);
    t.check('not a toot at once', honks.length === 0, `${honks.length}`);
    await t.wait(8);
    t.check('it sounds the horn at you after a while', honks.length >= 2, `${honks.length} honks`);
    t.check('and the long one comes later', honks.length < 3 || honks.slice(2).some((x) => x), JSON.stringify(honks));
  },
} satisfies Scenario;
