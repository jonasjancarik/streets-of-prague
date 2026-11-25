import type { Scenario } from '../src/testkit.ts';
import type { TileWorld } from '../src/tiles.ts';

// Streets players reported they couldn't drive through (November 2026):
// - the Strahov tunnel from Smíchov ended in a ramp of 103 % under Strahov, where each
//   tube's halves met (tunnels with every portal known are now solved like bridges,
//   TUNNELS_HARMONIC in pipeline/structures.py);
// - Wilsonova by the main station ran over the hall, a building on the ground and so
//   solid across its six lanes (on_roof in pipeline/osm_area.py);
// - Wilsonova's viaduct, falling 10 m to Bulhar, stood there as a slab 5 m over its
//   carriageways, on a level of its own, with the trams laid on its top (OUTLINE_ALONG in
//   pipeline/structures.py). Cars drove under it, so this is checked by the heights there.
// - a floor -1 corridor inside the station opened a furnished passage on Wilsonova.
type Line = [number, number][];
const STRAHOV_NORTH: Line = [[50.072639, 14.39838], [50.072955, 14.398168], [50.073192, 14.397933], [50.073405, 14.39767],
  [50.073672, 14.397171], [50.073938, 14.39652], [50.074255, 14.395703], [50.074579, 14.394972], [50.07491, 14.394379],
  [50.075324, 14.393747], [50.075613, 14.393357], [50.076086, 14.392695], [50.077195, 14.391217], [50.078675, 14.389229],
  [50.082945, 14.383561], [50.08327, 14.383111], [50.083679, 14.38263], [50.08405, 14.382261], [50.084367, 14.382005],
  [50.084847, 14.381723], [50.085309, 14.381495], [50.085784, 14.381294], [50.086311, 14.381149], [50.086664, 14.381108]];
const STRAHOV_SOUTH: Line = [[50.08792, 14.38101], [50.08726, 14.38093], [50.08664, 14.380926], [50.08632, 14.380951], [50.085658, 14.38103], [50.085254, 14.381114],
  [50.084791, 14.381289], [50.084206, 14.381608], [50.083851, 14.381903], [50.08347, 14.382275], [50.083035, 14.382775],
  [50.082446, 14.383558], [50.082169, 14.383928], [50.077541, 14.390118], [50.076234, 14.391863], [50.07542, 14.392988],
  [50.075107, 14.393457], [50.074745, 14.39416], [50.074443, 14.394868], [50.073637, 14.396769], [50.073459, 14.397158],
  [50.073241, 14.397561]];
const WILSONOVA_SOUTH: Line = [[50.085016, 14.436091], [50.084785, 14.435896], [50.084417, 14.435595], [50.084108, 14.435334],
  [50.08393, 14.435203], [50.083479, 14.434874], [50.083342, 14.434778], [50.083268, 14.434726], [50.082872, 14.434447]];
const WILSONOVA_NORTH: Line = [[50.082701, 14.434502], [50.083137, 14.434811], [50.083299, 14.434927], [50.083474, 14.43505],
  [50.083827, 14.435302], [50.083887, 14.435345], [50.084175, 14.435556], [50.084605, 14.435898], [50.084973, 14.43621]];
// Across both carriageways at Bulhar, where the viaduct comes down to the junction.
const BULHAR: [number, number][] = [[50.0904, 14.43758], [50.0904, 14.43772], [50.09081, 14.43758], [50.09081, 14.43772],
  [50.09112, 14.43758], [50.09112, 14.43772]];

// The compass heading from one point to the next.
const heading = (a: [number, number], b: [number, number]) =>
  (450 - Math.atan2((b[0] - a[0]) * 111320, (b[1] - a[1]) * 71500) * 180 / Math.PI) % 360;

export default {
  title: 'Cars get through the Strahov tunnel and along Wilsonova past the main station; no slab at Bulhar',
  async run(t) {
    t.time('11:00');
    t.weather('clear');
    for (const [name, line] of [['Strahov tunnel northbound', STRAHOV_NORTH], ['Strahov tunnel southbound', STRAHOV_SOUTH],
      ['Wilsonova southbound by the station', WILSONOVA_SOUTH], ['Wilsonova northbound by the station', WILSONOVA_NORTH]] as const) {
      await t.go(line[0], { heading: heading(line[0], line[1]) });
      if (line === WILSONOVA_NORTH) {
        // Above the middle of the basement corridor (OSM way 1295991727).
        const xy = t.toLocal([50.08278065, 14.43453461]);
        const { world } = window.__drive as { world: TileWorld };
        t.check('Wilsonova is open to the sky above the station corridor', !world.passageAt(...xy));
      }
      t.empty(); // nothing to run into on the way
      try {
        await t.drive('sedan');
      } catch (e) {
        t.check(`${name}: the car gets to the end`, false, String(e instanceof Error ? e.message : e));
        continue;
      }
      const got = await t.follow([...line], 50);
      const { lat, lon } = t.where();
      t.check(`${name}: the car gets to the end`, got.arrived, `stopped at ${lat}, ${lon} after ${got.seconds} s, strayed ${got.strayed} m`);
    }
    // Nothing more than 3 m over the carriageways at Bulhar: the viaduct's decks there are
    // its carriageways' height (on the map of 16 November a slab at 202.5 m lay over them
    // at 195-198 m).
    await t.go(BULHAR[2]);
    await t.wait(1);
    const over = BULHAR.map((p) => {
      const decks = Object.entries(t.heights(p)).filter(([l]) => +l > 0).map(([, h]) => h);
      return decks.length ? Math.max(...decks) - Math.min(...decks) : 0;
    });
    t.check('Wilsonova at Bulhar: no slab over the carriageways', Math.max(...over) < 3,
      `decks over each other by up to ${Math.max(...over).toFixed(1)} m`);
  },
} satisfies Scenario;
