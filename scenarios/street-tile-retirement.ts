import { Mesh, type Scene } from 'three';
import type { Scenario } from '../src/testkit.ts';
import type { TileWorld } from '../src/tiles.ts';

export default {
  title: 'Release the previous neighborhood’s draw objects, then revisit it on foot',
  async run(t) {
    const { world, scene, renderer } = window.__drive as {
      world: TileWorld;
      scene: Scene;
      renderer: { _objects?: { _renderObjects?: Set<{ object: Mesh }> } };
    };
    const previous = t.eyes, watched = new Set<Mesh>(), disposed = new Set<Mesh>();
    const remember = (o: Mesh) => {
      if (!watched.has(o)) {
        watched.add(o);
        o.addEventListener('dispose', onDispose);
      }
    };
    function onDispose(e: { target: Mesh }) {
      disposed.add(e.target);
    }
    try {
      t.eyes = { yaw: 0, pitch: 0 };
      await t.go('vodickova');
      await t.frames(6);
      const tile = world.tileAt(t.where().x, t.where().y);
      if (!t.check('the initial street tile is drawn', !!tile?.drawn) || !tile?.drawn) return;
      const key = tile.k;
      tile.drawn.surfaces.group.traverse((o) => {
        if (o instanceof Mesh) remember(o);
      });
      scene.traverse((o) => {
        if (o instanceof Mesh && (o.name === 'Street façade' || o.name === 'Covered passage')) remember(o);
      });
      t.check('the test includes ground meshes with shared materials', watched.size > 4);
      await t.go('petrin');
      await t.frames(5);
      t.check('leaving releases every tracked object', !world.loaded.has(key) && disposed.size === watched.size, {
        tracked: watched.size,
        disposed: disposed.size,
      });
      const draws = renderer._objects?._renderObjects;
      if (draws) {
        t.check(
          'the WebGPU renderer no longer holds a previous street mesh',
          [...draws].every((draw) => !watched.has(draw.object)),
        );
      }
      await t.go('vodickova');
      await t.frames(5);
      const reloaded = world.loaded.get(key);
      t.check(
        'the street draws again with fresh objects',
        !!reloaded?.drawn && reloaded.drawn.surfaces.group.children.some((o) => o instanceof Mesh && !watched.has(o)),
      );
    } finally {
      for (const o of watched) o.removeEventListener('dispose', onDispose);
      t.eyes = previous;
    }
  },
} satisfies Scenario;
