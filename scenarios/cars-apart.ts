import type { Scenario } from '../src/testkit.ts';
import type { Car } from '../src/car.ts';

// How deep two cars' collision circles reach into each other, in metres.
const depth = (a: Car, b: Car) => {
  let m = 0;
  for (const p of a.circles()) for (const q of b.circles()) m = Math.max(m, a.r + b.r - Math.hypot(p[0] - q[0], p[1] - q[1]));
  return Math.round(m * 100) / 100;
};

export default {
  title: 'Cars that stop inside each other, or are put down there, come apart',
  async run(t) {
    await t.go('staromak', { heading: 90 });
    t.time('14:00');
    t.weather('clear');
    t.empty();
    t.unhurt = true;
    const me = await t.drive('van');
    const spot = t.clearing(18, 120);
    if (!t.check('open ground', !!spot)) return;
    const park = (type: string, x: number, y: number, h: number) => {
      const c = t.car(type, { ahead: 8 });
      if (c) Object.assign(c, { x, y, h, vx: 0, vy: 0, w: 0 });
      return c;
    };

    // A car put down standing half inside another.
    const pickup = park('pickup', spot!.x, spot!.y + 6, 0);
    const sedan = park('sedan', spot!.x + 2.6, spot!.y + 6.6, 0.4);
    if (!t.check('two cars to overlap', !!pickup && !!sedan)) return;
    Object.assign(me, { x: spot!.x - 12, y: spot!.y - 6, h: 0 });
    const before = depth(pickup!, sedan!);
    await t.wait(1);
    t.check('standing cars put down inside each other come apart', before > 1 && depth(pickup!, sedan!) < 0.05, { before, after: depth(pickup!, sedan!) });

    // A crash shoves a parked car into the one behind it; once all is still, none is inside another.
    const a = park('hatch', spot!.x, spot!.y - 6, 0);
    const b = park('sedan', spot!.x + 4.6, spot!.y - 6, 0);
    if (!t.check('two parked cars nose to tail', !!a && !!b)) return;
    Object.assign(me, { x: spot!.x + 1, y: spot!.y - 16, h: Math.PI / 2, w: 0 });
    t.push(45, 10, me);
    await t.wait(4);
    const cars = [me, pickup!, sedan!, a!, b!];
    let worst = 0;
    for (let i = 0; i < cars.length; i++) for (let j = i + 1; j < cars.length; j++) worst = Math.max(worst, depth(cars[i], cars[j]));
    t.check('after a crash no car stands inside another', worst < 0.05, { worst, moved: Math.round(Math.hypot(a!.x - spot!.x, a!.y - spot!.y + 6) * 10) / 10 });
    await t.shot('cars-apart');
  },
} satisfies Scenario;
