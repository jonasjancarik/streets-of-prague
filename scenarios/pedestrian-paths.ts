import { Polyline, type WalkEdge } from '../src/network.ts';
import type { Crowd, Pedestrian } from '../src/people.ts';
import type { Scenario, Where } from '../src/testkit.ts';

type Grid = { at(x: number, y: number): number };
type Drive = { crowd: Crowd; grid: Grid; walker: { x: number; y: number } };

// Walkers near you for `seconds`, sampled twice a second: how often two stand closer
// than 0.5 m, how many step from open ground into a wall or a fence, and how many walking
// a street (not a footpath or a pedestrian street), away from the junctions at its ends
// where they cross, stand on its carriageway, more than a step off its kerb.
async function sample(t: Parameters<Scenario['run']>[0], seconds: number) {
  const { crowd, grid, walker } = window.__drive as Drive;
  const road = crowd.road ?? (() => false);
  const blocked = (p: Pedestrian) => crowd.blocked(p.x, p.y);
  const was = new Map<Pedestrian, { x: number; y: number; in: boolean }>();
  let samples = 0, people = 0, close = 0, intoWall = 0, inWall = 0, street = 0, inRoad = 0;
  for (let k = 0; k < seconds * 2; k++) {
    await t.wait(0.5);
    samples++;
    const near = crowd.people.filter((p) => Math.abs(p.x - walker.x) < 100 && Math.abs(p.y - walker.y) < 100);
    for (const p of near) {
      people++;
      for (const o of near) if (o.i > p.i && Math.abs((o.gz ?? 0) - (p.gz ?? 0)) < 1.5 && Math.hypot(o.x - p.x, o.y - p.y) < 0.5) close++;
      const now = { x: p.x, y: p.y, in: blocked(p) }, before = was.get(p);
      // (Not someone put somewhere new, out of sight.)
      if (before && p.state === 'walk' && !before.in && now.in && Math.hypot(p.x - before.x, p.y - before.y) < 2) intoWall++;
      if (grid.at(p.x, p.y) !== 0) inWall++;
      was.set(p, now);
      if (p.state === 'walk' && p.e.side > 0 && Math.min(p.s, p.e.path.length - p.s) > 6) {
        street++;
        // A step into the carriageway from the kerb is fine (a street with no pavement);
        // further, in every direction, it isn't.
        let deep = road(p.x, p.y);
        for (let a = 0; deep && a < 8; a++) deep = road(p.x + Math.cos(a * Math.PI / 4) * 1.5, p.y + Math.sin(a * Math.PI / 4) * 1.5);
        if (deep) inRoad++;
      }
    }
  }
  return { people: Math.round(people / samples), closePairs: +(close / samples).toFixed(2), intoWall, inWallPct: +(100 * inWall / people).toFixed(2),
    streetWalkers: street, deepInRoadPct: street ? +(100 * inRoad / street).toFixed(1) : 0 };
}

export default {
  title: 'Walkers pass each other on the right, keep out of walls and to the pavement beside a street',
  async run(t) {
    const g = window.__drive as Drive;
    const crowd = g.crowd, paused = t.paused, oldRandom = crowd.r;
    try {
      t.paused = true;
      t.time('14:00');
      t.weather('clear');

      // Two walkers meeting head-on in the same line on a wide path, alone.
      await t.go('staromak');
      t.empty();
      const all = crowd.people, [a, b] = all.filter((p) => p.state === 'walk');
      if (!t.check('two pedestrians to stage', !!a && !!b)) return;
      // (Somewhere on the square with nothing in the way, no tree or lamp.)
      const open = (x: number, y: number) => {
        for (let s = -12; s <= 12; s += 0.5) for (let d = -2.5; d <= 2.5; d += 0.5) if (crowd.blocked(x + s, y + d)) return false;
        return true;
      };
      let x = g.walker.x, y = g.walker.y;
      for (let k = 0; k < 400 && !open(x, y); k++) [x, y] = [g.walker.x + (k % 20 - 10) * 3, g.walker.y + (Math.floor(k / 20) - 10) * 3];
      if (!t.check('an open stretch of the square to stage it on', open(x, y), [x, y])) return;
      const saved = [{ ...a }, { ...b }];
      const edge: WalkEdge = { ...a.e, hw: 'footway', side: 0, width: 5, path: new Polyline([[x - 12, y], [x + 12, y]]) };
      const put = (p: Pedestrian, i: number, s: number, fwd: boolean, speed: number) =>
        Object.assign(p, { i, e: edge, s, fwd, side: 1, lane: 0, speed, pause: 0, state: 'walk', t: 0, x: x - 12 + s, y, h: fwd ? 0 : Math.PI, pace: 0, dodge: 0, dodgeTo: 0, cap: Infinity, stuck: 0 });
      crowd.r = () => .5;
      crowd.people = [a, b];
      try {
        put(a, 0, 4, true, 1.4);
        put(b, 1, 20, false, 1.4);
        let closest = Infinity, aSide = 0;
        for (let i = 0; i < 80 && a.x < b.x + 1; i++) {
          await t.wait(0.1);
          const d = Math.hypot(a.x - b.x, a.y - b.y);
          if (d < closest) { closest = d; aSide = a.y - b.y; }
        }
        // Going east, a's right is south: below b as they pass.
        t.check('meeting head-on, they keep apart', closest > 0.75, closest);
        t.check('each keeps to their right', aSide < -0.4, aSide);

        // A quick walker behind a slow one on a path too narrow to pass.
        edge.width = 1.15;
        put(a, 0, 2, true, 1.6);
        put(b, 1, 6, true, 0.6);
        let gap = Infinity;
        for (let i = 0; i < 60; i++) {
          await t.wait(0.1);
          gap = Math.min(gap, Math.hypot(a.x - b.x, a.y - b.y));
        }
        t.check('no room to pass: falls in behind, not into them', gap > 0.55 && a.x < b.x, { gap, behind: b.x - a.x });
      } finally {
        crowd.people = all;
        Object.assign(a, saved[0]);
        Object.assign(b, saved[1]);
        crowd.r = oldRandom;
      }

      // The whole crowd: on a busy square, on Wenceslas Square's upper carriageways (a
      // street walked along with its pavements), on Vinohrady's residential streets.
      const places: [string, Where, number][] = [['Old Town Square', 'staromak', 100], ['Wenceslas Square', [50.0803, 14.4290], 12], ['Vinohrady', [50.0757, 14.4405], 12]];
      for (const [name, where, deepMax] of places) {
        await t.go(where);
        t.time('14:00');
        await t.wait(2);
        const s = await sample(t, 12);
        t.check(`${name}: hardly anyone in anyone else`, s.closePairs < Math.max(1, s.people / 100), s);
        t.check(`${name}: nobody walks into a wall or a fence`, s.intoWall === 0 && s.inWallPct < 0.5, s);
        if (deepMax < 100) t.check(`${name}: walkers along a street keep to its pavement`, s.deepInRoadPct < deepMax, s);
      }
    } finally {
      t.paused = paused;
      crowd.r = oldRandom;
    }
  },
} satisfies Scenario;
