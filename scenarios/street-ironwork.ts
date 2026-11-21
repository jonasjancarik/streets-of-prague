import { InstancedMesh, Matrix4, type Scene, Vector3 } from 'three';
import type { Scenario } from '../src/testkit.ts';

export default {
  title: 'Walk up to the surveyed drain on Seminářská',
  async run(t) {
    await t.go([50.08622610, 14.41706955]);
    const g = window.__drive as { scene: Scene; graphics: { tier: string } };
    const meshes = () =>
      g.scene.children.filter((o) => o instanceof InstancedMesh && o.name === 'Street ironwork') as InstancedMesh[];
    t.eyes = { yaw: 0, pitch: -54 };
    try {
      if (g.graphics.tier === 'lowest') {
        await t.frames(5);
        t.check('lowest keeps the ground marks', meshes().every((m) => !m.visible));
        return;
      }
      const limit = performance.now() + 30000;
      while (!meshes().some((m) => m.visible) && performance.now() < limit) await t.frames(3);
      const drain = meshes().find((m) => m.userData.casting === 2);
      if (!t.check('a close street grate is drawn', !!drain?.visible) || !drain) return;
      const [x, y] = t.toLocal([50.08622610, 14.41706955]), p = new Vector3(), m = new Matrix4();
      let nearest = Infinity;
      for (let i = 0; i < drain.count; i++) {
        drain.getMatrixAt(i, m);
        p.setFromMatrixPosition(m);
        nearest = Math.min(nearest, Math.hypot(x - p.x, y + p.z));
      }
      t.check('the grate sits on the mapped point', nearest < .05, nearest);
      t.check('nearby castings are capped', meshes().reduce((n, m) => n + (m.visible ? m.count : 0), 0) <= 32);
      const ids = meshes().map((m) => m.uuid).join();
      t.eyes = null;
      await t.frames(5);
      t.check('overhead releases the close view', meshes().every((m) => !m.visible));
      t.eyes = { yaw: 0, pitch: 0 };
      await t.frames(5);
      t.check('revisiting reuses the same four batches', ids === meshes().map((m) => m.uuid).join() && drain.visible);
    } finally {
      t.eyes = null;
    }
  },
} satisfies Scenario;
