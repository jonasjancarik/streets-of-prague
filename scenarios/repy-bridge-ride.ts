import type { Scenario } from '../src/testkit.ts';

// The D0 (Pražský okruh) over its slip road at Řepy: both carriageways and the slip road
// onto the south-west one, driven at motorway speed over the twin bridges. The decks were
// narrower than the road and offset from it, and at the north-east end the ground between
// the carriageways sank into a pit with walls round it (November 2026).
const RIDES: { name: string; from: [number, number]; heading: number; to: [number, number] }[] = [
  { name: 'north-east', from: [50.07278, 14.28786], heading: 35, to: [50.07513, 14.28994] },
  { name: 'south-west', from: [50.07521, 14.28976], heading: 215, to: [50.07279, 14.2876] },
  { name: 'slip road', from: [50.07527, 14.28961], heading: 210, to: [50.07314, 14.28794] },
];

export default {
  title: 'Driving over the Řepy bridges on the D0 is a smooth ride',
  async run(t) {
    t.time('13:00');
    t.weather('clear');
    for (const ride of RIDES) {
      await t.go(ride.from, { heading: ride.heading });
      t.empty();
      await t.drive('sedan');
      const { lat, lon } = t.where();
      const way = t.route([lat, lon], ride.to);
      if (!t.check(`${ride.name}: a way over the bridge`, !!way, `from ${lat}, ${lon}`)) continue;
      const got = await t.follow(way!.line, 80);
      t.check(`${ride.name}: gets there`, got.arrived && got.strayed < 4, JSON.stringify(got));
      // A sharper change than this over 7 m at 80 km/h is a step or a kink a driver feels.
      t.check(`${ride.name}: no kink in the road`, got.kink < 0.15, `${got.kink} m at ${got.kinkAt}`);
    }
  },
} satisfies Scenario;
