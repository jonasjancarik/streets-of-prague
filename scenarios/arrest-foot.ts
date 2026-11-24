import type { Scenario } from '../src/testkit.ts';
import type { Police, Officer } from '../src/police.ts';

// The user wrote (23 Nov) that arrests looked bad: the officers ran to the very spot you
// stood on, stood inside you for a moment and spun round. Now they stop at arm's length,
// spread round you, face you, and the one who has you walks round you, not through you,
// to lead you off.
export default {
  title: 'Arrest on foot: officers stop at arm’s length round you, facing you, without spinning or walking through you',
  async run(t) {
    await t.go('karlak', { heading: 0 });
    t.time('14:00');
    t.weather('clear');
    t.set({ stars: 0 });
    t.empty();
    const g = window.__drive as { police: Police; walker: { x: number; y: number; h: number }; simulate: (dt: number) => void };
    const P = g.police, w = g.walker;
    const kit = t as unknown as { unarrested: boolean };
    const turn = (a: number, b: number) => Math.abs(Math.atan2(Math.sin(b - a), Math.cos(b - a)));
    const gap = (o: Officer) => Math.hypot(o.x - w.x, o.y - w.y);
    try {
      t.set({ stars: 1 });
      for (let i = 0; i < 30 && !P.cars.length; i++) await t.wait(0.5);
      const car = P.cars[0]?.car;
      if (!t.check('a police car came', !!car)) return;
      // Two officers, some metres off on two sides.
      P.getOut(car!);
      P.getOut(car!);
      const [a, b] = P.officers.slice(-2);
      const grid = (window.__drive as { grid: { at: (x: number, y: number) => number } }).grid;
      const open = Array.from({ length: 16 }, (_, i) => i * Math.PI / 8).filter((h) => [2, 4, 6, 8].every((d) => !grid.at(w.x + Math.cos(h) * d, w.y + Math.sin(h) * d)));
      if (!t.check('room round you', open.length >= 2, `${open.length} clear ways`)) return;
      const ha = open[0], hb = open.find((h) => turn(h, ha) > 1.2) ?? open[open.length - 1];
      Object.assign(a, { x: w.x + Math.cos(ha) * 7, y: w.y + Math.sin(ha) * 7 });
      Object.assign(b, { x: w.x + Math.cos(hb) * 7, y: w.y + Math.sin(hb) * 7 });

      // They come up (not arresting yet): frame by frame, how near they get and how they turn.
      kit.unarrested = true;
      t.paused = true;
      let nearest = Infinity, apart = Infinity, spin = 0;
      const was = [a.h, b.h];
      for (let i = 0; i < 4 * 60; i++) {
        g.simulate(1 / 60);
        if (i > 60) {
          nearest = Math.min(nearest, gap(a), gap(b));
          apart = Math.min(apart, Math.hypot(a.x - b.x, a.y - b.y));
          spin = Math.max(spin, turn(was[0], a.h), turn(was[1], b.h));
        }
        was[0] = a.h;
        was[1] = b.h;
      }
      t.paused = false;
      const facing = Math.max(turn(a.h, Math.atan2(w.y - a.y, w.x - a.x)), turn(b.h, Math.atan2(w.y - b.y, w.x - b.x))) * 180 / Math.PI;
      t.check('they stop at arm’s length, not in you', nearest > 0.6 && Math.max(gap(a), gap(b)) < 1.3,
        { nearest: +nearest.toFixed(2), now: [+gap(a).toFixed(2), +gap(b).toFixed(2)] });
      t.check('spread round you, not on top of each other', apart > 1, { apart: +apart.toFixed(2) });
      t.check('facing you', facing < 20, `${Math.round(facing)}° off at most`);
      t.check('no spinning on the spot', spin < 0.25, `${(spin * 180 / Math.PI).toFixed(1)}° in one frame at most`);
      const [lon, lat] = (window.__drive as { dev: { toLonLat: (x: number, y: number) => [number, number] } }).dev.toLonLat(w.x, w.y);
      await t.camera({ at: [lat, lon], height: 5, tilt: 45, heading: 0 });
      await t.shot('arrest-foot-close');
      await t.camera(null);

      // The arrest: the one who has you comes behind you, cuffs you and leads you off,
      // never inside you; the other stands back.
      kit.unarrested = false;
      t.paused = true;
      let inside = Infinity, stood = Infinity, began = false;
      const phases = new Set<string>();
      for (let i = 0; i < 12 * 60 && (!began || t.arrested()); i++) {
        g.simulate(1 / 60);
        const ph = t.arrested();
        if (!ph) continue;
        began = true;
        phases.add(ph);
        if (ph === 'back') break;
        const by = P.officers.find((o) => o.led), other = P.officers.find((o) => !o.led && o.down <= 0 && !o.back);
        if (by) inside = Math.min(inside, gap(by));
        if (other && (ph === 'cuff' || ph === 'lead')) stood = Math.min(stood, gap(other));
      }
      t.paused = false;
      for (let i = 0; i < 40 && t.arrested(); i++) await t.wait(1);
      t.check('busted after a moment’s hold', began, [...phases].join(', '));
      t.check('the arresting officer never walks through you', inside > 0.45, { nearest: +inside.toFixed(2), phases: [...phases].join(', ') });
      t.check('the other one stands back', stood > 1.8 || stood === Infinity, { nearest: Number.isFinite(stood) ? +stood.toFixed(2) : null });
      await t.settled();
    } finally {
      kit.unarrested = true;
      t.paused = false;
      t.set({ stars: 0 });
      t.empty(false);
    }
  },
} satisfies Scenario;
