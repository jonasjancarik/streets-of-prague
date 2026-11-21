import { type Material, Mesh, Raycaster, type Scene, Vector3 } from 'three';
import type { Scenario } from '../src/testkit.ts';

export default {
  title: 'Walk through Divadelní from daylight to the tiled bore and out the other side',
  async run(t) {
    const saved = t.eyes;
    const g = window.__drive as { scene: Scene; walker: { x: number; y: number; gz: number; level: number; h: number } };
    const skyward = new Raycaster(undefined, new Vector3(0, 1, 0));
    const ceiling = () => {
      skyward.ray.origin.set(g.walker.x, g.walker.gz + 1.75, -g.walker.y);
      const roofs: Mesh[] = [];
      g.scene.traverseVisible((o) => {
        if (o instanceof Mesh && o.name === 'Tunnel soffit' && (o.material as Material).visible) roofs.push(o);
      });
      return skyward.intersectObjects(roofs, false)[0]?.distance;
    };
    try {
      await t.go([50.08108, 14.41381], { heading: 350 });
      t.eyes = { yaw: 0, pitch: 0 };
      t.time('14:00');
      t.weather('clear');
      await t.wait(3.5, { move: 1 });
      t.check('the approach is open to the sky', g.walker.level === -1 && ceiling() === undefined, t.where());
      await t.wait(4.5, { move: 1 });
      await t.frames(3);
      const headroom = ceiling();
      t.check('the lined ceiling faces the walker', headroom !== undefined && headroom > 1 && headroom < 4, headroom);
      t.eyes = null;
      await t.frames(3);
      t.check('the overhead cutaway shows the road', ceiling() === undefined);
      t.eyes = { yaw: 0, pitch: 0 };
      g.walker.h = (90 - 355) * Math.PI / 180;
      await t.wait(7, { move: 1 });
      // Beyond the soffit, the lane bends round the corner of the building.
      g.walker.h = (90 - 18) * Math.PI / 180;
      await t.wait(4, { move: 1 });
      t.check(
        'the far exit returns to the open street',
        g.walker.level === 0 && g.walker.y > 2448 && ceiling() === undefined,
        t.where(),
      );
    } finally {
      t.eyes = saved;
    }
  },
} satisfies Scenario;
