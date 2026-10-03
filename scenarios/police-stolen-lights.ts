import type { Scenario } from '../src/testkit.ts';

export default {
  title: 'A stolen police car keeps flashing when stopped and entered again',
  async run(t) {
    await t.go('karlak');
    t.time('22:00');
    t.weather('clear');
    const unhurt = t.unhurt, paused = t.paused;
    t.unhurt = true;
    t.paused = true;
    try {
      t.set({ stars: 2 });
      await t.wait(3);
      const c = t.policeCar();
      if (!t.check('a real police car arrived', !!c)) return;
      await t.enter(c!);
      t.push(0);
      t.check('lights on immediately while stopped', t.policeLights(c!));
      const { lat, lon } = t.where();
      await t.camera({ at: [lat, lon], height: 18, tilt: 20, heading: 0 });
      await t.shot('police-stolen-stopped');
      t.push(20);
      t.check('lights on moving forward', t.policeLights(c!));
      t.push(-10);
      t.check('lights on reversing', t.policeLights(c!));
      t.push(0);
      t.exit();
      t.check('lights off after leaving it', !t.policeLights(c!));
      const stars = t.probe().stars;
      await t.enter(c!);
      t.check('lights return on re-entry', t.policeLights(c!));
      t.check('re-entry is not a second theft', t.probe().stars === stars);
      t.forgive();
      t.check('stand-down preserves player lights', t.policeLights(c!));
      t.exit();
      t.check('abandoned stolen car has no lights', !t.policeLights(c!));
    } finally {
      t.unhurt = unhurt;
      t.paused = paused;
      await t.camera(null);
    }
  },
} satisfies Scenario;
