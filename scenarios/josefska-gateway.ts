import { Mesh, Raycaster, Vector3, type Scene } from 'three';
import type { Scenario } from '../src/testkit.ts';
import type { Walker } from '../src/people.ts';
import type { TileWorld } from '../src/tiles.ts';

// Letenská's lane through the house at the corner of Josefská is mapped as a road
// through the building (tunnel=building_passage): it gets an arched opening and a
// vaulted lining, so walls hide the house's inside wherever you stand in it.
export default {
  title: 'Walk through the vaulted gateway from Letenská into Josefská',
  async run(t) {
    const g = window.__drive as { scene: Scene; walker: Walker; world: TileWorld };
    // On the street a few metres before the arch, facing it.
    await t.go([50.088538, 14.405444], { heading: 95 });
    t.empty(); t.eyes = { yaw: 0, pitch: 0 };
    const w = g.walker;
    const rooms = () => g.scene.children.filter(o => o instanceof Mesh && o.name === 'Covered passage') as Mesh[];
    try {
      const deadline = performance.now() + 30000;
      while (!rooms().length && performance.now() < deadline) await t.frames(2);
      if (!t.check('the gateway lining loads', rooms().length > 0)) return;
      t.check('starts under open sky', g.world.rooftopAt(w.x, w.y) < w.mesh.position.y + 2);
      w.h = 0; // east, along the gateway
      await t.wait(4.5, { move: 1 });
      if (!t.check('walked in under the building', g.world.passageAt(w.x, w.y) && g.world.rooftopAt(w.x, w.y) > w.mesh.position.y + 5,
        `${w.x.toFixed(1)}, ${w.y.toFixed(1)}`)) return;
      const eye = w.mesh.position.clone(); eye.y += 1.75;
      const hit = (dx: number, dy: number, dz: number) =>
        new Raycaster(eye, new Vector3(dx, dy, dz), 0, 30).intersectObjects(rooms(), true)[0]?.distance ?? Infinity;
      // (A lining drawn before a neighbouring tile's façades were known is drawn again.)
      const until = performance.now() + 10000;
      while (hit(0, 1, 0) === Infinity && performance.now() < until) await t.frames(2);
      const up = hit(0, 1, 0);
      t.check('a vault overhead, higher than a walkway ceiling', up > 2 && up < 3.6, up.toFixed(2));
      t.check('walls on both sides', hit(0, 0, -1) < 3 && hit(0, 0, 1) < 3, `${hit(0, 0, -1).toFixed(2)} / ${hit(0, 0, 1).toFixed(2)}`);
      t.check('the way on stays open', hit(1, 0, 0) > 6, hit(1, 0, 0).toFixed(1));
      await t.shot('josefska-gateway');
    } finally { t.eyes = null; }
  },
} satisfies Scenario;
