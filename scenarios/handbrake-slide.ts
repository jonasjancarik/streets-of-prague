import type { Scenario } from '../src/testkit.ts';
import type { Car } from '../src/car.ts';

// How far the car's travel is from where its nose points, in degrees.
const slip = (c: Car) => {
  if (c.speed < 1) return 0;
  const a = Math.atan2(c.vy, c.vx) - c.h;
  return Math.abs(Math.atan2(Math.sin(a), Math.cos(a))) * 180 / Math.PI;
};

export default {
  title: 'The handbrake in a turn swings the back out; an ordinary turn holds the road, and slides a little on snow',
  async run(t) {
    await t.go('staromak', { heading: 90 });
    t.time('14:00');
    t.weather('clear');
    t.empty();
    t.unhurt = true;
    const car = await t.drive('sedan');
    const spot = t.clearing(18, 120);
    if (!t.check('open ground to slide about on', !!spot)) return;
    const runs: Record<string, { slip: number; turned: number; kmh: number }> = {};
    for (const [name, brake] of [['turn', false], ['handbrake', true]] as const) {
      // Start 12 m short of the middle, so the turn happens in the open.
      Object.assign(car, { x: spot!.x - 12, y: spot!.y, w: 0 });
      t.push(50, 90, car);
      const h0 = car.h;
      let most = 0;
      for (let i = 0; i < 24; i++) {
        await t.wait(0.05, { move: brake ? 0 : 0.3, turn: 1, brake });
        most = Math.max(most, slip(car));
      }
      runs[name] = { slip: Math.round(most), turned: Math.round(Math.abs(car.h - h0) * 180 / Math.PI), kmh: Math.round(car.speed * 3.6) };
      await t.shot(`handbrake-slide-${name}`);
    }
    // Let go and drive on: the tyres take hold again.
    await t.wait(1, { move: 1 });
    const after = Math.round(slip(car));
    t.check('an ordinary turn barely slides', runs.turn.slip < 8, runs.turn);
    t.check('the handbrake swings the back out', runs.handbrake.slip > 25 && runs.handbrake.kmh > 5, runs.handbrake);
    t.check('letting go of the handbrake, the car straightens within a second', after < 5, { after, ...runs });

    // Fresh snow before the streets are cleared: an ordinary brisk turn drifts wide.
    t.time('05:00');
    t.weather('snow');
    Object.assign(car, { x: spot!.x - 12, y: spot!.y, w: 0 });
    t.push(50, 90, car);
    let snowy = 0;
    for (let i = 0; i < 24; i++) {
      await t.wait(0.05, { move: 0.3, turn: 1 });
      snowy = Math.max(snowy, slip(car));
    }
    await t.wait(1, { move: 1 });
    t.check('on fresh snow an ordinary turn slides a little, then holds again', snowy > 10 && snowy < 45 && slip(car) < 5, { slip: Math.round(snowy), after: Math.round(slip(car)) });
    t.weather('auto');
    t.unhurt = false;
  },
} satisfies Scenario;
