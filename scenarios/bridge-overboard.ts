import type { Scenario } from '../src/testkit.ts';
import type { TileWorld } from '../src/tiles.ts';
import { firstPersonOptions, setFirstPersonOptions } from '../src/streetView.ts';

// A bridge's parapet in the physical handling (physicalHandling.ts, TileWorld.rimAt): a
// metre of stone the body meets in three dimensions. Driven into head on it holds; a car
// thrown at it lower than its top is stopped by it; one thrown higher goes over the edge
// and falls, into the river (and back onto the deck, as you are on foot).
export default {
  title: 'A bridge parapet holds a car driven into it and lets one thrown over it fall',
  async run(t) {
    const previous = firstPersonOptions.handling, paused = t.paused;
    const { world } = (globalThis as unknown as { __drive: { world: TileWorld } }).__drive;
    try {
      // Most Legií, over the river: its north parapet.
      await t.go([50.0813, 14.4125]);
      t.empty(); t.unhurt = true; t.weather('clear'); t.time('14:00');
      const car = await t.drive('sedan');
      t.paused = true;
      setFirstPersonOptions({ handling: 'physical' }, false);
      t.eyes = { yaw: 25, pitch: -8, third: true };
      const [x, y] = t.toLocal([50.0813, 14.4125]);
      const deck = world.below(x, y, Infinity);
      let lip = y;
      while (lip < y + 40 && Number.isFinite(world.levelAt(x, lip + 0.25, deck.level))) lip += 0.25;
      if (!t.check('on a bridge deck over the water', deck.level > 0 && !!world.waterAt(x, lip + 6), `level ${deck.level}`)) return;
      const body = () => car.physics as unknown as { p: Float64Array; v: Float64Array } | undefined;
      const place = async (back: number) => {
        car.physics = car.overboard = undefined;
        car.damage = 0;
        Object.assign(car, { x, y: lip - back, h: Math.PI / 2, vx: 0, vy: 0, w: 0, level: deck.level, gz: deck.h, _tx: undefined, _ty: undefined });
        await t.wait(0.3, { brake: true });
      };
      // Watches for `s` seconds: whether it went over, and how far north it got.
      const watch = async (s: number) => {
        let over = false, far = -Infinity;
        for (let i = 0; i < s / 0.05; i++) {
          await t.wait(0.05);
          over ||= !!car.overboard;
          far = Math.max(far, car.y - lip);
        }
        return { over, far };
      };

      await place(8);
      car.vx = 0; car.vy = 60 / 3.6;
      const head = await watch(2);
      t.check('driven into it at 60 km/h, it stays on the deck', !head.over && car.level === deck.level && head.far > -3 && head.far < -0.5,
        `its middle ${head.far.toFixed(2)} m past the edge at most, level ${car.level}${head.over ? ', went over' : ''}`);
      await t.shot('overboard-held');

      await place(3);
      const low = body();
      if (!t.check('the physical body drives', !!low) || !low) return;
      low.p[2] += 0.25; low.v[1] = 9; low.v[2] = 2;
      const stopped = await watch(2.5);
      t.check('thrown at it lower than its top, it is stopped', !stopped.over && car.level === deck.level && stopped.far < 0.5,
        `its middle ${stopped.far.toFixed(2)} m past the edge at most, level ${car.level}${stopped.over ? ', went over' : ''}`);

      await place(3);
      const high = body()!;
      high.p[2] += 1.1; high.v[1] = 7; high.v[2] = 3.5;
      let seen = false;
      for (let i = 0; i < 40 && !car.overboard; i++) await t.wait(0.05);
      if (car.overboard) { seen = true; await t.wait(0.25); await t.shot('overboard-falling'); }
      const fell = await watch(5);
      t.check('thrown above its top, it goes over and falls', seen || fell.over);
      t.check('and after the splash it is back on the deck', !car.overboard && car.level === deck.level && Math.abs(car.y - lip) < 4, `level ${car.level}, ${(car.y - lip).toFixed(1)} m from the edge`);
    } finally {
      t.eyes = null; t.paused = paused;
      setFirstPersonOptions({ handling: previous }, false);
    }
  },
} satisfies Scenario;
