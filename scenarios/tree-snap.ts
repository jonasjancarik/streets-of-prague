import type { Scenario } from '../src/testkit.ts';
import { onCrash } from '../src/impacts.ts';

// A young or small tree hit hard enough snaps at its foot and falls the way the car was
// going, the car carrying on slowed; hit slowly, it stops the car like any tree.
export default {
  title: 'A car at 40 km/h snaps a young tree and carries on; at 10 km/h the tree stops it',
  async run(t) {
    t.time('14:00');
    t.weather('clear');
    for (const c of [{ kmh: 40, snaps: true }, { kmh: 10, snaps: false }]) {
      let tree = null, car = null;
      for (const place of ['vodickova', 'karlak', 'ujezd', 'letna', 'petrin', 'malostranske']) {
        await t.go(place, { heading: 315 });
        car = await t.drive('hatch');
        // (The young ones: they snap at 20 km/h.)
        if ((tree = t.snappable(300, c.snaps ? 16 : 5, 10, 6))) break;
      }
      if (!tree || !car) { t.check('a young tree with a clear run up to it', true, 'none found: skipped'); continue; }
      await t.wait(0.3, { brake: true });
      const hits: string[] = [];
      const stop = onCrash((e) => { if (e.a === car || Math.hypot(e.x - tree!.x, e.y - tree!.y) < 1) hits.push(`${e.kind} ${(e.speed * 3.6).toFixed(0)} km/h`); });
      const h = Math.atan2(tree.y - car.y, tree.x - car.x);
      t.push(c.kmh);
      let passed = false, speed = 0;
      for (let i = 0; i < 60 && !passed; i++) {
        await t.wait(0.05, { move: c.snaps ? 0.4 : 0 });
        speed = Math.hypot(car.vx, car.vy) * 3.6;
        passed = (car.x - tree.x) * Math.cos(h) + (car.y - tree.y) * Math.sin(h) > 2;
      }
      await t.wait(1.5, { brake: true });
      stop();
      // (It falls in real time, as a lamp post does.)
      await new Promise((r) => setTimeout(r, 1500));
      await t.frames(3);
      const down = t.treeDown(tree.x, tree.y);
      if (c.snaps) {
        t.check('a young tree hit at 40 km/h snapped', down, hits.join(', '));
        t.check('the car carried on past it', passed, `${Math.round(speed)} km/h then`);
        await t.look({ x: tree.x, y: tree.y, h }, { name: 'tree-snap', views: ['top', 'third', 'front-left', 'front-right'] });
      } else {
        t.check('a young tree hit at 10 km/h still stands', !down, hits.join(', '));
        const d = Math.hypot(car.x - tree.x, car.y - tree.y);
        t.check('the car was stopped by it', !passed && d < 5, `${d.toFixed(1)} m from it`);
      }
    }
  },
} satisfies Scenario;
