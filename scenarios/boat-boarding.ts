import type { Scenario } from '../src/testkit.ts';

export default {
  title: 'Moored pedal boats can be boarded and left from low, clear banks',
  async run(t) {
    t.exit();
    t.time('14:00');
    t.weather('clear');
    await t.go([50.0792, 14.4135]);
    await t.wait(30);
    const moored = t.boats().filter(b => b.moored);
    if (!t.check('three boats waiting at reachable banks', moored.length === 3 && moored.every(b => b.bank), `${moored.length} moored`)) return;
    for (const [i, b] of moored.entries()) {
      t.check(`boat ${i + 1}: bank at deck height`, Math.abs(b.bankHeight! - b.waterHeight - 0.4) <= 0.8,
        `bank ${b.bankHeight}, water ${b.waterHeight}`);
      await t.go(b.bank!);
      if (!t.check(`boat ${i + 1}: normal interaction boards`, t.boardBoat())) continue;
      t.exit();
      t.check(`boat ${i + 1}: normal interaction exits`, t.where().mode === 'foot');
    }
  },
} satisfies Scenario;
