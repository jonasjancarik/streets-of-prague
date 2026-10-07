import type { Scenario } from '../src/testkit.ts';

export default {
  title: 'Getting out of a car on a bridge leaves you on its deck',
  async run(t) {
    // Onto most Legií from the National Theatre, as far as over Střelecký ostrov,
    // where the ground is a park well below the deck.
    await t.go([50.08135, 14.4142]);
    t.time('14:00');
    t.weather('clear');
    t.empty(); // nothing to run into on the way
    const c = await t.drive('sedan');
    // Steered for the deck: first a spot in the lane south of the tram tracks just past the
    // bridge head, then one over the island. (A fixed heading of 264 from here aims 2 m
    // south of where the deck begins, at the quay wall beside it: the car got onto the
    // bridge only when knocks on the way had shifted it north.)
    const head: [number, number] = [50.08131, 14.41265], island: [number, number] = [50.08129, 14.41048];
    const towards = (to: [number, number]) => {
      const { lat, lon } = t.where();
      return (450 - Math.atan2((to[0] - lat) * 111320, (to[1] - lon) * 71500) * 180 / Math.PI) % 360;
    };
    // Scrapes and a tram in the way are not held against the car: it has to get there in
    // one piece (pushed into a tram for long, it would blow up).
    for (let i = 0; i < 120 && t.where().lon > 14.4106; i++) {
      c.damage = 0;
      t.push(50, towards(t.where().lon > head[1] + 0.00015 ? head : island));
      await t.wait(1);
    }
    c.damage = 0;
    t.push(0);
    await t.wait(0.5);
    if (!t.check('the car is on the bridge', (c.level ?? 0) > 0, `level ${c.level} at ${t.where().lat}, ${t.where().lon}, heading ${t.where().heading}, ${t.vehicleGap()} m to the nearest vehicle`)) return;
    const deck = c.gz ?? 0;
    const { walker, enterOrExit } = (globalThis as unknown as { __drive: { walker: { gz?: number }; enterOrExit: () => void } }).__drive;
    enterOrExit();
    await t.wait(0.5);
    t.check('you are on foot', t.where().mode === 'foot', t.where().mode);
    t.check('you stand on the deck', Math.abs((walker.gz ?? 0) - deck) < 0.5, `deck ${deck.toFixed(1)} m, you ${(walker.gz ?? 0).toFixed(1)} m`);
    await t.shot('bridge-exit');
  },
} satisfies Scenario;
