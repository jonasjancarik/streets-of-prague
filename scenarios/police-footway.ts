import type { Scenario } from '../src/testkit.ts';
import type { Police, Officer } from '../src/police.ts';

// Until 27 Nov an officer on foot made straight for you and only stepped round cars: with
// a building between, they ran into its wall and stayed there. Now they find a way round
// (Police.footway) and follow it.
export default {
  title: 'Police on foot go round a building between you and them, not into its wall',
  async run(t) {
    await t.go('karlak', { heading: 0 });
    t.time('14:00');
    t.weather('clear');
    t.set({ stars: 0 });
    t.empty();
    await t.wait(1);
    const g = window.__drive as { police: Police; walker: { x: number; y: number }; grid: { at: (x: number, y: number) => number } };
    const P = g.police, w = g.walker;
    // You somewhere open, an officer 25–45 m off with a building on the straight line.
    let from: [number, number] | null = null, round: [number, number][] | null = null, me: [number, number] | null = null;
    for (let k = 0; k < 400 && !from; k++) {
      const mx = w.x + Math.cos(k * 0.7) * (k * 0.6), my = w.y + Math.sin(k * 0.7) * (k * 0.6);
      if (P.blocked(mx, my)) continue;
      for (let i = 0; i < 16 && !from; i++) {
        const a = (i / 16) * Math.PI * 2, r = 25 + (k % 5) * 5, x = mx + Math.cos(a) * r, y = my + Math.sin(a) * r;
        if (P.blocked(x, y) || P.walkable(x, y, mx, my)) continue;
        let wall = false;
        for (let s = 0.1; s < 0.9 && !wall; s += 0.05) wall = g.grid.at(x + (mx - x) * s, y + (my - y) * s) === 255;
        if (!wall) continue;
        const way = P.footway(x, y, mx, my);
        if (!way) continue;
        const len = way.reduce((sum, p, j) => sum + Math.hypot(p[0] - (j ? way[j - 1][0] : x), p[1] - (j ? way[j - 1][1] : y)), 0);
        if (len < 80) { from = [x, y]; round = way; me = [mx, my]; }
      }
    }
    if (!t.check('a building between you and an officer, with a way round', !!from)) return;
    [w.x, w.y] = me!;
    t.set({ stars: 1 });
    P.reset();
    const spawn = P.spawn;
    P.spawn = () => false;
    try {
      const st = P.nearestStreet(from![0], from![1], 60) ?? P.nearestStreet(me![0], me![1], 80);
      if (!t.check('a street for the police car', !!st)) return;
      const q = st!.e.mid.at(st!.s);
      const c = P.dispatch(q.x, q.y, q.ang);
      P.getOut(c.car);
      const o = P.officers[P.officers.length - 1] as Officer;
      [o.x, o.y] = from!;
      o.out = 0;
      const start = Math.hypot(o.x - w.x, o.y - w.y);
      let closest = start, stuck = 0, lastD = start;
      for (let i = 0; i < 40 && closest > 3; i++) {
        await t.wait(0.5);
        [w.x, w.y] = me!;
        const d = Math.hypot(o.x - w.x, o.y - w.y);
        closest = Math.min(closest, d);
        stuck = Math.abs(lastD - d) < 0.1 && d > 3 ? stuck + 0.5 : 0;
        lastD = d;
        if (stuck > 3) break;
      }
      t.check('the officer gets round to you', closest < 3, { start: Math.round(start), closest: +closest.toFixed(1), stuck, way: round!.length, at: [Math.round(o.x - w.x), Math.round(o.y - w.y)] });
    } finally {
      P.spawn = spawn;
      t.set({ stars: 0 });
    }
  },
} satisfies Scenario;
