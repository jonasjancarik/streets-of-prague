import type { Scenario } from '../src/testkit.ts';
import type { Police, Officer } from '../src/police.ts';

// A player wrote (3 Nov) that being caught was far too quick, and that the police came
// for them over things no officer had seen ("cameras?"). Now a crime nobody from the
// police saw is phoned in some seconds later and they go to where it happened, not to
// you; and an officer has to keep hold of you for a moment, which you can run out of.
export default {
  title: 'Police: an unseen crime is phoned in later, to where it was; an arrest takes a moment and you can run from it',
  async run(t) {
    await t.go('karlak', { heading: 0 });
    t.time('14:00');
    t.weather('clear');
    t.set({ stars: 0 });
    t.empty();
    const g = window.__drive as { police: Police; walker: { x: number; y: number; h: number } };
    const P = g.police, w = g.walker;

    // Nobody from the police about: the crime is only phoned in.
    if (!t.check('no police in sight', !P.sees(w.x, w.y), 'a patrol is near')) return;
    const at = { x: w.x, y: w.y };
    P.crime('stealCop', at.x, at.y);
    t.check('no stars at once for a crime they didn’t see', P.heat === 0 && P.reports.length === 1, { heat: P.heat, reports: P.reports.length });
    // Gone well away before the call comes in (not with t.go, which the police take as
    // a dev teleport and forget the chase).
    const grid = (window.__drive as { grid: { at: (x: number, y: number) => number } }).grid;
    const away = Array.from({ length: 72 }, (_, i) => [at.x + Math.cos(i * 0.35) * (180 + i), at.y + Math.sin(i * 0.35) * (180 + i)]).find(([x, y]) => grid.at(x, y) === 0);
    if (!t.check('somewhere to go', !!away)) return;
    [w.x, w.y] = away!;
    await t.wait(12);
    t.check('phoned in some seconds later', t.probe().stars === 1, t.probe().stars);
    const known = P.known ?? [NaN, NaN];
    t.check('they go to where it happened, not to you', Math.hypot(known[0] - at.x, known[1] - at.y) < 1 && Math.hypot(w.x - at.x, w.y - at.y) > 150,
      { off: Math.round(Math.hypot(known[0] - at.x, known[1] - at.y)), youFromIt: Math.round(Math.hypot(w.x - at.x, w.y - at.y)) });
    let lost = false;
    for (let i = 0; i < 40 && !lost; i++) { await t.wait(1); lost = t.probe().stars === 0 || P.sees(w.x, w.y); }
    t.check('out of their sight, the star goes', t.probe().stars === 0, { stars: t.probe().stars, seen: P.seen });

    // Caught on foot: a moment's hold before it's an arrest.
    const grab = async () => {
      t.set({ stars: 0 });
      await t.go('karlak', { heading: 0 });
      t.set({ stars: 1 });
      for (let i = 0; i < 30 && !P.cars.length; i++) await t.wait(0.5);
      const car = P.cars[0]?.car;
      if (!car) return null;
      P.getOut(car);
      const o = P.officers[P.officers.length - 1] as Officer;
      o.x = w.x - Math.cos(w.h) * 0.6;
      o.y = w.y - Math.sin(w.h) * 0.6;
      return o;
    };
    // (Scenarios can't be arrested unless they say so.)
    const kit = t as unknown as { unarrested: boolean };
    kit.unarrested = false;
    try {
      let o = await grab();
      if (!t.check('an officer at your back', !!o)) return;
      // Facing the way with the most room to run.
      const room = (h: number) => { let d = 0; while (d < 30 && grid.at(w.x + Math.cos(h) * d, w.y + Math.sin(h) * d) === 0) d += 0.5; return d; };
      w.h = Array.from({ length: 16 }, (_, i) => i * Math.PI / 8).sort((a, b) => room(b) - room(a))[0];
      o!.x = w.x - Math.cos(w.h) * 0.6;
      o!.y = w.y - Math.sin(w.h) * 0.6;
      const start = [w.x, w.y];
      await t.wait(3, { move: 1, run: true });
      const ran = Math.round(Math.hypot(w.x - start[0], w.y - start[1]));
      t.check('running, you break away', !t.arrested() && ran > 12, { arrested: t.arrested(), ran, gap: Math.round(Math.hypot(o!.x - w.x, o!.y - w.y)) });

      o = await grab();
      if (!t.check('another officer at your back', !!o)) return;
      await t.wait(0.6);
      t.check('not busted the instant they touch you', !t.arrested(), t.arrested());
      await t.wait(1.5);
      t.check('held for a moment, you are', !!t.arrested(), t.arrested());
      for (let i = 0; i < 40 && t.arrested(); i++) await t.wait(1);
      await t.settled();
    } finally {
      kit.unarrested = true;
      t.set({ stars: 0 });
      t.empty(false);
    }
  },
} satisfies Scenario;
