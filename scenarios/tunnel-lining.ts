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
    async function walkTo(x: number, y: number) {
      // Steer to each bend by its position. A passer-by can slow the walker
      // down without changing where the lane turns towards the open street.
      for (let i = 0; i < 120; i++) {
        const dx = x - g.walker.x, dy = y - g.walker.y;
        if (Math.hypot(dx, dy) < .45) return;
        g.walker.h = Math.atan2(dy, dx);
        await t.wait(.12, { move: 1 });
      }
      throw Error('Could not reach the bend in Divadelní: ' + JSON.stringify(t.where()));
    }
    try {
      await t.go([50.08108, 14.41381], { heading: 350 });
      t.eyes = { yaw: 0, pitch: 0 };
      t.empty();
      t.time('14:00');
      t.weather('clear');
      await walkTo(-3709, 2397.2);
      // (On the street's own floor here since November 2026, pipeline/terrain_floors.json:
      // the tunnel's level starts a few metres before the mouth.)
      t.check('the approach is open to the sky', ceiling() === undefined, { ...t.where(), level: g.walker.level });
      await walkTo(-3711.7, 2412.2);
      await t.frames(3);
      const headroom = ceiling();
      t.check('the lined ceiling faces the walker', headroom !== undefined && headroom > 1 && headroom < 4, headroom);
      t.eyes = null;
      await t.frames(3);
      t.check('the overhead cutaway shows the road', ceiling() === undefined);
      t.eyes = { yaw: 0, pitch: 0 };
      await walkTo(-3714, 2438.2);
      // Beyond the soffit, the lane bends round the corner of the building.
      await walkTo(-3709.6, 2451.9);
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
