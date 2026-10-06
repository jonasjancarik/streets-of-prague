import type { Scenario } from '../src/testkit.ts';

export default {
  title: 'A cyclist hit hard by a car comes off the bike, and a courier leaves the bag behind',
  async run(t) {
    await t.go('letna');
    t.clearBags();
    t.time('14:00');
    t.weather('clear');
    t.unhurt = true;
    // (Until a courier rides by: traffic comes at random.)
    let c = t.courier();
    for (let i = 0; !c && i < 30; i++) { await t.wait(1); c = t.courier(i >= 10); }
    if (!t.check('a courier in traffic', !!c)) return;
    const car = await t.drive('hatch');
    car.x = c!.x - Math.cos(c!.h) * 10;
    car.y = c!.y - Math.sin(c!.h) * 10;
    car.h = c!.h;
    t.push(70, undefined, car);
    await t.wait(2);
    t.check('the rider is off the bike', !c!.rider && c!.mode === 'loose', `mode ${c!.mode}`);
    t.check('the bike has lost its box', !c!.courier);
    t.check('the bag lies near the bike', t.bags().lying.length === 1);
    t.unhurt = false;
  },
} satisfies Scenario;
