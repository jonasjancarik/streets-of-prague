import type { Scenario } from '../src/testkit.ts';
import { firstPersonOptions, setFirstPersonOptions } from '../src/streetView.ts';

export default {
  title: 'Realistic car handling follows the player camera and the suspension responds to driving',
  async run(t) {
    const previous = firstPersonOptions.handling, paused = t.paused;
    try {
      await t.go('staromak', { heading: 90 });
      t.empty(); t.unhurt = true; t.weather('clear'); t.time('14:00');
      const car = await t.drive('suv');
      const spot = t.clearing(18, 120);
      if (!t.check('clear ground for a short corner', !!spot) || !spot) return;
      t.paused = true;
      setFirstPersonOptions({ handling: 'realistic' }, false);
      t.eyes = null; await t.wait(.1, { move: 1 });
      t.check('overhead stays classic with the experiment selected', car.suspension === undefined);
      t.eyes = { yaw: 0, pitch: 0 };
      await t.wait(.55, { move: 1 });
      t.check('first-person launch lifts the nose', (car.suspension?.pitch ?? 0) > .015, car.suspension?.pitch);
      t.eyes = { yaw: 0, pitch: 0, third: true };
      Object.assign(car, { x: spot.x - 9, y: spot.y, w: 0 });
      t.push(48, 90);
      await t.wait(.72, { turn: 1, move: .15 });
      const roll = car.suspension?.roll ?? 0;
      t.check('third-person corner compresses the outside springs', roll > .042 && car.w > .22, { roll, yawRate: car.w });
      await t.shot('realistic-suspension-corner');
      await t.wait(.40, { move: -1 });
      t.check('braking dips the nose', (car.suspension?.pitch ?? 0) < -.025 && car.braking, car.suspension?.pitch);
      await t.shot('realistic-suspension-braking');
      setFirstPersonOptions({ handling: 'classic' }, false);
      const before = car.forwardSpeed;
      await t.wait(1/60);
      t.check('switches back in motion without losing speed', !car.suspension && Math.abs(car.forwardSpeed - before) < .6);
      setFirstPersonOptions({ handling: 'realistic' }, false);
      await t.wait(.05);
      t.push(0,90); t.exit();
      t.check('leaving clears the spring pose', t.where().mode === 'foot' && !car.suspension);
    } finally {
      t.eyes = null; t.paused = paused;
      setFirstPersonOptions({ handling: previous }, false);
    }
  },
} satisfies Scenario;
