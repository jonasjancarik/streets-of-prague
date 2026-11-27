import type { Scenario } from '../src/testkit.ts';
import { firstPersonOptions, setFirstPersonOptions } from '../src/streetView.ts';

const deg = (r: number) => Math.round(r * 1800 / Math.PI) / 10;

// Physical handling (src/physicalHandling.ts) in the game: only in first and third person,
// the body squats, leans out of a bend, and a van thrown from one lock to the other goes
// up on two wheels and over; lying on its side or roof it is an overturned car like any
// other (rollover.ts), which you climb out of.
export default {
  title: 'Physical handling leans the body, tips a swerving van over and leaves it overturned',
  async run(t) {
    const previous = firstPersonOptions.handling, paused = t.paused;
    try {
      await t.go('staromak', { heading: 90 });
      t.empty(); t.unhurt = true; t.weather('clear'); t.time('14:00');
      const car = await t.drive('sedan');
      const spot = t.clearing(18, 120);
      if (!t.check('open ground to drive about on', !!spot) || !spot) return;
      t.paused = true;
      setFirstPersonOptions({ handling: 'physical' }, false);
      t.eyes = null;
      await t.wait(.1, { move: 1 });
      t.check('overhead stays classic', !car.physics);

      t.eyes = { yaw: 0, pitch: 0, third: true };
      Object.assign(car, { x: spot.x - 14, y: spot.y, vx: 0, vy: 0, w: 0, h: 0 });
      await t.wait(.5, { move: 1 });
      const squat = car.physics ? deg(Math.asin(car.physics.axes[2])) : NaN;
      t.check('in third person the physical body drives, and pulling away lifts the nose', squat > .15, `${squat}°`);

      Object.assign(car, { x: spot.x - 12, y: spot.y, w: 0 });
      t.push(45, 90);
      let lean = 0;
      for (let i = 0; i < 16; i++) {
        await t.wait(.05, { turn: 1, move: .3 });
        lean = Math.max(lean, Math.abs(car.physics?.rollAngle ?? 0));
      }
      t.check('a sharp bend leans the body out', deg(lean) > 2.5 && !car.overturned, `${deg(lean)}°`);
      await t.shot('physical-corner');

      // Dropped from a metre up: the wheels hang down in their arches, and it lands on them.
      await t.wait(1.5, { brake: true });
      t.eyes = { yaw: 35, pitch: -5, third: true };
      const body = car.physics as unknown as { p: Float64Array } | undefined;
      if (body) body.p[2] += 1;
      await t.wait(.1);
      const hanging = car.physics ? Math.min(...[0, 1, 2, 3].map((i) => car.physics!.travel(i))) : 0;
      t.check('in the air the wheels hang down', hanging < -.1, `${Math.round(hanging * 100)} cm`);
      await t.shot('physical-air');
      await t.wait(1.5);
      t.check('and it lands on them', !!car.physics?.planted && !car.overturned);

      const van = await t.drive('van');
      const room = t.clearing(15, 200);
      if (!t.check('room for a van to swerve', !!room) || !room) return;
      Object.assign(van, { x: room.x - 16, y: room.y, w: 0 });
      t.push(75, 90);
      await t.wait(.05);
      let most = 0, shot = false;
      for (let i = 0; i < 160 && (van.physics || !van.roll); i++) {
        await t.wait(.05, { turn: i < 10 ? 1 : i < 30 ? -1 : 0 });
        most = Math.max(most, Math.abs(van.physics?.rollAngle ?? van.roll?.angle ?? 0));
        if (!shot && deg(most) > 25) { shot = true; await t.shot('physical-van-two-wheels'); }
      }
      t.check('thrown from one lock to the other at 75 km/h, the van goes over', !!van.roll && van.roll.face !== 'wheels' && !van.roll.moving, `${van.roll?.face ?? 'on its wheels'}, ${deg(most)}° at most`);
      t.check('and is damaged', van.damage > 3, Math.round(van.damage));
      await t.shot('physical-van-over');
      t.press();
      await t.wait(1.5);
      t.check('you climb out of it', t.probe().car === null);
    } finally {
      t.eyes = null; t.paused = paused;
      setFirstPersonOptions({ handling: previous }, false);
    }
  },
} satisfies Scenario;
