import type { Scenario } from '../src/testkit.ts';

// The trailer went from a chase at 01:30 to a tram shot at 19:00 and found a night tram
// (98) on Národní: trams only joined and left one by one out of sight, so after the clock
// jumped the night lines kept running. The start screen's time, a night in the cells and
// the developer panel's clock all jump it the same way.
const night = (out: Record<string, number>) => Object.entries(out).filter(([ref]) => /^9\d$/.test(ref)).reduce((n, [, k]) => n + k, 0);
const day = (out: Record<string, number>) => Object.entries(out).filter(([ref]) => !/^9\d$/.test(ref)).reduce((n, [, k]) => n + k, 0);

export default {
  title: 'Trams follow the timetable after the clock jumps',
  async run(t) {
    await t.go([50.0814, 14.4135]); // Národní divadlo
    t.time('01:30');
    await t.wait(1);
    const late = t.tramsOut();
    t.check('night trams run at 01:30', night(late) > 0, JSON.stringify(late));
    t.time('19:00');
    await t.wait(1);
    const evening = t.tramsOut();
    t.check('no night trams at 19:00', night(evening) === 0, JSON.stringify(evening));
    t.check('day trams run at 19:00', day(evening) > night(late), JSON.stringify(evening));
  },
} satisfies Scenario;
