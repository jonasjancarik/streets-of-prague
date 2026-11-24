import type { Scenario } from '../src/testkit.ts';

// Rollovers (src/rollover.ts): sliding sideways into a wall slowly leaves the car on its
// wheels; fast, it goes over. You climb out of an overturned car and can't get back in.
export default {
  title: 'A car sliding sideways into a wall rolls over when fast, and you climb out',
  async run(t) {
    const slide = async (kmh: number) => {
      await t.go('karlak', { heading: 324 });
      t.time('14:00');
      t.weather('clear');
      t.empty();
      const car = await t.drive('sedan');
      if (!t.wallRun(3.2)) return null;
      t.push(kmh);
      car.h += Math.PI / 2; // facing across: the slide goes sideways into the wall
      let most = 0;
      for (let i = 0; i < 40; i++) { await t.wait(0.1); most = Math.max(most, Math.abs(car.lean)); }
      return { car, most: Math.round(most * 57.3), lying: car.roll?.face ?? 'wheels', settled: !car.roll?.moving };
    };

    const slow = await slide(20);
    if (!t.check('a wall with a clear run up to it', !!slow)) return;
    t.check('at 20 km/h it stays on its wheels', slow!.lying === 'wheels' && slow!.most < 30, `tipped to ${slow!.most}°`);

    const fast = await slide(100);
    if (!t.check('a wall with a clear run up to it, again', !!fast)) return;
    t.check('at 100 km/h it ends on its side or roof', fast!.lying !== 'wheels' && fast!.settled, `${fast!.lying}, tipped to ${fast!.most}°`);
    t.check('the roll damaged it', fast!.car.damage > 5, `damage ${Math.round(fast!.car.damage)}`);
    await t.shot('rollover');

    t.press();
    await t.wait(1.5);
    t.check('you climb out of it', t.probe().car === null);
    t.press();
    await t.wait(1.5);
    t.check("and can't get back in", t.probe().car === null);
  },
} satisfies Scenario;
