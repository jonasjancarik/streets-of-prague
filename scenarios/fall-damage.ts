import type { Scenario } from '../src/testkit.ts';
import type { Walker } from '../src/people.ts';
import type { TileWorld } from '../src/tiles.ts';

export default {
  title: 'Short drops are safe, hard landings hurt, and a high fall needs a parachute',
  async run(t) {
    await t.go('staromak');
    const { walker, world } = (globalThis as unknown as { __drive: { walker: Walker; world: TileWorld } }).__drive;
    const { x, y } = walker;
    const ground = world.landingAt(x, y, Infinity).h;
    const land = async (height: number, vz = 0, deploy = false) => {
      t.set({ health: 100 });
      walker.jumpFromHelicopter({ x, y, h: 0, z: ground + height - 0.8, vz, vx: 0, vy: 0 });
      if (deploy) await t.wait(1 / 60, { jump: true });
      for (let i = 0; walker.flight && i < 100; i++) await t.wait(0.2);
      return t.probe().health;
    };
    t.check('a short fast drop is harmless', await land(4, -18) === 100);
    const mild = await land(12);
    const fast = await land(12, -12);
    t.check('speed matters for the same drop', fast < mild && fast > 0);
    const hard = await land(20);
    t.check('a harder landing costs more health', mild < 100 && hard < mild && hard > 0, `health ${mild} and ${hard}`);
    t.check('a high parachute landing is safe', await land(32, 0, true) === 100);
    t.check('an unopened chute on a high fall triggers death', await land(28) === 0 && walker.down > 0);
    await t.wait(4);
    await t.settled();
  },
} satisfies Scenario;
