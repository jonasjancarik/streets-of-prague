import { Mesh, type PerspectiveCamera, Raycaster, type Scene, Vector3 } from 'three';
import type { Scenario } from '../src/testkit.ts';
import type { Walker } from '../src/people.ts';

export default {
  title: 'Look into the bookshop window on Seminářská and walk back into open space',
  async run(t) {
    const g = window.__drive as { walker: Walker; camera: PerspectiveCamera; scene: Scene };
    const w = g.walker, c = g.camera, original = t.eyes;
    try {
      const at: [number, number] = [50.08617448837321, 14.417026803206353];
      await t.go(at, { heading: 124 });
      t.empty();
      t.stand(at);
      w.speed =
        w.vx =
        w.vy =
        w.side =
          0;
      w.sync();
      t.eyes = { yaw: 0, pitch: 0 };
      t.time('14:00');
      t.weather('clear');
      await t.wait(1.75, { move: 1 });
      await t.frames(5);
      const eye = Math.hypot(c.position.x - w.x, c.position.z + w.y);
      t.check('the eye stays close to the body at the wall', eye < .23 && c.near < .10, { eye, near: c.near });
      const ray = new Raycaster(), dir = new Vector3();
      ray.far = .9;
      const surface = () => {
        ray.set(c.position, c.getWorldDirection(dir));
        const fronts: Mesh[] = [];
        g.scene.traverseVisible((o) => {
          if (o instanceof Mesh && o.geometry.hasAttribute('facade')) fronts.push(o);
        });
        return ray.intersectObjects(fronts, false)[0];
      };
      const deadline = performance.now() + 15000;
      let hit = surface();
      while (!hit && performance.now() < deadline) {
        await t.frames(4);
        hit = surface();
      }
      t.check('the rendered window is in front of the near plane', !!hit && hit.distance > c.near, {
        distance: hit?.distance,
        near: c.near,
        at: t.where(),
      });
      await t.wait(1.4, { move: -1 });
      const relax = performance.now() + 2500;
      while ((c.near !== .2 || Math.hypot(c.position.x - w.x, c.position.z + w.y) < .29) && performance.now() < relax) {
        await t.frames(2);
      }
      t.check(
        'the outdoor near plane and eye position return',
        c.near === .2 && Math.hypot(c.position.x - w.x, c.position.z + w.y) > .29,
        { near: c.near, eye: Math.hypot(c.position.x - w.x, c.position.z + w.y), at: t.where() },
      );
    } finally {
      t.eyes = original;
    }
  },
} satisfies Scenario;
