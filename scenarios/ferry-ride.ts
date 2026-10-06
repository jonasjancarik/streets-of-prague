import type { Scenario } from '../src/testkit.ts';

export default {
  title: 'A PID ferry is boarded at its landing, with and without a ticket, and left on the far bank',
  async run(t) {
    t.exit();
    t.time('10:00');
    t.weather('clear');
    t.season('07-15');
    t.set({ money: 10000 });
    await t.go([50.0674, 14.4150]); // Výtoň, on P5
    await t.wait(2);
    const p5 = () => t.ferries().find(f => f.ref === 'P5');
    if (!t.check('P5 is on the map and sailing', !!p5()?.open, JSON.stringify(p5() ?? null))) return;
    const lands = async (not: number | null) => {
      for (let k = 0; k < 80 && (p5()!.stop === null || p5()!.stop === not); k++) await t.wait(5);
      return p5()!.stop;
    };
    for (const [n, paid] of [[1, false], [2, true]] as const) {
      const from = await lands(null);
      if (!t.check(`ride ${n}: the ferry comes in to a landing`, from !== null)) return;
      await t.go(p5()!.landings[from!].gate);
      if (!t.check(`ride ${n}: E at the landing boards`, t.boardFerry(), t.where().mode)) return;
      const fare = t.ticket(paid);
      // (The ticket bought aboard counts from the next look at the fare.)
      await t.wait(1);
      t.check(`ride ${n}: ${paid ? 'a ticket is held' : 'no ticket: time to buy one'}`, paid ? fare.held && fare.fare === null : fare.fare === 'grace' && !fare.held, JSON.stringify(fare));
      const to = await lands(from);
      t.check(`ride ${n}: it crosses to another landing`, to !== null && to !== from, `from ${from} to ${to}`);
      if (n === 2) await t.shot('ferry-ride');
      t.exit();
      const me = t.where(), gate = p5()!.landings[to ?? 0].gate;
      const far = Math.hypot((me.lat - gate[0]) * 111200, (me.lon - gate[1]) * 71500);
      t.check(`ride ${n}: E puts you on the bank by that landing`, me.mode === 'foot' && far < 40, `${me.mode}, ${far.toFixed(0)} m from the gate`);
    }
  },
} satisfies Scenario;
