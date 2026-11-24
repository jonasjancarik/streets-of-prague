import type { Scenario } from '../src/testkit.ts';

// Metres between two [lat, lon] points (near enough, over a few hundred metres).
const apart = (a: [number, number], b: [number, number]) =>
  Math.hypot((a[0] - b[0]) * 111226, (a[1] - b[1]) * 111226 * Math.cos((a[0] * Math.PI) / 180));

export default {
  title: 'People wait at the bus stops by Anděl and get on and off a bus',
  async run(t) {
    // (The hour first: a stop's people are counted as it comes into view.)
    t.time('08:00');
    t.weather('clear');
    await t.go([50.07153, 14.40276], { heading: 0 });
    // (The stops' signs, and the people at them, come with the frames drawn.)
    for (let i = 0; i < 40 && !t.busWaiting().some((q) => q.waiting > 1); i++) await t.frames();
    const queues = t.busWaiting();
    const waiting = queues.reduce((n, q) => n + q.waiting, 0);
    if (!t.check('people wait at the stops near you', waiting >= 2, `${waiting} at ${queues.length} stops`)) return;
    const q = [...queues].sort((a, b) => a.away - b.away)[0];
    const far = Math.max(0, ...q.people.map((p) => apart(p.at, q.at)));
    t.check('they stand round the sign', far < 14, `${q.waiting} at ${q.name}, furthest ${far.toFixed(1)} m from the sign`);
    await t.camera({ at: q.at, height: 26, tilt: 0 });
    for (let i = 0; i < 4; i++) await t.frames();
    await t.shot('bus-stop-waiting');
    await t.camera(null);

    const before = t.busPassengers();
    if (!t.check('a bus is called to the stop', t.callBus(60) !== null)) return;
    let now = before;
    for (let k = 0; k < 90; k++) {
      await t.wait(2);
      now = t.busPassengers();
      if (now.boarded > before.boarded && now.alighted > before.alighted) break;
    }
    t.check('people get off the bus', now.alighted > before.alighted, `${now.alighted - before.alighted} got off`);
    t.check('people waiting get on', now.boarded > before.boarded, `${now.boarded - before.boarded} got on`);
  },
} satisfies Scenario;
