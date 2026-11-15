import type { Scenario } from '../src/testkit.ts';

export default {
  title: 'Holding the accelerator frees a car from a tree until it clears the trunk',
  async run(t) {
    await t.go('petrin', { heading: 90 });
    t.time('14:00');
    t.weather('clear');
    t.empty();
    const car = await t.drive('sedan');
    // An eastbound stretch of open ground with a single trunk in the middle.
    t.stand([50.08360532, 14.39542680]);
    t.push(0, 90);
    const trunkX = t.toLocal([50.08360536, 14.39549387])[0];
    const position = () => car.x - trunkX;
    const paused = t.paused;
    t.paused = true;
    try {
      await t.wait(1, { move: 1 });
      t.check('the trunk stops the first approach', position() > -3.6 && position() < -2.4, position());
      await t.wait(0.35);
      await t.wait(0.7, { move: 1 });
      t.check('lifting off resets the hold', position() < -2.4, position());
      for (let i = 0; i < 22 && position() < 3.55; i++) await t.wait(0.1, { move: 1 });
      if (!t.check('sustained throttle takes the car past the trunk', position() >= 3.55, position())) return;
      t.push(0, 90);
      await t.wait(1.1, { move: -1 });
      t.check('the same trunk stops the car on the way back', position() > 2.4 && position() < 3.6, position());
    } finally {
      t.paused = paused;
    }
  },
} satisfies Scenario;
