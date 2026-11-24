import type { Scenario } from '../src/testkit.ts';

export default {
  title: 'People wait at the tram stops by Anděl and get on and off the trams that stop there',
  async run(t) {
    t.time('08:00');
    t.weather('clear');
    await t.go([50.07090, 14.40350], { heading: 0 });
    for (let i = 0; i < 40 && !t.stopWaiting('tram').some((q) => q.waiting > 1); i++) await t.frames();
    const queues = t.stopWaiting('tram');
    const waiting = queues.reduce((n, q) => n + q.waiting, 0);
    if (!t.check('people wait at the tram stops near you', waiting >= 3, `${waiting} at ${queues.length} stops`)) return;
    const before = t.busPassengers('tram');
    let now = before, shot = false;
    // (Trams come every few minutes on each of Anděl's lines.)
    for (let k = 0; k < 90; k++) {
      await t.wait(2);
      await t.frames();
      now = t.busPassengers('tram');
      const q = !shot && t.stopWaiting('tram').find((o) => o.vehicle && o.boarding > 0);
      if (q) {
        shot = true;
        await t.camera({ at: q.at, height: 18, tilt: 50, heading: 0 });
        for (let i = 0; i < 6; i++) await t.frames();
        await t.shot('tram-stop-boarding');
        await t.camera(null);
      }
      if (shot && now.boarded > before.boarded && now.alighted > before.alighted) break;
    }
    t.check('people get off the trams', now.alighted > before.alighted, `${now.alighted - before.alighted} got off`);
    t.check('people waiting get on', now.boarded > before.boarded, `${now.boarded - before.boarded} got on`);
  },
} satisfies Scenario;
