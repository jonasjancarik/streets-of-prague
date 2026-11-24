import type { Scenario } from '../src/testkit.ts';

export default {
  title: 'You drive a bus to a stop by Anděl, open its doors, and people get on and off',
  async run(t) {
    t.time('08:00');
    t.weather('clear');
    await t.go([50.07153, 14.40276], { heading: 0 });
    const car = await t.drive('bus');
    for (let i = 0; i < 40 && !t.busWaiting().some((q) => q.waiting > 1); i++) await t.frames();
    // (The bus takes the line of someone waiting at the nearest stop, so they have one to get on.)
    const stop = t.pullUp();
    if (!t.check('the bus pulls up by a stop', stop !== null)) return;
    await t.frames();
    const q = [...t.busWaiting()].sort((a, b) => a.away - b.away)[0];
    const lines = t.busLines().map((l) => l.ref);
    const ref = q?.people.map((p) => p.ref).find((l) => lines.includes(l)) ?? q?.lines.find((l) => lines.includes(l));
    if (!t.check('the stop has a line to drive', !!ref, `${stop}: ${q?.lines.join(', ')}`)) return;
    t.busLine(car, ref!);

    const before = t.busPassengers();
    const opened = t.busDoors();
    if (!t.check('the doors open at the stop', opened.open, `by ${opened.stop}`)) return;
    await t.wait(1);
    await t.camera({ at: t.where(), height: 26, tilt: 0 });
    for (let i = 0; i < 4; i++) await t.frames();
    await t.shot('bus-doors-open');
    await t.camera(null);
    // The bus holds still with the doors open, even with the pedal down.
    const at = t.where();
    await t.wait(1.5, { move: 1 });
    const moved = Math.hypot((t.where().lat - at.lat) * 111226, (t.where().lon - at.lon) * 71500);
    t.check('it can\'t drive off with the doors open', moved < 0.3, `${moved.toFixed(2)} m`);
    let now = before;
    for (let k = 0; k < 30 && t.busStand().open; k++) {
      await t.wait(1);
      now = t.busPassengers();
    }
    now = t.busPassengers();
    t.check('people get off', now.alighted > before.alighted, `${now.alighted - before.alighted} got off`);
    t.check(`people waiting for the ${ref} get on`, now.boarded > before.boarded, `${now.boarded - before.boarded} got on`);
    t.check('the doors shut by themselves', !t.busStand().open);
  },
} satisfies Scenario;
