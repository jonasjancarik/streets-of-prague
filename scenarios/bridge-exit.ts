import type { Scenario } from '../src/testkit.ts';

export default {
  title: 'Getting out of a car on a bridge leaves you on its deck',
  async run(t) {
    // Onto most Legií from the National Theatre, as far as over Střelecký ostrov,
    // where the ground is a park well below the deck.
    await t.go([50.08135, 14.4142]);
    t.time('14:00');
    t.weather('clear');
    const c = await t.drive('sedan');
    for (let i = 0; i < 40 && t.where().lon > 14.4106; i++) {
      t.push(50, 264);
      await t.wait(1);
    }
    t.push(0, 264);
    await t.wait(0.5);
    if (!t.check('the car is on the bridge', (c.level ?? 0) > 0, `level ${c.level}`)) return;
    const deck = c.gz ?? 0;
    const { walker, enterOrExit } = (globalThis as unknown as { __drive: { walker: { gz?: number }; enterOrExit: () => void } }).__drive;
    enterOrExit();
    await t.wait(0.5);
    t.check('you are on foot', t.where().mode === 'foot', t.where().mode);
    t.check('you stand on the deck', Math.abs((walker.gz ?? 0) - deck) < 0.5, `deck ${deck.toFixed(1)} m, you ${(walker.gz ?? 0).toFixed(1)} m`);
    await t.shot('bridge-exit');
  },
} satisfies Scenario;
