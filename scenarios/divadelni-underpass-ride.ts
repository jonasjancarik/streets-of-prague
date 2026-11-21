import type { Scenario } from '../src/testkit.ts';

// Divadelní runs down a cutting beside the National Theatre and under Národní. Its last
// 21 m before the underpass kept the terrain's slope up to Národní's level, a wedge across
// the road (November 2026). The surveyed kerbs put the carriageway mostly west of the
// map's line (5 m west, 2.3 m east), and so does the tunnel's outline: the drive keeps to
// the carriageway's middle there, as a driver would.
const MIDDLE_WEST = 1.4; // m west of the map's line, between 50.0809 and 50.0817

export default {
  title: 'Driving down Divadelní under Národní is a smooth ride',
  async run(t) {
    t.time('13:00');
    t.weather('clear');
    await t.go([50.08, 14.41393], { heading: 0 });
    t.empty();
    await t.drive('sedan');
    const { lat, lon } = t.where();
    const way = t.route([lat, lon], [50.0822, 14.4137]);
    if (!t.check('a way under Národní', !!way, `from ${lat}, ${lon}`)) return;
    const west = MIDDLE_WEST / (111320 * Math.cos((50.081 * Math.PI) / 180));
    const line = way!.line.map(([a, b]): [number, number] => [a, a > 50.0809 && a < 50.0817 ? b - west : b]);
    const got = await t.follow(line, 40);
    t.check('gets there', got.arrived, JSON.stringify(got));
    // A sharper change than this over 2 m at 40 km/h is a step or a kink a driver feels.
    t.check('no kink in the road', got.kink < 0.2, `${got.kink} m at ${got.kinkAt}`);
  },
} satisfies Scenario;
