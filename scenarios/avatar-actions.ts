import type { Scene } from 'three';
import type { Walker } from '../src/people.ts';
import type { Scenario } from '../src/testkit.ts';

export default {
  title: 'Keep the street-level avatar through a jump and recovery',
  async run(t) {
    await t.go('staromak');
    const { scene, walker } = window.__drive as { scene: Scene; walker: Walker };
    t.eyes = { yaw: 0, pitch: 0 };
    try {
      const player = () => scene.getObjectByName('rocketbox')?.children.find(
        (o) => o.visible && o.getObjectByName('Bip01') && o.position.distanceTo(walker.mesh.position) < 0.05);
      const end = performance.now() + 60000;
      while (!player() && performance.now() < end) await t.frames(2);
      const avatar = player();
      if (!t.check('the player has an avatar', !!avatar) || !avatar) return;
      const knee = avatar.getObjectByName('Bip01_L_Calf')!;
      const rest = knee.quaternion.clone();
      await t.wait(1 / 60, { jump: true });
      await t.wait(0.45);
      t.check('the same avatar is airborne', walker.z > 0.4 && player() === avatar);
      t.check('the knee bends during the jump', rest.angleTo(knee.quaternion) > 0.25);
      await t.wait(1);
      t.check('the same avatar lands', walker.z === 0 && player() === avatar);
      walker.knock(0, 0);
      await t.wait(0.65);
      t.check('the avatar falls over', walker.anim.name === 'fall' && player() === avatar);
      await t.wait(3);
      t.check('the avatar recovers', walker.down <= 0 && player() === avatar);
    } finally {
      t.eyes = null;
    }
  },
} satisfies Scenario;
