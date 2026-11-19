import type { Scenario } from '../src/testkit.ts';
import type { Police } from '../src/police.ts';

// A player wrote (19 Nov) that in an ambulance or a fire engine the police should leave
// you be, and that the blue lights should go on and off. Now X goes lights, lights and
// siren, off; and in a fire engine or an ambulance the carjack's star goes faster, and
// while you're not wanted speeding is let go and a crash counts for less.
export default {
  title: 'Ambulance and fire engine: blue lights on X; the police go easier on you',
  async run(t) {
    t.time('14:00');
    t.weather('clear');
    const g = window.__drive as { police: Police; car: import('../src/car.ts').Car | null };
    const P = g.police;
    const sees = P.sees;
    const unhurt = t.unhurt;
    t.unhurt = true;
    try {
      for (const type of ['ambulance', 'fire'] as const) {
        t.exit();
        await t.go('staromak', { heading: 0 });
        t.empty();
        await t.drive(type);
        const c = g.car!;
        t.set({ stars: 0 });
        P.heat = 0;
        t.check(`${type}: lights on when you take it`, t.policeLights(c));
        t.check(`${type}: X adds the siren`, t.beacon() === 'siren' && t.policeLights(c));
        t.check(`${type}: X again turns them off`, t.beacon() === 'off' && !t.policeLights(c));
        t.check(`${type}: and on again`, t.beacon() === 'lights' && t.policeLights(c));

        // Speeding past the police, who see everything for this.
        P.sees = () => true;
        t.push(110, 0);
        for (let i = 0; i < 8; i++) { await t.wait(0.5); t.push(110); }
        t.check(`${type}: speeding is let go while not wanted`, P.heat === 0, P.heat);
        t.push(0);

        // A wreck they see counts for much less.
        P.crime('wreck', c.x, c.y);
        t.check(`${type}: a crash counts for less`, P.heat > 0 && P.heat < 0.5 && t.probe().stars === 0, P.heat);
        const was = P.heat;
        await t.wait(2);
        t.check(`${type}: and drains away`, P.heat < was, { was, now: P.heat });

        // The carjack's star, out of sight, goes in about a third of the time.
        P.heat = 0;
        P.crime('carjack', c.x, c.y);
        t.check(`${type}: the carjack still gets a star`, t.probe().stars === 1);
        P.sees = () => false;
        let s = 0;
        while (t.probe().stars > 0 && s < 12) { await t.wait(0.5); s += 0.5; }
        t.check(`${type}: the star goes within 5 s out of sight`, t.probe().stars === 0 && s <= 5, s);
        P.sees = sees;
        t.exit();
      }

      // An ordinary car gets none of it.
      await t.go('staromak', { heading: 0 });
      t.empty();
      await t.drive('hatch');
      t.set({ stars: 0 });
      P.heat = 0;
      P.sees = () => true;
      t.push(110, 0);
      for (let i = 0; i < 8; i++) { await t.wait(0.5); t.push(110); }
      t.check('hatch: speeding still gets a star', t.probe().stars === 1, P.heat);
    } finally {
      P.sees = sees;
      t.unhurt = unhurt;
      t.set({ stars: 0 });
    }
  },
} satisfies Scenario;
