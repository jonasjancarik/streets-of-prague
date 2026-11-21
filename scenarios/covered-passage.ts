import { Mesh, Raycaster, Vector3, type Scene } from 'three';
import type { Scenario } from '../src/testkit.ts';
import type { Walker } from '../src/people.ts';
import type { TileWorld } from '../src/tiles.ts';

export default {
  title: 'Walk off Vodičkova and into the covered passage of U Nováků',
  async run(t) {
    const g = window.__drive as { scene: Scene; walker: Walker; world: TileWorld };
    // Begin on the pavement about a metre outside the mapped entrance.
    await t.go([50.08084206, 14.42449525], { heading: 127 });
    t.empty(); t.eyes = { yaw: 0, pitch: 0 };
    const w = g.walker, x0 = w.x, y0 = w.y;
    const rooms = () => g.scene.children.filter(o => o instanceof Mesh && o.name === 'Covered passage') as Mesh[];
    try {
      const deadline = performance.now() + 30000;
      while (!rooms().length && performance.now() < deadline) await t.frames(2);
      if (!t.check('the nearby passage interior loads', rooms().length > 0)) return;
      t.check('the pavement starts under open sky', g.world.rooftopAt(w.x, w.y) < w.mesh.position.y + 2);
      await t.wait(3.6, { move: 1 });
      const walked = Math.hypot(w.x - x0, w.y - y0);
      if (!t.check('walked through the entrance under the building', walked > 10 && g.world.passageAt(w.x,w.y) &&
          g.world.rooftopAt(w.x,w.y) > w.mesh.position.y + 5, walked.toFixed(1) + ' m')) return;
      const eye = w.mesh.position.clone(); eye.y += 1.75;
      const hit = (dx: number, dy: number, dz: number) =>
        new Raycaster(eye, new Vector3(dx,dy,dz), 0, 30).intersectObjects(rooms(),false)[0]?.distance ?? Infinity;
      const left = [-Math.sin(w.h),-Math.cos(w.h)];
      t.check('the ceiling is just overhead', hit(0,1,0) > 1 && hit(0,1,0) < 2.2);
      t.check('solid walls on both sides hide the neighbouring building',
        hit(left[0],0,left[1]) < 2 && hit(-left[0],0,-left[1]) < 2);
      t.check('the path ahead stays open', hit(Math.cos(w.h),0,-Math.sin(w.h)) > 6);
      w.h += Math.PI;
      await t.wait(3.9, { move: 1 });
      t.check('can walk back onto the pavement', g.world.rooftopAt(w.x,w.y) < w.mesh.position.y + 2);
      t.eyes = null; await t.frames(3);
      t.check('overhead view releases the lining', rooms().length === 0);
    } finally { t.eyes = null; }
  },
} satisfies Scenario;
