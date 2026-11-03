import type { Scenario } from '../src/testkit.ts';

// Divadelní goes under a deck by the National Theatre. Its tunnel level starts some
// 12 m before the deck, where the ground beside is barely above the road: walking
// there once opened the earth-coloured hole round you as if you'd dropped underground.
export default {
  title: 'Walking into an underpass: open sky at its mouth, the hole only under the deck',
  async run(t) {
    await t.go([50.08108, 14.41381], { heading: 0 }); // Divadelní, south of the underpass
    t.time('14:00');
    t.weather('clear');
    const g = (globalThis as unknown as { __drive: any }).__drive; // eslint-disable-line @typescript-eslint/no-explicit-any
    const w = g.world, me = g.walker;
    let mouth: string | null = null, deck: string | null = null;
    for (let i = 0; i < 24 && !deck; i++) {
      await t.wait(0.5, { move: 1 });
      const at = `level ${me.level}, you ${me.gz.toFixed(1)} m, ground ${w.terrainAt(me.x, me.y).toFixed(1)} m, ${t.where().lat}, ${t.where().lon}`;
      if (me.level < 0 && !mouth) {
        mouth = at;
        t.check('in the mouth, not underground', !w.buried(me) && !w.covered(me), at);
      }
      if (me.level < 0 && w.terrainAt(me.x, me.y) - me.gz > 2) {
        deck = at;
        t.check('under the deck, underground', w.buried(me), at);
      }
    }
    t.check('you walked into the tunnel level', !!mouth, mouth ?? t.where());
    t.check('you walked on under the deck', !!deck, deck ?? t.where());
  },
} satisfies Scenario;
