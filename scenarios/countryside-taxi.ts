import type { Scenario } from '../src/testkit.ts';

// Zdibsko, 600 m north of the map's edge. Needs the game opened with ?countryside:
//   node scripts/scene.mjs run countryside-taxi --extra "&countryside"
export default {
  title: 'A taxi ordered out in the countryside drives you back into the map',
  async run(t) {
    if (!t.countryside()) {
      t.check('skipped: the countryside past the map is off (open the game with ?countryside)', true);
      return;
    }
    t.time('14:00');
    t.weather('clear');
    await t.go([50.18257, 14.4403]);
    t.set({ money: 5000, stars: 0 });
    await t.wait(3);
    t.check('a taxi is on its way', t.orderTaxi().state === 'coming', t.taxi());
    let waited = 0;
    for (; waited < 120 && !t.taxi().near; waited += 2) await t.wait(2);
    t.check('it comes to you on the countryside\'s roads', t.taxi().near, { waited, ...t.taxi() });
    t.check('you get in', t.boardTaxi() && t.taxi().state === 'riding', t.taxi());
    t.taxiTo(9); // Letná, 9 km south
    const from = t.where();
    let rode = 0;
    for (; rode < 240 && t.where().lat > 50.1765; rode += 5) await t.wait(5);
    const now = t.where();
    t.check('the taxi sets off for town', t.taxi().state === 'riding' && t.taxi().to === 8, t.taxi());
    t.check('and drives back into the map', now.lat < 50.1765, { from: from.lat, now: now.lat, rode });
    await t.shot('countryside-taxi');
  },
} satisfies Scenario;
