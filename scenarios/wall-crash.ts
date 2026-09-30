import type { Scenario } from '../src/testkit.ts';

export default {
  title: 'Driving into a wall at 60 km/h stops the car and damages it',
  async run(t) {
    await t.go('karlak');
    t.time('14:00');
    t.weather('clear');
    await t.drive('sedan');
    // The heading with a wall 15–40 m away and nothing in between.
    let heading = -1;
    for (let a = 0; a < 360 && heading < 0; a += 10) {
      const d = t.runway(a);
      if (d > 15 && d < 40) heading = a;
    }
    if (!t.check('a wall within reach', heading >= 0)) return;
    t.push(60, heading);
    await t.wait(3, { move: 1 });
    const p = t.probe();
    t.check('the car stopped at the wall', p.speed < 15, `${p.speed} km/h`);
    t.check('the car is damaged', (p.car?.damage ?? 0) > 0, `damage ${p.car?.damage}`);
    await t.shot('wall-crash');
  },
} satisfies Scenario;
