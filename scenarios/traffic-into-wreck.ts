import type { Scenario } from '../src/testkit.ts';
import type { Car } from '../src/car.ts';

// How deep two cars' collision circles reach into each other, in metres.
const depth = (a: Car, b: Car) => {
  let m = 0;
  for (const p of a.circles()) for (const q of b.circles()) m = Math.max(m, a.r + b.r - Math.hypot(p[0] - q[0], p[1] - q[1]));
  return Math.round(m * 100) / 100;
};

export default {
  title: 'A car in traffic that meets a standing car too late to stop crashes into it, not through it',
  async run(t) {
    await t.go('vodickova', { heading: 90 });
    t.time('14:00');
    t.weather('clear');
    t.unhurt = true;
    await t.wait(4);
    const driving = t.trafficAgents().filter((a) => !a.car.two && !a.bus && a.car.speed > 8);
    const ag = driving.sort((a, b) => b.car.speed - a.car.speed)[0];
    if (!t.check('a car driving in traffic', !!ag, { cars: t.trafficAgents().length })) return;
    const c = ag!.car, kmh = Math.round(c.speed * 3.6);
    // A car left standing across its lane, too near to stop for.
    const wreck = t.car('sedan', { ahead: 30 });
    if (!t.check('a car to stand in its way', !!wreck)) return;
    const ahead = c.spec.L / 2 + 3.5;
    Object.assign(wreck!, { x: c.x + Math.cos(c.h) * ahead, y: c.y + Math.sin(c.h) * ahead, h: c.h + 1.2, vx: 0, vy: 0, w: 0, gz: c.gz });
    let worst = 0;
    for (let i = 0; i < 30; i++) {
      await t.wait(0.1);
      worst = Math.max(worst, depth(c, wreck!));
    }
    t.check('it never drives into the standing car', worst < 0.1, { kmh, worst });
    t.check('it crashed and left the traffic', !t.driven(c), { mode: c.mode, kmh });
    await t.shot('traffic-into-wreck');
  },
} satisfies Scenario;
