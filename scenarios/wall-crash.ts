import type { Scenario } from '../src/testkit.ts';

export default {
  title: 'A wall impact near 60 km/h sharply slows the car and damages it',
  async run(t) {
    // Keep the initial car-placement search independent of the previous driver's heading.
    await t.go('karlak', { heading: 324 });
    t.time('14:00');
    t.weather('clear');
    t.empty();
    const car = await t.drive('sedan');
    const wall = t.wallRun();
    if (!t.check('a broad wall with a clear run up to it', !!wall)) return;
    const hits: { before: number; after: number; damage: number; force: number }[] = [];
    const collide = car.collideGrid;
    car.collideGrid = function (grid) {
      const before = this.speed * 3.6, damage = this.damage;
      const force = collide.call(this, grid);
      if (force > 0) hits.push({ before, after: this.speed * 3.6, damage: this.damage - damage, force });
      return force;
    };
    // Coast from the stated speed. Holding the pedal for three seconds used to
    // reach the wall above 100 km/h and test subsequent acceleration or sliding.
    let furthest = -wall!.back;
    const paused = t.paused;
    t.paused = true;
    try {
      t.push(60, wall!.heading);
      for (let i = 0; i < 180; i++) {
        await t.wait(1 / 60);
        furthest = Math.max(furthest, (car.x - wall!.x) * wall!.dx + (car.y - wall!.y) * wall!.dy);
      }
    } finally {
      car.collideGrid = collide;
      t.paused = paused;
    }
    const hit = hits[0];
    t.check('the wall was hit near 60 km/h', !!hit && hit.before >= 50 && hit.before <= 65, hit);
    t.check('the impact removed at least half the speed', !!hit && hit.after < hit.before / 2, hit);
    t.check('the wall impact caused damage', !!hit && hit.damage > 0, hit);
    t.check('the car stayed before the wall', furthest < 0, `${furthest.toFixed(2)} m before the wall`);
    const p = t.probe();
    t.check('the car slowed below 15 km/h', p.speed < 15, `${p.speed} km/h`);
    t.check('the car is damaged', (p.car?.damage ?? 0) > 0, `damage ${p.car?.damage}`);
    await t.shot('wall-crash');
  },
} satisfies Scenario;
