import type { Scenario } from '../src/testkit.ts';

export default {
  title: 'People wait for the Petřín funicular at Nebozízek and get on and off its cars',
  async run(t) {
    t.time('11:00');
    t.weather('clear');
    await t.go([50.08242, 14.40017], { heading: 270 });
    for (let i = 0; i < 40 && !t.stopWaiting('funicular').some((q) => q.waiting > 0); i++) await t.frames();
    const q = t.stopWaiting('funicular').find((o) => o.name === 'Nebozízek');
    if (!t.check('people wait at Nebozízek', !!q && q.waiting > 0, q ? `${q.waiting} waiting` : 'no station near')) return;
    const before = t.busPassengers('funicular');
    let now = before;
    // (The cars meet there every few minutes.)
    for (let k = 0; k < 300; k++) {
      await t.wait(2);
      await t.frames();
      now = t.busPassengers('funicular');
      if (now.boarded > before.boarded && now.alighted > before.alighted) break;
    }
    t.check('people get off the car', now.alighted > before.alighted, `${now.alighted - before.alighted} got off`);
    t.check('people waiting get on', now.boarded > before.boarded, `${now.boarded - before.boarded} got on`);
    // Out of hours nobody waits.
    t.time('23:30');
    for (let k = 0; k < 30 && t.stopWaiting('funicular').some((o) => o.waiting > 0); k++) { await t.wait(4); await t.frames(); }
    t.check('nobody waits after closing time', t.stopWaiting('funicular').every((o) => o.waiting === 0), `${t.stopWaiting('funicular').map((o) => o.waiting).join(', ')}`);
  },
} satisfies Scenario;
