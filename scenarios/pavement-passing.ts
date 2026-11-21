import { Polyline, type WalkEdge } from '../src/network.ts';
import type { Crowd, Walker } from '../src/people.ts';
import type { Scenario } from '../src/testkit.ts';

export default {
  title: 'A passer-by gives you room on a pavement and waits in a narrow doorway',
  async run(t) {
    await t.go('staromak');
    t.empty();
    t.eyes = { yaw: 0, pitch: 0 };
    const g = window.__drive as { crowd: Crowd; walker: Walker };
    const crowd = g.crowd, w = g.walker, oldRandom = crowd.r, paused = t.paused;
    const p = crowd.people.find((p) => p.state === 'walk');
    if (!t.check('a pedestrian is available', !!p) || !p) return;
    const saved = { ...p };
    const [x, y] = [w.x, w.y];
    const edge: WalkEdge = { ...p.e, side: 0, width: 4, path: new Polyline([[x - 9, y], [x + 12, y]]) };
    const stage = () => {
      Object.assign(p, {
        e: edge,
        s: 5,
        fwd: true,
        side: 1,
        lane: 0,
        speed: 1.5,
        pause: 0,
        state: 'walk',
        t: 0,
        x: x - 4,
        y,
        h: 0,
        pace: 0,
        dodge: 0,
        dodgeTo: 0,
      });
      Object.assign(w, { x, y, h: Math.PI, speed: 0, side: 0, vx: 0, vy: 0 });
      w.sync();
    };
    try {
      t.paused = true;
      crowd.r = () => .5;
      stage();
      let closest = Infinity, aside = 0;
      for (let i = 0; i < 55; i++) {
        await t.wait(.1);
        closest = Math.min(closest, Math.hypot(p.x - w.x, p.y - w.y));
        aside = Math.max(aside, Math.abs(p.dodge));
      }
      t.check('steps to the side before passing a stationary player', aside > .7 && p.x > x + 2 && closest > .72, {
        aside,
        closest,
        past: p.x - x,
      });
      edge.width = 1.15;
      stage();
      await t.wait(4);
      const waited = p.x;
      await t.wait(1);
      t.check(
        'waits short of the player when there is no room to pass',
        p.x < x - .75 && p.x > x - 2.3 && Math.abs(p.x - waited) < .12,
        x - p.x,
      );
      w.y += 3;
      w.sync();
      await t.wait(3);
      t.check('continues once the doorway clears', p.x > x + 1, p.x - x);
    } finally {
      Object.assign(p, saved);
      w.x = x;
      w.y = y;
      w.sync();
      crowd.r = oldRandom;
      t.paused = paused;
      t.eyes = null;
    }
  },
} satisfies Scenario;
