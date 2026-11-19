import type { Scenario } from '../src/testkit.ts';
import type { Walker } from '../src/people.ts';
import type { Chopper } from '../src/helicopter.ts';
import type { TileWorld } from '../src/tiles.ts';

export default {
  title: 'Bail out with a parachute in flight and after engine failure',
  async run(t) {
    const { walker, world, choppers, addChopper } = (globalThis as unknown as { __drive: {
      walker: Walker; world: TileWorld; choppers: Chopper[]; addChopper(): boolean;
    } }).__drive;
    for (const river of [false, true]) {
      await t.go(river ? [50.08135, 14.4142] : 'staromak');
      if (!t.check('a helicopter is available', addChopper())) return;
      const c = choppers.at(-1)!;
      Object.assign(walker, { x: c.x + 2, y: c.y, level: c.level, gz: c.z, _tx: c.x + 2, _ty: c.y });
      walker.sync();
      t.press();
      if (!t.check('the pilot boarded', t.where().mode === 'helicopter')) return;
      if (river) {
        [c.x, c.y] = t.toLocal([50.08205, 14.4125]);
        t.check('open water beneath the aircraft', !!world.waterAt(c.x, c.y));
      }
      c.z = world.landingAt(c.x, c.y, Infinity).h + 22;
      Object.assign(c, { spin: 1, vx: 5, vy: 0, vz: -1 });
      if (river) c.hit(100);
      await t.wait(0.05);
      const height = c.z;
      t.press();
      t.check('exit starts a fall at aircraft height', t.where().mode === 'foot' && !!walker.flight && !walker.flight.open && Math.abs(walker.mesh.position.y - height) < 1.5);
      await t.wait(0.35, { brake: true });
      const heading = walker.h;
      await t.wait(0.5, { turn: 1 });
      t.check('the open parachute steers after release', !!walker.flight?.open && walker.h > heading + 0.2);
      t.check('the empty helicopter drops independently', c.z < height - 2);
      await t.wait(14);
      t.check('the pilot lands on dry ground or a roof', !walker.flight && walker.down <= 0 && t.where().mode === 'foot' && !world.waterAt(walker.x, walker.y));
      if (river) t.check('the disabled aircraft crashed after the pilot escaped', c.wrecked);
    }
  },
} satisfies Scenario;
