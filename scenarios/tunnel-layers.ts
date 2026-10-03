import type { Scenario } from '../src/testkit.ts';

export default {
  title: 'Underground and on the road above stay apart on foot and in cars',
  async run(t) {
    await t.go([50.0905, 14.3925]);
    t.time('14:00');
    t.weather('clear');
    const g = (globalThis as unknown as { __drive: any }).__drive; // eslint-disable-line @typescript-eslint/no-explicit-any
    const w = g.world;
    const edges = w.around(g.walker.x, g.walker.y, 600).flatMap((k: string) => w.driveBy.get(k) || []).filter((e: { tunnel?: boolean }) => e.tunnel);
    if (!t.check('a tunnel street is near', edges.length > 0, `${edges.length}`)) return;
    const e = edges.sort((a: { path: unknown[] }, b: { path: unknown[] }) => b.path.length - a.path.length)[0];
    const p = e.path.at(Math.floor(e.path.length / 2));
    await g.teleport(p.x, p.y);
    await t.wait(1);
    g.walker.hint = 'tunnel';
    g.walker.level = undefined;
    g.walker.x += 0.01;
    await t.wait(0.5);
    const lvl = g.walker.level, floor = g.walker.gz, top = w.terrainAt(g.walker.x, g.walker.y);
    t.check('you walk in the tunnel', lvl < 0, `level ${lvl}, you ${floor?.toFixed(1)} m, ground ${top.toFixed(1)} m`);

    const above = t.car('sedan', { at: [t.where().lat, t.where().lon], ahead: 0 });
    g.enterOrExit();
    await t.wait(0.3);
    t.check('the car on the road above is out of reach', t.where().mode === 'foot', t.where().mode);
    g.removeCar?.(above);
    above.x = above.y = 1e6;

    // A car in the tunnel: get in, get out, and stay down on the tunnel's floor.
    const below = t.car('sedan', { at: [t.where().lat, t.where().lon], ahead: 0 });
    below.hint = 'tunnel';
    below.level = undefined;
    g.enterOrExit();
    await t.wait(0.5);
    t.check('you got into the car in the tunnel', t.where().mode !== 'foot', t.where().mode);
    g.enterOrExit();
    await t.wait(0.5);
    t.check('you are out, on foot', t.where().mode === 'foot', t.where().mode);
    t.check('you stand in the tunnel, not on the road above', g.walker.level < 0 && g.walker.gz < top - 3, `level ${g.walker.level}, you ${g.walker.gz?.toFixed(1)} m, road ${top.toFixed(1)} m`);
  },
} satisfies Scenario;
