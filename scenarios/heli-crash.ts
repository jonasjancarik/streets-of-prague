import type { Scenario } from '../src/testkit.ts';
import type { Walker } from '../src/people.ts';
import type { Chopper } from '../src/helicopter.ts';
import type { TileWorld } from '../src/tiles.ts';

export default {
  title: 'Gunfire damages a helicopter and a hard wall strike brings it down',
  async run(t) {
    const d = (globalThis as unknown as { __drive: {
      world: TileWorld; walker: Walker; addChopper(): boolean; choppers: Chopper[]; enterOrExit(): void;
    } }).__drive;
    await t.go('staromak');
    if (!t.check('a helicopter on open ground', d.addChopper())) return;
    const c = d.choppers.at(-1)!, w = d.walker;
    Object.assign(w, { x: c.x + 3, y: c.y });
    w.sync();
    const gun = t.gun();
    try {
      t.gun(true);
      t.shoot(c);
      t.check('one hit leaves the helicopter damaged and flyable', c.damage > 0 && c.damage < 100 && c.landed);
    } finally { t.gun(gun); }
    d.enterOrExit();
    if (!t.check('pilot aboard', t.where().mode === 'helicopter')) return;
    // Aim from the courtyard at the facade below its south eave.
    const x = -3290.46, y = 3095.49;
    const z = d.world.rooftopAt(x, y) - 3;
    Object.assign(c, { x, y: y - 4, z, h: Math.PI / 2, vx: 0, vy: 47, vz: 0, spin: 1 });
    await t.wait(0.16, { move: 1 });
    t.check('a hard wall strike disables the engine in mid-air', c.damage === 100 && !c.wrecked && !c.landed);
    await t.wait(0.35, { brake: true });
    t.check('the disabled aircraft falls even with climb held', c.z < z - 0.4);
    await t.wait(2.5);
    t.check('impact leaves a disabled wreck and releases the pilot', c.wrecked && !c.landed && t.where().mode === 'foot');
    await t.wait(4);
    await t.settled();
    t.check('the pilot recovers on foot away from the wreck', t.where().mode === 'foot' && Math.hypot(w.x - c.x, w.y - c.y) > 50);
  },
} satisfies Scenario;
