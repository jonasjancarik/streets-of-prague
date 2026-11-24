import type * as THREE from 'three';
import type { Scenario } from '../src/testkit.ts';

export default {
  title: 'Middle-distance walkers share their photographed outfits and replace their simple instances',
  async run(t) {
    t.time('15:20'); t.weather('clear'); t.season('09-15');
    await t.go('staromak', { heading: 129 });
    const game = window.__drive as {
      scene: THREE.Scene; crowd: { fig: { mesh: THREE.InstancedMesh } };
      graphics: { tier: string }; lifeSize: { enabled: boolean; avatars?: { middle: { enabled: boolean }; live: Map<string, unknown> } };
    };
    const meshes = () => {
      const found: THREE.InstancedMesh[] = [];
      game.scene.traverse(o => { if (o.name.startsWith('Street crowd ') && o.visible) found.push(o as THREE.InstancedMesh); });
      return found;
    };
    const wasPaused = t.paused;
    let previous: boolean | undefined;
    try {
      t.paused = true; t.eyes = { yaw: 0, pitch: 0 };
      if (!game.lifeSize.enabled || ['low', 'lowest'].includes(game.graphics.tier)) {
        await t.frames(4);
        t.check('the compact tier keeps the original crowd batches', !meshes().length);
        return;
      }
      const end = performance.now() + 90000;
      while (!meshes().length && performance.now() < end) await t.frames(3);
      const actors = game.lifeSize.avatars;
      if (!t.check('textured crowd batches reached the square', !!actors && meshes().length > 0) || !actors) return;
      previous = actors.middle.enabled;
      actors.middle.enabled = false;
      await t.frames(12);
      const original = game.crowd.fig.mesh.count + actors.live.size;
      actors.middle.enabled = true;
      await t.frames(12);
      const shown = meshes(), mid = shown.reduce((sum, mesh) => sum + mesh.count, 0);
      t.check('walkers change model without being drawn twice', mid > 0 && original === game.crowd.fig.mesh.count + actors.live.size + mid,
        { original, simple: game.crowd.fig.mesh.count, full: actors.live.size, middle: mid });
      t.check('the wardrobe uses at most one batch per identity', new Set(shown.map(m => m.name)).size === shown.length && shown.length <= 14);
      t.eyes = null; await t.frames(5);
      t.check('no middle-distance batches draw overhead', !meshes().length);
    } finally {
      if (previous !== undefined && game.lifeSize.avatars) game.lifeSize.avatars.middle.enabled = previous;
      t.eyes = null; t.paused = wasPaused;
    }
  },
} satisfies Scenario;
