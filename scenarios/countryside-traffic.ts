import type { Scenario } from '../src/testkit.ts';

// A village 5 km west of the map's edge (50.0, 14.15): lanes among houses, a tenth of
// the street a city district has (streetShare in src/network.ts). Needs the game opened with ?countryside:
//   node scripts/scene.mjs run countryside-traffic --extra "&countryside"
const VILLAGE: [number, number] = [50.0, 14.15], FIELDS: [number, number] = [50.185, 14.4];

export default {
  title: 'Past the map the traffic is as thin as the roads',
  async run(t) {
    if (!t.countryside()) {
      t.check('skipped: the countryside past the map is off (open the game with ?countryside)', true);
      return;
    }
    t.time('16:00'); // the busiest hour
    t.weather('clear');
    await t.go('karlak');
    await t.wait(20);
    const town = t.probe();
    t.check('the city has its rush-hour traffic', town.traffic >= 30, town.traffic);

    await t.go(VILLAGE);
    await t.wait(40);
    const out = t.probe();
    t.check('there is some traffic in the village', out.traffic >= 1, out.traffic);
    t.check('and far less than in town', out.traffic <= 10, { town: town.traffic, village: out.traffic });
    t.check('few people are about', out.people <= 45, out.people);
    t.check('the village\'s name came up as the title', !!out.place && out.place !== town.place, { town: town.place, village: out.place });

    // A lane between fields, 2 km north-west of the map: next to nobody.
    await t.go(FIELDS);
    await t.wait(40);
    const fields = t.probe();
    t.check('next to no traffic among the fields', fields.traffic <= 3, fields.traffic);
    t.check('and next to nobody on foot', fields.people <= 12, fields.people);
    await t.camera({ at: FIELDS, height: 260, tilt: 30, heading: 0 });
    await t.wait(1);
    await t.shot('countryside-traffic');
    await t.camera(null);
  },
} satisfies Scenario;
