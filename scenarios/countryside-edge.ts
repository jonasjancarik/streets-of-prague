import type { Scenario } from '../src/testkit.ts';

// Zdibsko, a main road that leaves the map to the north (the edge is at 50.1774): the
// built street runs on 400 m past it, and the countryside's own street carries on from
// there. Needs the game opened with ?countryside:
//   node scripts/scene.mjs run countryside-edge --extra "&countryside"
const INSIDE: [number, number] = [50.17695, 14.44575], JOIN: [number, number] = [50.18074, 14.44081], OUTSIDE: [number, number] = [50.18257, 14.4403];

export default {
  title: 'A car drives out of the map along a main road and back in',
  async run(t) {
    if (!t.countryside()) {
      t.check('skipped: the countryside past the map is off (open the game with ?countryside)', true);
      return;
    }
    t.time('14:00');
    t.weather('clear');
    t.empty();
    // The routes, looked for from the place where the built street ends.
    await t.go(JOIN);
    const out = t.route(INSIDE, OUTSIDE), back = t.route(OUTSIDE, INSIDE);
    t.check('a route leads out of the map', !!out && out.length > 600 && out.length < 1000, out?.length);
    t.check('a route leads back in', !!back && back.length > 600 && back.length < 1000, back?.length);
    if (!out || !back) return;

    // Into a car standing at the start of a line, facing along it.
    const start = async (line: [number, number][]) => {
      const [a, b] = line, heading = (Math.atan2((b[1] - a[1]) * Math.cos((a[0] * Math.PI) / 180), b[0] - a[0]) * 180) / Math.PI;
      t.exit();
      await t.go(a);
      await t.enter(t.car('hatch', { at: a, heading, ahead: 0 }));
    };
    await start(out.line);
    const went = await t.follow(out.line, 50);
    t.check('the car gets out to the countryside', went.arrived, went);
    t.check('the ground has no step on the way out', went.jump < 0.4, went.jump);
    t.check('the car keeps to the road on the way out', went.strayed < 6, went.strayed);
    t.check('the car is past the map\'s edge', t.where().lat > 50.182, t.where());
    await t.shot('countryside-edge-out');

    await start(back.line);
    const came = await t.follow(back.line, 50);
    t.check('the car gets back into the map', came.arrived, came);
    t.check('the ground has no step on the way back', came.jump < 0.4, came.jump);
    t.check('the car keeps to the road on the way back', came.strayed < 8, came.strayed);
    t.check('the car is inside the map again', t.where().lat < 50.1774, t.where());
  },
} satisfies Scenario;
