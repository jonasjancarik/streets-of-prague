import type { Scenario } from '../src/testkit.ts';

// The sound is told of each crash (src/impacts.ts, Sound.crash): a wall, a lamp post and
// a parked car, each once or a few times, not every frame while the car is against it.
export default {
  title: 'Crashing into a wall, a post and a parked car is heard, as what it hit',
  async run(t) {
    const log = t.watchCrashes();
    const paused = t.paused;
    try {
      // A wall at 40 km/h.
      await t.go('karlak', { heading: 324 });
      t.time('14:00');
      t.weather('clear');
      t.empty();
      await t.drive('sedan');
      const wall = t.wallRun();
      if (t.check('a broad wall with a clear run up to it', !!wall)) {
        t.paused = true;
        log.length = 0;
        t.push(40, wall!.heading);
        await t.wait(2.5);
        const hard = log.filter((e) => e.kind === 'wall' && e.mine && e.kmh > 4);
        t.check('the wall is heard, near 40 km/h', hard.length > 0 && hard[0].kmh > 30 && hard[0].kmh <= 45, hard);
        t.check('and not every frame against it', log.length < 20, `${log.length} reported`);
        t.paused = paused;
      }

      // A lamp post at 50 km/h.
      await t.go('vodickova', { heading: 315 });
      const hatch = await t.drive('hatch');
      const post = t.post(80, 18, 14);
      if (t.check('a post with a clear run up to it', !!post)) {
        log.length = 0;
        t.push(50);
        await t.wait(2);
        const hit = log.find((e) => e.kind === 'post');
        t.check('the post is heard', !!hit && hit.mine, log);
      }

      // A parked car, from behind at 30 km/h, on open ground.
      t.clearing(18, 400);
      t.push(0);
      const parked = t.car('sedan', { ahead: 9 });
      log.length = 0;
      // (Straight at it: it may have been put down a little to one side.)
      t.push(30, (Math.atan2(parked.x - hatch.x, parked.y - hatch.y) * 180) / Math.PI);
      await t.wait(2);
      const bump = log.find((e) => e.kind === 'car');
      t.check('the parked car is heard', !!bump && bump.mine && bump.kmh > 10, { log, parked: t.standing(parked) });
    } finally {
      t.paused = paused;
      log.stop();
    }
  },
} satisfies Scenario;
