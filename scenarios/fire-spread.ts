import type { Scenario } from '../src/testkit.ts';

export default {
  title: 'Flames spread to the car alongside before the blast reaches farther',
  async run(t) {
    await t.go('staromak', { heading: 90 });
    t.time('14:00');
    t.weather('clear');
    t.empty();
    const source = t.car('sedan', { ahead: 8 });
    const close = t.car('sedan', { ahead: 14.4 });
    const side = t.car('sedan', { at: [50.087273, 14.4206], ahead: 8 });
    const far = t.car('sedan', { ahead: 0.5 });
    const bumperGap = (c: typeof source) =>
      Math.hypot(c.x - source.x, c.y - source.y) - (c.spec.L + source.spec.L) / 2;
    const closeGap = bumperGap(close), farGap = bumperGap(far);
    const sideGap = Math.abs(side.y - source.y) - (side.spec.W + source.spec.W) / 2;
    if (!t.check('a car is parked alongside', Math.abs(side.x - source.x) < 1 && sideGap > 0 && sideGap <= 1.5, sideGap)) return;
    if (!t.check('the close car is about two metres past the bumper', closeGap > 1.5 && closeGap <= 2, closeGap)) return;
    if (!t.check('the far car is over two metres away', farGap > 2.5, farGap)) return;

    await t.enter(source);
    t.ignite(source);
    await t.wait(0.25);
    t.exit();
    t.unhurt = true;
    try {
      await t.wait(2.25);
      t.check('the first car is still burning', t.fire(source).burning);
      t.check('the car alongside caught fire before the explosion', t.fire(side).burning, side.damage);
      t.check('the car past the bumper is beyond the flames', !t.fire(close).flames, close.damage);
      await t.wait(3.75);
      t.check('the first car exploded', t.fire(source).wreck);
      t.check('the close car caught fire', t.fire(close).burning, close.damage);
      t.check('the far car stayed intact', !t.fire(far).burning && !t.fire(far).wreck, far.damage);
    } finally {
      t.unhurt = false;
    }
  },
} satisfies Scenario;
