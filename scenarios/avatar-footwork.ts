import { type Scene, Vector3 } from 'three';
import type { Walker } from '../src/people.ts';
import type { Scenario } from '../src/testkit.ts';

export default {
  title: 'Third-person footsteps follow sideways and backwards travel',
  async run(t) {
    // This spot leaves a clear run in both directions. At the named spawn a
    // tree can stop the walker while the test continues holding the same key.
    await t.go([50.08747,14.42108], { heading: 90 });
    const { scene, walker } = window.__drive as { scene: Scene; walker: Walker };
    const wasPaused = t.paused, previousDt = t.frameDt;
    t.paused = true;
    t.eyes = { yaw: 0, pitch: 0, third: true };
    try {
      const player = () => scene.getObjectByName('rocketbox')?.children.find(o =>
        o.visible && o.getObjectByName('Bip01') && o.position.distanceTo(walker.mesh.position) < .05);
      const end = performance.now() + 60000;
      while (!player() && performance.now() < end) await t.frames(2);
      const avatar = player();
      if (!t.check('player model ready', !!avatar) || !avatar) return;
      const origin = walker.mesh.position.clone();
      const forward = new Vector3(Math.cos(walker.h), 0, -Math.sin(walker.h));
      const left = new Vector3(forward.z, 0, -forward.x);
      const facing = new Vector3();
      const step = async (move: number, turn: number) => {
        t.frameDt = 1 / 30;
        await t.wait(1 / 30, { move, turn });
      };
      for (let i = 0; i < 20; i++) await step(0, 1);
      const travel = walker.mesh.position.clone().sub(origin).dot(left);
      t.check('body turns along the sidestep', travel > 1 && avatar.getWorldDirection(facing).dot(left) > .92,
        { travel, alignment: facing.dot(left) });

      for (let i = 0; i < 20; i++) await step(-1, 0);
      t.check('player still faces ahead while backing up', avatar.getWorldDirection(facing).dot(forward) > .94);
      const feet = ['Bip01_L_Foot', 'Bip01_R_Foot'].map(name => avatar.getObjectByName(name)!);
      const sample = () => feet.map(foot => foot.getWorldPosition(new Vector3()).sub(avatar.position));
      let prev = sample(), planted = 0, advance = 0;
      const startBack=walker.mesh.position.clone();
      for (let i = 0; i < 36; i++) {
        await step(-1, 0);
        const next = sample();
        const low = next[0].y < next[1].y ? 0 : 1;
        if (prev[low].y < prev[1-low].y && next[1-low].y - next[low].y > .012) {
          advance += next[low].dot(forward) - prev[low].dot(forward);
          planted++;
        }
        prev = next;
      }
      t.check('the supporting foot moves forward relative to the retreating hips', planted > 6 && advance > .12,
        { samples: planted, metres: advance });
      t.check('the backwards samples covered open pavement',walker.mesh.position.distanceTo(startBack)>1.8);
      for (let i=0;i<24;i++) await step(0,1);
      const landed=avatar.getWorldDirection(new Vector3());
      for (let i=0;i<35;i++) await step(0,0);
      const alignment=avatar.getWorldDirection(facing).dot(landed);
      t.check('stopping a sidestep keeps the landing direction',alignment>.96 && Math.hypot(walker.vx,walker.vy)<.05,{alignment});
    } finally {
      t.frameDt = previousDt;
      t.paused = wasPaused;
      t.eyes = null;
    }
  },
} satisfies Scenario;
