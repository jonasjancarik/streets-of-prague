import type { Scenario } from '../src/testkit.ts';
import type { Police } from '../src/police.ts';

// Until 27 Nov a chase car that had lost you drove at the spot where they last saw you
// as if to ram you, round and round it, and the officers stood round the empty spot as if
// they had you. Now one car goes to look at the spot and the others at street corners
// round it, ahead the way you went, each a different one, at a looking pace; officers on
// foot look round and go back to their cars. And what they see is fairer: a car that
// isn't after you yet doesn't see you far behind it, and the dark and mist bring their
// sight in.
export default {
  title: 'Police: once they lose you they search the streets round where you were; a car doesn’t see far behind it, nor far in the dark or mist',
  async run(t) {
    await t.go('karlak', { heading: 0 });
    t.time('14:00');
    t.weather('clear');
    t.set({ stars: 0 });
    t.empty();
    await t.wait(1);
    const g = window.__drive as { police: Police; walker: { x: number; y: number; h: number }; grid: { at: (x: number, y: number) => number } };
    const P = g.police, w = g.walker;

    // ---- Sight: a car put 50 m off along a clear line, facing away and then towards you.
    let spot: [number, number] | null = null, h = 0;
    for (let i = 0; i < 24 && !spot; i++) {
      const a = (i / 24) * Math.PI * 2, x = w.x + Math.cos(a) * 50, y = w.y + Math.sin(a) * 50;
      if (P.clear(x, y, w.x, w.y) && P.nearestStreet(x, y, 4)) { spot = [x, y]; h = a; }
    }
    if (t.check('a street 50 m off in plain view', !!spot)) {
      const c = P.dispatch(spot![0], spot![1], h); // facing away from you
      c.calm = true;
      const away = P.sees(w.x, w.y);
      c.car.h = h + Math.PI; // facing you
      const facing = P.sees(w.x, w.y);
      t.check('a car facing away doesn’t see you 50 m behind it', !away && facing, { away, facing });
      P.dim = 1;
      const murk = P.sees(w.x, w.y, 80);
      P.dim = 0;
      t.check('in the dark and mist they see less far', !murk && P.sees(w.x, w.y, 80), { murk });
      t.check('close by they notice you whichever way they face', (() => {
        c.car.x = w.x + Math.cos(h) * 6; c.car.y = w.y + Math.sin(h) * 6; c.car.h = h;
        return P.sees(w.x, w.y);
      })());
      P.reset();
    }

    // ---- The search: two cars after you, who last knew you to be here, and you well away.
    // (Staged: cars left to spawn and find you by themselves made the checks a matter of luck.)
    const spawn = P.spawn;
    P.spawn = () => false;
    try {
      t.set({ stars: 2 });
      P.reset();
      const at = { x: w.x, y: w.y };
      const away = Array.from({ length: 72 }, (_, i) => [at.x + Math.cos(i * 0.35) * (240 + i), at.y + Math.sin(i * 0.35) * (240 + i)])
        .find(([x, y]) => g.grid.at(x, y) === 0);
      if (!t.check('somewhere well away to go', !!away)) return;
      // The cars on streets 70–150 m off, on the far side from where you go.
      const back = Math.atan2(at.y - away![1], at.x - away![0]);
      for (let i = 0, put = 0; i < 40 && put < 2; i++) {
        const a = back + (i % 2 ? 1 : -1) * (0.3 + i * 0.05), r = 70 + i * 2, st = P.nearestStreet(at.x + Math.cos(a) * r, at.y + Math.sin(a) * r, 10);
        if (!st) continue;
        const q = st.e.mid.at(st.s);
        if (P.cars.some((p) => Math.hypot(p.car.x - q.x, p.car.y - q.y) < 30)) continue;
        P.dispatch(q.x, q.y, Math.atan2(at.y - q.y, at.x - q.x));
        put++;
      }
      if (!t.check('two cars after you', P.cars.length === 2, { cars: P.cars.length })) return;
      P.known = [at.x, at.y];
      [w.x, w.y] = away!;
      await t.wait(1);
      const s = P.search;
      t.check('a search from where they lost you', !P.seen && !!s && Math.hypot(s.x - at.x, s.y - at.y) < 15,
        { seen: P.seen, off: s && Math.round(Math.hypot(s.x - at.x, s.y - at.y)) });
      if (!s) return;
      let fast = 0, spread = false, spot1 = false, looked = 0;
      for (let i = 0; i < 24 && P.search === s; i++) {
        await t.wait(0.5);
        const hunting = P.chasing.filter((p) => p.look?.of === s);
        for (const p of hunting) fast = Math.max(fast, p.car.speed);
        spot1 ||= hunting.some((p) => !p.look!.node);
        const corners = hunting.filter((p) => p.look!.node).map((p) => p.look!);
        spread ||= hunting.length >= 2 && new Set(hunting.map((p) => `${Math.round(p.look!.x)},${Math.round(p.look!.y)}`)).size === hunting.length
          && corners.every((l) => Math.hypot(l.x - s.x, l.y - s.y) > 20);
        looked = Math.max(looked, ...P.officers.map((o) => o.looked ?? 0));
      }
      t.check('one car goes to look at the spot itself', spot1);
      t.check('the cars look in different places', spread, { cars: P.chasing.length });
      t.check('at a looking pace, not ramming the empty spot', fast > 2 && fast < 16, { fast: +fast.toFixed(1) });
      t.check('somewhere has been looked at', s.checked || s.been.size > 0, { checked: s.checked, corners: s.been.size, officersLooked: +looked.toFixed(1), stillAfter: P.chasing.map((p) => Math.round(Math.hypot(p.car.x - (p.look?.x ?? p.car.x), p.car.y - (p.look?.y ?? p.car.y)))) });
    } finally {
      P.spawn = spawn;
      t.set({ stars: 0 });
    }
  },
} satisfies Scenario;
