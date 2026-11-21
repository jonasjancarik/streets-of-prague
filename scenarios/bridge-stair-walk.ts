import type { Scenario } from '../src/testkit.ts';
import type { TileWorld } from '../src/tiles.ts';
import type { Walker } from '../src/people.ts';
import type { Point2 } from '../src/map/geo.ts';

export default {
  title: 'Descend to the sidewalk beneath Štefánikův most and climb the opposite stairs',
  async run(t) {
    await t.go('letna');
    t.time('14:00');
    t.weather('clear');
    const { world, walker: w } = window.__drive as { world: TileWorld; walker: Walker };
    const ways = world.tileAt(w.x, w.y)?.source.t.walk ?? [];
    const chain = [
      '1548698446',
      '3426549810',
      '3426549811',
      '3426549813',
      '1548698464',
      '1238413407',
      '3426549812',
      '354686149',
      '3426549809',
      '3426549808',
    ];
    const route: Point2[] = [];
    for (let i = 1; i < chain.length; i++) {
      const a = chain[i - 1], b = chain[i];
      const way = ways.find((e) => (e.u === a && e.v === b) || (e.u === b && e.v === a));
      if (!way) {
        t.check('the stairway connects to the lower sidewalk', false, a + ' to ' + b);
        return;
      }
      const points = way.u === a ? way.pts : [...way.pts].reverse();
      route.push(...points.slice(i === 1 ? 0 : 1));
    }
    const restore = t.eyes;
    t.eyes = { yaw: 0, pitch: -3 };
    let lowest = Infinity, clearance = 0, walked = 0, blocked = false;
    try {
      for (const [x, y] of route) {
        for (let tick = 0; Math.hypot(x - w.x, y - w.y) > .55; tick++) {
          if (tick > 125) {
            blocked = true;
            break;
          }
          w.h = Math.atan2(y - w.y, x - w.x);
          const px = w.x, py = w.y;
          await t.wait(.11, { move: 1 });
          if (w.level !== 0) {
            t.check('the walker stays below the carriageway', false, { position: t.where(), level: w.level });
            return;
          }
          walked += Math.hypot(w.x - px, w.y - py);
          lowest = Math.min(lowest, w.gz ?? Infinity);
          const deck = world.levelAt(w.x, w.y, 2);
          if (Number.isFinite(deck)) clearance = Math.max(clearance, deck - (w.gz ?? 0));
        }
        if (blocked) break;
      }
      t.check('walked both flights and the whole lower sidewalk', !blocked && walked > 70, walked.toFixed(1) + ' m');
      t.check(
        'the bridge deck remains more than five metres above the pedestrian',
        clearance > 5,
        clearance.toFixed(2) + ' m',
      );
      t.check('climbed back up to the embankment', (w.gz ?? 0) - lowest > 4.5, (w.gz ?? 0) - lowest);
    } finally {
      t.eyes = restore;
    }
  },
} satisfies Scenario;
