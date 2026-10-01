import type { Scenario } from '../src/testkit.ts';
import type { Chopper } from '../src/helicopter.ts';

interface Game {
  walker: { x: number; y: number; level?: number; gz?: number };
  choppers: Chopper[];
  addChopper: () => boolean;
  enterOrExit: () => void;
  teleport: (x: number, y: number) => Promise<void>;
  world: { below: (x: number, y: number, z: number) => { h: number }; terrainAt: (x: number, y: number) => number };
}

export default {
  title: 'A helicopter lands on a bridge, lets you out on its deck and stays under it from below',
  async run(t) {
    await t.go([50.08135, 14.4142]);
    t.time('14:00');
    t.weather('clear');
    const d = (globalThis as unknown as { __drive: Game }).__drive, w = d.walker;
    if (!t.check('a helicopter to fly', d.addChopper())) return;
    const c = d.choppers[d.choppers.length - 1];
    w.x = c.x + 2;
    w.y = c.y;
    d.enterOrExit();
    // Most Legií over Střelecký ostrov (a park under the deck) and over the river.
    for (const [name, lat, lon] of [['the island', 50.08126, 14.41055], ['the river', 50.0813, 14.4125]] as const) {
      const [x, y] = t.toLocal([lat, lon]);
      await d.teleport(x, y);
      const deck = d.world.below(x, y, Infinity).h, ground = d.world.terrainAt(x, y);
      Object.assign(c, { x, y, z: deck + 15, vx: 0, vy: 0, vz: 0 });
      await t.wait(6, { run: true });
      t.check(`over ${name}: it lands on the deck`, c.landed && Math.abs(c.z - deck) < 0.5, `deck ${deck.toFixed(1)} m, helicopter ${c.z.toFixed(1)} m`);
      d.enterOrExit();
      await t.wait(0.3);
      t.check(`over ${name}: you get out onto the deck`, t.where().mode === 'foot' && Math.abs((w.gz ?? 0) - deck) < 0.5 && Math.hypot(w.x - c.x, w.y - c.y) < 5, `you ${(w.gz ?? 0).toFixed(1)} m`);
      if (name === 'the island') await t.shot('heli-bridge');
      d.enterOrExit();
      await t.wait(0.3);
      Object.assign(c, { z: ground + 1, vz: 0 });
      await t.wait(4, { brake: true });
      t.check(`over ${name}: from below it stays under the deck`, c.z < deck - 2, `${c.z.toFixed(1)} m`);
    }
  },
} satisfies Scenario;
