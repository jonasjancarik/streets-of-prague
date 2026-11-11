import type { Scenario } from '../src/testkit.ts';

export default {
  title: 'A motorbike takes a wall at 35 km/h and the rider stays on; at 60 km/h they are thrown off',
  async run(t) {
    await t.go('karlak', { heading: 324 });
    t.time('14:00');
    t.weather('clear');
    t.empty();
    t.unhurt = true;
    let bike = await t.drive('moto');
    const wall = t.wallRun();
    if (!t.check('a broad wall with a clear run up to it', !!wall)) return;
    for (const [kmh, thrown] of [[35, false], [60, true]] as const) {
      if (!t.probe().mode.startsWith('car')) bike = await t.drive('moto');
      bike.x = wall!.x - wall!.dx * wall!.back;
      bike.y = wall!.y - wall!.dy * wall!.back;
      bike.h = Math.atan2(wall!.dy, wall!.dx);
      bike.vx = bike.vy = 0;
      t.push(kmh, wall!.heading, bike);
      await t.wait(3);
      t.check(`at ${kmh} km/h the rider ${thrown ? 'comes off' : 'stays on'}`, (t.probe().mode === 'foot') === thrown, t.probe().mode);
      if (!thrown) t.exit();
    }
    t.unhurt = false;
  },
} satisfies Scenario;
