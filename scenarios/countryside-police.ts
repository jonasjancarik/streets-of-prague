import type { Scenario } from '../src/testkit.ts';

// Zdibsko, 600 m north of the map's edge. Needs the game opened with ?countryside:
//   node scripts/scene.mjs run countryside-police --extra "&countryside"
export default {
  title: 'Two stars bring police cars after you out in the countryside too',
  async run(t) {
    if (!t.countryside()) {
      t.check('skipped: the countryside past the map is off (open the game with ?countryside)', true);
      return;
    }
    await t.go([50.18257, 14.4403]);
    t.time('14:00');
    t.weather('clear');
    t.set({ stars: 0 });
    await t.wait(1);
    t.check('no police to start with', t.probe().police === 0);
    t.set({ stars: 2 });
    await t.wait(20);
    const p = t.probe();
    t.check('police cars are after you', p.police > 0, `${p.police} cars`);
    t.check('still wanted', p.stars >= 1, `${p.stars} stars`);
    const car = t.policeCar(), me = t.where();
    t.check('one of them is out here with you', !!car && Math.hypot(car.x - me.x, car.y - me.y) < 400, car && Math.round(Math.hypot(car.x - me.x, car.y - me.y)));
    t.set({ stars: 0 });
  },
} satisfies Scenario;
