import type { Scenario } from '../src/testkit.ts';

export default {
  title: 'Driving into a wall at 60 km/h stops the car and damages it',
  async run(t) {
    // Keep the initial car-placement search independent of the previous driver's heading.
    await t.go('karlak', { heading: 324 });
    t.time('14:00');
    t.weather('clear');
    await t.drive('sedan');
    const heading = t.wallAhead();
    if (!t.check('a wall within reach', heading >= 0)) return;
    t.push(60, heading);
    await t.wait(3, { move: 1 });
    const p = t.probe();
    t.check('the car stopped at the wall', p.speed < 15, `${p.speed} km/h`);
    t.check('the car is damaged', (p.car?.damage ?? 0) > 0, `damage ${p.car?.damage}`);
    await t.shot('wall-crash');
  },
} satisfies Scenario;
