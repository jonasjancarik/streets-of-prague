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
    // One at a time, from the boats there are now: a boat more than 700 m from you is taken
    // away and tied up again nearer (three can lie 800 m apart, and going to the first
    // then loses the third), and E may take you into the neighbour of the one you meant.
    const metres = (p: [number, number], q: [number, number]) => Math.hypot((p[0] - q[0]) * 111320, (p[1] - q[1]) * 71500);
    const done: [number, number][] = [];
    for (let i = 0; i < 3; i++) {
      const here = (): [number, number] => [t.where().lat, t.where().lon];
      const waiting = () => t.boats().filter((k) => k.moored && done.every((d) => metres(d, k.at) > 3)).sort((p, q) => metres(p.at, here()) - metres(q.at, here()));
      for (let k = 0; k < 24 && !waiting().length; k++) await t.wait(5);
      let b = waiting()[0];
      // Up to it first: from 600 m off the map under it isn't loaded, and without the
      // water and the ground there is no saying where its bank is.
      if (b) {
        await t.go(b.at);
        b = waiting()[0];
      }
      if (!t.check(`boat ${i + 1}: waiting at a reachable bank`, !!b?.bank, `${t.boats().filter((k) => k.moored).map((k) => `${Math.round(metres(k.at, here()))} m${k.bank ? '' : ' (no bank)'}`).join(', ') || 'none'} tied up, ${done.length} boarded`)) return;
      t.check(`boat ${i + 1}: bank at deck height`, Math.abs(b.bankHeight! - b.waterHeight - 0.4) <= 0.8,
        `bank ${b.bankHeight}, water ${b.waterHeight}`);
      await t.go(b.bank!);
      t.stand(b.bank!);
      const ok = t.check(`boat ${i + 1}: normal interaction boards`, t.boardBoat(), `${t.where().mode}, ${Math.round(metres(here(), b.at) * 10) / 10} m from where it lay, ${t.boats().filter((k) => k.moored).length} moored now`);
      if (!ok) { done.push(b.at); continue; }
      t.exit();
      t.check(`boat ${i + 1}: normal interaction exits`, t.where().mode === 'foot');
      // (You get out at the landing of the boat you were in, which may have been the
      // neighbour of the one you meant: that one is not tried again.)
      done.push((t.boats().find((k) => k.bank && metres(k.bank, here()) < 0.2) ?? b).at);
    }
  },
} satisfies Scenario;
