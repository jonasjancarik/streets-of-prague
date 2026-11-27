import type { Scenario } from '../src/testkit.ts';
import type { Police } from '../src/police.ts';
import type { Car } from '../src/car.ts';

// The user saw (26 Nov) a police car driving along behind them with the driver's door
// open. Shot at or rammed while it was moving, its officer got out at once, and the
// empty car rolled on with the door open. Now it pulls up first and they get out then.
export default {
  title: 'A police car shot at while driving pulls up before its officer gets out, and never moves with a door open',
  async run(t) {
    await t.go('karlak', { heading: 0 });
    t.time('14:00');
    t.weather('clear');
    t.set({ stars: 0 });
    t.empty();
    const g = window.__drive as { police: Police; walker: { x: number; y: number }; simulate: (dt: number) => void };
    const P = g.police, w = g.walker;
    const open = (c: Car) => !!c.door && [0, 1, 2, 3].some((i) => c.door![i] > 0.05 || c.door![4 + i] > 0);
    try {
      t.set({ stars: 2 });
      // A police car coming along at 40 km/h, 60 m off.
      const p = P.dispatch(w.x - 60, w.y, 0), c = p.car;
      c.vx = 11;
      t.paused = true;
      for (let i = 0; i < 20; i++) g.simulate(1 / 60);
      const before = P.officers.length, speed = c.speed;
      P.crime('hitCop', c.x, c.y, c);
      const atOnce = P.officers.length - before;
      let rolling = 0, out = -1;
      for (let i = 0; i < 8 * 60; i++) {
        g.simulate(1 / 60);
        if (c.speed > 1.5 && open(c)) rolling = Math.max(rolling, c.speed);
        if (out < 0 && P.officers.length > before) out = i / 60;
      }
      t.paused = false;
      t.check('it was moving when it was hit', speed > 6, `${(speed * 3.6).toFixed(0)} km/h`);
      t.check('nobody jumps out of the moving car', atOnce === 0, `${atOnce} out at once`);
      t.check('it pulls up and the officer gets out', out > 0, out > 0 ? `${out.toFixed(1)} s later` : 'nobody got out');
      t.check('never moving with a door open', rolling === 0, rolling ? `${(rolling * 3.6).toFixed(0)} km/h with a door open` : 'shut while moving');
    } finally {
      t.paused = false;
      t.set({ stars: 0 });
      t.empty(false);
    }
  },
} satisfies Scenario;
