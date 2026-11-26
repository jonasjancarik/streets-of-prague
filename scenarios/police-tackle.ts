import type { Scenario } from '../src/testkit.ts';
import type { Police, Officer } from '../src/police.ts';

// The user wrote (26 Nov) that the police could hardly arrest you on foot any more: the
// officers slowed down for a spot at arm's length beside you, so they trailed even
// someone walking. Now they keep up with you while you walk, and when you run they
// sprint for a moment and dive at your legs once they'd reach you; with a head start
// you still get away. A tackle is played out on the ground: you go down, they cuff you
// where you lie and get you up, and you're led off as in any arrest.
export default {
  title: 'Police on foot: they keep up while you walk, tackle you running close by, and you can still outrun them',
  async run(t) {
    await t.go('staromak', { heading: 0 });
    t.time('14:00');
    t.weather('clear');
    t.set({ stars: 0 });
    t.empty();
    type Walker = { x: number; y: number; h: number };
    const g = window.__drive as { police: Police; walker: Walker; simulate: (dt: number, ctl?: { move?: number; run?: boolean }) => void; grid: { at: (x: number, y: number) => number } };
    const P = g.police, w = g.walker;
    const kit = t as unknown as { unarrested: boolean };
    const gap = (o: Officer) => Math.hypot(o.x - w.x, o.y - w.y);
    // The way with the longest clear run from here.
    const room = (h: number) => { let d = 0; while (d < 80 && !g.grid.at(w.x + Math.cos(h) * d, w.y + Math.sin(h) * d)) d += 1; return d; };
    let best = 0, way = 0;
    for (let i = 0; i < 32; i++) { const h = i * Math.PI / 16, d = room(h); if (d > best) { best = d; way = h; } }
    if (!t.check('a long clear way to run', best >= 70, `${best} m`)) return;
    // (Set off 10 m along it, so the officer behind you is on it too.)
    const start = { x: w.x + Math.cos(way) * 10, y: w.y + Math.sin(way) * 10 };
    // An officer `behind` m behind you, as you set off along that way.
    const ready = async (behind: number) => {
      Object.assign(w, { x: start.x, y: start.y, h: way });
      t.set({ stars: 1 });
      for (let i = 0; i < 30 && !P.cars.length; i++) await t.wait(0.5);
      const car = P.cars[0]?.car;
      if (!car) return null;
      for (const o of [...P.officers]) { o.gone = true; P.dismiss(o); }
      P.officers = [];
      P.getOut(car);
      const o = P.officers[P.officers.length - 1];
      Object.assign(o, { x: w.x - Math.cos(way) * behind, y: w.y - Math.sin(way) * behind, h: way, out: 0, back: false });
      return o;
    };
    // Along the way for `s` seconds; true if you're arrested.
    const go = (s: number, ctl: { move: number; run?: boolean }, each?: () => void) => {
      t.paused = true;
      kit.unarrested = false;
      try {
        for (let i = 0; i < s * 60; i++) {
          w.h = way;
          g.simulate(1 / 60, ctl);
          each?.();
          if (t.arrested()) return true;
        }
        return false;
      } finally { t.paused = false; }
    };
    const finish = async () => {
      for (let i = 0; i < 60 && t.arrested(); i++) await t.wait(1);
      await t.settled();
      await t.go('staromak', { heading: 0 });
      t.set({ stars: 0 });
    };
    try {
      // A head start: running, you get away.
      let o = await ready(9);
      if (!t.check('a police car came', !!o)) return;
      let dived = false;
      const caught = go(5, { move: 1, run: true }, () => { dived ||= !!o!.dive; });
      t.check('running with a head start, you get away', !caught && gap(o!) > 9, { gap: +gap(o!).toFixed(1), dived });

      // Walking off: they keep up and take hold of you.
      o = await ready(6);
      if (!o) return;
      const held = go(8, { move: 1 });
      t.check('walking off, you’re caught', held, t.arrested() ?? 'free');
      if (held) {
        t.check('walking, they take hold of you rather than dive', !(t.arrested() === 'down'), t.arrested());
        await finish();
      }

      // Running close by: a sprint, a dive, and down you go.
      o = await ready(4);
      if (!o) return;
      let top = 0;
      const tackled = go(6, { move: 1, run: true }, () => { top = Math.max(top, Math.hypot(o!.vx, o!.vy)); });
      t.check('running a few metres ahead of them, you’re tackled', tackled && t.arrested() === 'down', { phase: t.arrested(), gap: +gap(o).toFixed(1), sprint: +top.toFixed(1) });
      if (!tackled) return;
      // Played out: down, pinned, up, led off; the officer never inside you, and you
      // never in a wall.
      const phases: string[] = [];
      let inside = Infinity, lyingFor = 0;
      t.paused = true;
      for (let i = 0; i < 12 * 60 && t.arrested(); i++) {
        g.simulate(1 / 60);
        const ph = t.arrested()!;
        if (phases[phases.length - 1] !== ph) phases.push(ph);
        if (ph === 'back' || ph === 'dark') break;
        if (ph === 'down' || ph === 'pin') lyingFor += 1 / 60;
        if (ph === 'pin' || ph === 'lead') inside = Math.min(inside, gap(o));
        // (A look from eye height, the game still paused.)
        if (ph === 'pin' && lyingFor > 1.85 && lyingFor < 1.87) {
          const [lon, lat] = (window.__drive as { dev: { toLonLat: (x: number, y: number) => [number, number] } }).dev.toLonLat(w.x, w.y);
          await t.camera({ at: [lat, lon], height: 1.3, tilt: 75, heading: (450 - way * 180 / Math.PI) % 360 });
          await t.shot('police-tackle-pin');
          await t.camera(null);
        }
      }
      t.paused = false;
      t.check('down, cuffed on the ground, got up and led off', phases.slice(0, 4).join(' ') === 'down pin up lead', phases.join(' → '));
      t.check('a couple of seconds on the ground', lyingFor > 2 && lyingFor < 4, `${lyingFor.toFixed(1)} s`);
      t.check('the officer kneels beside you, not in you', inside > 0.45, { nearest: +inside.toFixed(2) });
      await finish();
    } finally {
      kit.unarrested = true;
      t.paused = false;
      t.set({ stars: 0 });
      t.empty(false);
    }
  },
} satisfies Scenario;
