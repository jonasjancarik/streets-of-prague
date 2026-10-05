import type { Scenario } from '../src/testkit.ts';

export default {
  title: 'A car at 50 km/h knocks a lamp post over',
  async run(t) {
    // Along the street: the heading a new game leaves you with can face a house front,
    // where there is no room to put the car down.
    await t.go('vodickova', { heading: 315 });
    t.time('14:00');
    t.weather('clear');
    await t.drive('hatch');
    const post = t.post(80);
    if (!t.check('a post nearby', !!post)) return;
    t.aimAt(post!, 18);
    t.view(0.5);
    t.push(50);
    await t.wait(2);
    const p = t.probe();
    t.check('the post is down', !!post!.down);
    t.check('the car lost speed but kept going', p.speed > 10 && p.speed < 45, `${p.speed} km/h`);
    await t.shot('lamp-knock');
  },
} satisfies Scenario;
