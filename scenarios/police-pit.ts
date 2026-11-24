import type { Scenario } from '../src/testkit.ts';
import type { Police } from '../src/police.ts';
import type { Car } from '../src/car.ts';

// The PIT manoeuvre (Police.pitting, Car.upset): a police car comes up beside your back
// wheels, keeps pace and steers into your rear quarter, and you spin out. Brake as it
// comes alongside and it misses.
export default {
  title: 'PIT manoeuvre: a police car beside your back wheels spins you out; braking as it comes up beats it',
  async run(t) {
    const g = window.__drive as { police: Police; car: Car | null; simulate: (dt: number, ctl?: object) => void; grid: { at: (x: number, y: number) => number } };
    const P = g.police;
    const spawn = P.spawn;
    // A long straight: Štěpánská, northwards from Ječná.
    const from: [number, number] = [50.07590, 14.42420], to: [number, number] = [50.07972, 14.42592];
    const turn = (a: number, b: number) => Math.abs(Math.atan2(Math.sin(b - a), Math.cos(b - a)));
    const attempt = async (dodge: boolean) => {
      await t.go(from, { heading: 15 });
      t.time('14:00');
      t.weather('clear');
      t.empty();
      await t.drive('sedan');
      const c = g.car!, [ex, ey] = t.toLocal(to), h = Math.atan2(ey - c.y, ex - c.x);
      c.h = h;
      t.push(50);
      P.spawn = () => false;
      t.set({ stars: 3 });
      P.reset();
      P.cars.length = 0;
      // The side with room for it, a car's length behind.
      const fx = Math.cos(h), fy = Math.sin(h), room = (s: number) => [1, 2, 3, 4].filter((k) => !g.grid.at(c.x - fx * 6 - fy * s * k, c.y - fy * 6 + fx * s * k)).length;
      const side = room(1) >= room(-1) ? 1 : -1;
      const p = P.dispatch(c.x - fx * 7 - fy * side * 2.6, c.y - fy * 7 + fx * side * 2.6, h);
      t.push(50, undefined, p.car);
      Object.assign(p, { trick: 99, pit: { phase: 'line', t: 0, side, ok: 0, cramped: 0 } });
      const phases = new Set<string>();
      let worst = 0, spun = 0, braking = 0;
      t.paused = true;
      for (let i = 0; i < 9 * 60; i++) {
        const pit = (p as { pit?: { phase: string; ok: number } }).pit;
        if (pit) phases.add(pit.phase);
        if (dodge && pit?.phase === 'line' && pit.ok > 0.1) braking = 1.2;
        braking -= 1 / 60;
        const v = Math.hypot(c.vx, c.vy);
        // (The wheel held straight: steering against the spin would get you out of it sooner.)
        g.simulate(1 / 60, { move: braking > 0 ? -1 : v < 50 / 3.6 ? 1 : 0 });
        worst = Math.max(worst, turn(c.h, h));
        spun = Math.max(spun, c.spin);
        if (!pit && phases.size && i > 60) break;
      }
      t.paused = false;
      return { phases: [...phases].join(' → '), turned: Math.round(worst * 180 / Math.PI), spun: +spun.toFixed(2), kmh: Math.round(Math.hypot(c.vx, c.vy) * 3.6) };
    };
    try {
      const hit = await attempt(false);
      t.check('it gets alongside and goes in', hit.phases.includes('hit'), hit.phases);
      t.check('you spin out', hit.turned > 60 && hit.spun > 0.5, hit);
      // (Close above you: the police car alongside, you turned across the street.)
      const [lon, lat] = (window.__drive as { dev: { toLonLat: (x: number, y: number) => [number, number] } }).dev.toLonLat(g.car!.x, g.car!.y);
      await t.camera({ at: [lat, lon], height: 22, tilt: 0, heading: 0 });
      await t.shot('police-pit');
      await t.camera(null);
      const dodged = await attempt(true);
      t.check('braking as it comes alongside, you keep straight', dodged.turned < 25, dodged);
    } finally {
      P.spawn = spawn;
      t.paused = false;
      t.set({ stars: 0 });
      t.empty(false);
    }
  },
} satisfies Scenario;
