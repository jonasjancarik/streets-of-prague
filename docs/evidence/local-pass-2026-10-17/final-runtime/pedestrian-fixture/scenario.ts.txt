import type { Scenario } from '../src/testkit.ts';

export default {
  title: 'A pedestrian standing in the road, 3 m in front of a car at 50 km/h, leaps clear and is not knocked over',
  async run(t) {
    await t.go('vodickova', { heading: 315 });
    t.time('14:00');
    t.weather('clear');
    const paused = t.paused, unhurt = t.unhurt;
    t.unhurt = true;
    try {
      const c = await t.drive('hatch');
      // Cover the full three-second coast, including the car's front beyond its centre.
      const post = t.post(80, 18, 30);
      if (!t.check('a clear run of road', !!post)) return;
      const start = { x: c.x, y: c.y, h: c.h };
      const p = t.pedestrianAhead(3);
      if (!t.check('a pedestrian to stand in the way', !!p)) return;
      // Only the explicit waits advance the world between these rendered frames.
      t.paused = true;
      t.push(50);
      let down = 0, jumped = false;
      for (let i = 0; i < 30; i++) {
        await t.wait(0.1);
        down = Math.max(down, t.downNear(p!.x, p!.y, 15));
        jumped ||= p!.state === 'flee';
      }
      t.check('nobody is knocked over', down === 0, `${down}`);
      t.check('the pedestrian got away', jumped);
      const end = t.probe();
      t.check('the car kept going', end.speed > 10, {
        start,
        post: { x: post!.x, y: post!.y, r: post!.r, tough: post!.tough, give: post!.give, down: !!post!.down },
        end,
      });
    } finally {
      t.paused = paused;
      t.unhurt = unhurt;
    }
  },
} satisfies Scenario;
