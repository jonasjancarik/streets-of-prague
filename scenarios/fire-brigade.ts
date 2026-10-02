import type { Scenario } from '../src/testkit.ts';

export default {
  title: 'The fire brigade gets to a burning car in time, and to the wreck of your own',
  async run(t) {
    t.exit();
    await t.go('ujezd', { heading: 180 });
    t.time('14:00');
    t.weather('clear');
    t.unhurt = true;
    try {
      // A parked car: it burns for a minute or so, and is put out before it blows up.
      const parked = t.car('hatch', { ahead: 12 });
      t.ignite(parked);
      await t.wait(0.1);
      let s = 0, arrived = -1;
      for (; s < 100 && t.fire(parked).burning; s++) {
        await t.wait(1);
        if (arrived < 0 && t.fire(parked).engine === 'work') arrived = s;
      }
      t.check('an engine got to the parked car', arrived >= 0, `after ${arrived} s`);
      t.check('the fire was put out before the car blew up', !t.fire(parked).wreck && !t.fire(parked).burning, `after ${s} s`);

      // Your own car blows up in a few seconds: the wreck stays in flames until the engine's cannon has put them out and the crew finishes the smouldering.
      await t.go('ujezd', { heading: 180 });
      await t.wait(2);
      const own = await t.drive('sedan');
      t.ignite(own);
      await t.wait(0.5);
      t.exit();
      let sprayed = false, cannon = false;
      for (s = 0; s < 100; s++) {
        await t.wait(1, { move: s < 5 ? 1 : 0, run: true });
        cannon ||= t.fire(own).cannon;
        sprayed = t.fire(own).wreck && t.fire(own).spraying > 0;
        if (sprayed) break;
      }
      if (sprayed) await t.shot('fire-brigade');
      t.check('the car blew up', t.fire(own).wreck);
      t.check('the engine put the flames out with its own cannon', cannon);
      t.check('the crew finished off the smouldering wreck with their hoses', sprayed, `after ${s} s`);
    } finally {
      t.unhurt = false;
    }
  },
} satisfies Scenario;
