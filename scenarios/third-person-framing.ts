import type { PerspectiveCamera } from 'three';
import type { Walker } from '../src/people.ts';
import type { Scenario } from '../src/testkit.ts';

export default {
  title: 'Keep the player in frame when a wall pushes the third-person camera forward',
  async run(t) {
    await t.go('vodickova');
    const { walker, grid, camera } = window.__drive as {
      walker: Walker; grid: { at(x: number, y: number): number }; camera: PerspectiveCamera;
    };
    const poses: { tight?: { x: number; y: number; h: number }; open?: { x: number; y: number; h: number } } = {};
    for (let r = 0; r <= 25 && (!poses.tight || !poses.open); r += .5) {
      for (let k = 0; k < 16; k++) {
        const x = walker.x + r * Math.cos(k * Math.PI / 8), y = walker.y + r * Math.sin(k * Math.PI / 8);
        if (walker.blocked(x, y)) continue;
        for (let j = 0; j < 12; j++) {
          const h = j * Math.PI / 6, fx = Math.cos(h), fy = Math.sin(h);
          if (grid.at(x + fx, y + fy) || grid.at(x + 3 * fx, y + 3 * fy)) continue;
          const wall = [.5, .75, 1, 1.5, 2, 2.5, 3, 3.6, 4].find(d => grid.at(x - fx * d, y - fy * d));
          if (!poses.tight && wall !== undefined && wall <= .75) poses.tight = { x, y, h };
          if (!poses.open && wall === undefined) poses.open = { x, y, h };
        }
      }
    }
    if (!t.check('found open pavement and a wall behind the player', !!(poses.open && poses.tight)) || !poses.tight || !poses.open) return;
    const previousDt = t.frameDt, wasPaused = t.paused;
    try {
      t.paused = true;
      t.eyes = { yaw: 0, pitch: 0, third: true };
      for (const [name, pose] of Object.entries(poses)) {
        Object.assign(walker, pose); walker.sync();
        for (let i = 0; i < 32; i++) { t.frameDt = 1/30; await t.frames(1); }
        camera.updateMatrixWorld();
        const feet = walker.mesh.position.clone(), head = feet.clone();
        head.y += 1.55;
        const back = Math.hypot(feet.x - camera.position.x, feet.z - camera.position.z);
        const top = head.project(camera), bottom = feet.project(camera);
        if (name === 'tight') {
          t.check('wall shortened the camera distance', back < 1.6, back);
          t.check('head and shoulders stay on screen at neutral pitch', Math.abs(top.x) < .9 && top.y > -.85 && top.y < .85, top.toArray());
        } else {
          t.check('camera has room to follow', back > 3, back);
          t.check('feet are in frame in open space', bottom.y > -1 && bottom.y < -.3, bottom.toArray());
        }
      }
    } finally { t.eyes = null; t.paused = wasPaused; t.frameDt = previousDt; }
  },
} satisfies Scenario;
