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
    // (A taxi can start on a lane with no way through to you, in town as out here: after
    // a minute and a half the player would cancel and order another, and so does this.)
    let waited = 0, orders = 1;
    for (; waited < 240 && !t.taxi().near; waited += 2) {
      await t.wait(2);
      if (waited === 90 && !t.taxi().near) { t.cancelTaxi(); t.orderTaxi(); orders++; }
    }
    if (!t.check('it comes to you on the countryside\'s roads', t.taxi().near, { waited, orders, ...t.taxi() })) return;
    if (!t.check('you get in', t.boardTaxi() && t.taxi().state === 'riding', t.taxi())) return;
    const from = t.where();
    if (!t.check('the ride starts outside the built map', !t.builtMap(), from)) return;
    t.taxiTo(9); // Letná, 9 km south
    let rode = 0;
    for (; rode < 240 && !t.builtMap(); rode += 5) await t.wait(5);
    const now = t.where();
    t.check('the taxi sets off for town', t.taxi().state === 'riding' && t.taxi().to === 8, t.taxi());
    t.check('and drives back into the map', t.builtMap(), { from, now, rode });
    await t.shot('countryside-taxi');
  },
} satisfies Scenario;
