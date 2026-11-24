import type * as THREE from 'three';
import type { Scenario } from '../src/testkit.ts';
import { riverBanks } from '../src/riverReflection.ts';
import { RIVER_MIRROR } from '../src/mirror.ts';

export default {
  title: 'Banks and moving vessels reflect at water level and retire overhead',
  async run(t) {
    const game = window.__drive as {
      graphics: { water: boolean; tier: string; reflections: string }; renderer: THREE.WebGLRenderer & { backend?: { isWebGPUBackend?: boolean } };
      walker: { x: number; y: number; h: number; gz: number; level: number; sync(): void };
      world: { terrainAt(x: number, y: number): number };
    };
    const wasPaused = t.paused;
    try {
      await t.onFoot();
      await t.go([50.08704,14.41028]);
      const [x,y] = t.toLocal([50.08704,14.41028]);
      Object.assign(game.walker, { x, y, h: (90-167)*Math.PI/180, level: 0, gz: game.world.terrainAt(x,y) });
      game.walker.sync(); t.paused = true; t.eyes = { yaw: 0, pitch: -4 };
      if (game.renderer.backend?.isWebGPUBackend && game.graphics.water) {
        const until = performance.now()+45000;
        while (!riverBanks.strength.value && performance.now()<until) await t.frames(3);
        t.check('the two adjacent water-level views cover the camera', riverBanks.strength.value > .9 &&
          riverBanks.b.value.w === riverBanks.a.value.w+1 && riverBanks.mix.value >= 0 && riverBanks.mix.value <= 1);
        if (game.graphics.tier !== 'low' && game.graphics.reflections !== 'none') {
          await t.frames(12);
          t.check('the live silhouette fits the small reflection target', RIVER_MIRROR.active.value === 1 &&
            Math.max(RIVER_MIRROR.target.width,RIVER_MIRROR.target.height) <= 320);
        }
      }
      t.eyes = null; await t.frames(6);
      t.check('the street water and its extra render switch off overhead',
        riverBanks.street.value === 0 && riverBanks.strength.value === 0 && RIVER_MIRROR.active.value === 0);
    } finally { t.eyes = null; t.paused = wasPaused; }
  },
} satisfies Scenario;
