import type { Scenario } from '../src/testkit.ts';

export default {
  title: 'Moored pedal boats can be boarded and left from low, clear banks',
  async run(t) {
    t.exit();
    t.time('14:00');
    t.weather('clear');
    await t.go([50.0792, 14.4135]);
    // (Boats are put out at random spots round the islands, a few tries a second: three
    // tied up within reach can take a while.)
    let moored = t.boats().filter(b => b.moored);
    for (let i = 0; i < 24 && !(moored.length === 3 && moored.every(b => b.bank)); i++) {
      await t.wait(5);
      moored = t.boats().filter(b => b.moored);
    }
    if (!t.check('three boats waiting at reachable banks', moored.length === 3 && moored.every(b => b.bank), `${moored.length} moored`)) return;
    for (const [i, b] of moored.entries()) {
      t.check(`boat ${i + 1}: bank at deck height`, Math.abs(b.bankHeight! - b.waterHeight - 0.4) <= 0.8,
        `bank ${b.bankHeight}, water ${b.waterHeight}`);
      // Where it lies now: boats bob and turn at their moorings, and from the bank of one
      // E may have taken you into its neighbour, which is then no longer tied up.
      const metres = (p: [number, number], q: [number, number]) => Math.hypot((p[0] - q[0]) * 111320, (p[1] - q[1]) * 71500);
      const now = t.boats().filter((k) => k.kind !== 'cruise' && k.bank).sort((p, q) => metres(p.at, b.at) - metres(q.at, b.at))[0];
      const bank = now && metres(now.at, b.at) < 15 ? now.bank! : b.bank!;
      await t.go(bank);
      t.stand(bank);
      if (!t.check(`boat ${i + 1}: normal interaction boards`, t.boardBoat(), `${t.where().mode}, ${Math.round(metres([t.where().lat, t.where().lon], b.at) * 10) / 10} m from where it lay, ${t.boats().filter((k) => k.moored).length} moored now`)) continue;
      t.exit();
      t.check(`boat ${i + 1}: normal interaction exits`, t.where().mode === 'foot');
    }
  },
} satisfies Scenario;
