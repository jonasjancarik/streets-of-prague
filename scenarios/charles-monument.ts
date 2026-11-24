import type * as THREE from 'three';
import type { Scenario } from '../src/testkit.ts';
import type { RailSegment } from '../src/bridgeStone.ts';
import { nearestRailFoot } from '../src/bridgeStone.ts';
import type { Bridge } from '../src/statues.ts';

export default {
  title: 'The bronze and its halo appear on the bridge, with the gas lanterns seated on the parapet',
  async run(t) {
    await t.onFoot();
    await t.go([50.08663, 14.41027]);
    const game = window.__drive as {
      scene: THREE.Scene;
      walker: { x: number; y: number; gz: number; h: number; level: number; sync(): void };
      world: { charles: Bridge; lowestBridge(x: number, y: number): { h: number; level: number } | null };
      lamps: {
        xy: number[]; bridgeRails: Map<string, RailSegment[]>;
        parapetLamps: Map<number, { x: number; y: number; deck?: number }>;
      };
    };
    const paused = t.paused;
    try {
      t.paused = true; t.eyes = { yaw: 0, pitch: 13 };
      const site = game.world.charles.statues.find(s => s.spec.look === 'nepomuk')!;
      const x = site.x + site.fx*5, y = site.y + site.fy*5, deck = game.world.lowestBridge(x,y);
      if (!t.check('the player is on the bridge walkway', !!deck) || !deck) return;
      Object.assign(game.walker, { x, y, gz: deck.h, level: deck.level, h: Math.atan2(-site.fy,-site.fx) });
      game.walker.sync();
      const model = () => game.scene.getObjectByName('John of Nepomuk in bronze');
      const stonework = () => game.scene.getObjectByName('Charles Bridge stone vaults');
      const deadline = performance.now() + 45000;
      while ((!model() || !stonework()?.visible || !game.lamps.bridgeRails.size) && performance.now() < deadline) await t.frames(3);
      const bronze = model();
      if (!t.check('the street monument is standing in its mapped place', !!bronze) || !bronze) return;
      const tile = bronze.parent as THREE.Mesh;
      const complete = tile.geometry.getAttribute('position').count, range = tile.geometry.drawRange;
      t.check('the street figure replaces its overhead geometry', range.count < complete);
      const parts: THREE.Mesh[] = [];
      bronze.traverse(o => { if ((o as THREE.Mesh).isMesh) parts.push(o as THREE.Mesh); });
      t.check('figure, five stars and reliefs share a single mesh', parts.length === 1);
      t.check('the vaults are visible from the street', stonework()?.visible === true);
      const { lamps } = game;
      let checked = 0, worstOffset = 0;
      for (const [index, lamp] of lamps.parapetLamps) {
        if (lamp.deck === undefined) continue;
        const foot = nearestRailFoot(lamp.x, lamp.y, lamps.bridgeRails.values());
        if (!foot) continue;
        checked++;
        worstOffset = Math.max(worstOffset, Math.hypot(foot[0] - lamps.xy[2*index], foot[1] - lamps.xy[2*index+1], foot[2] - lamp.deck));
      }
      t.check('the lantern bases meet the centres and heights of the stone caps', checked > 0 && worstOffset < .01, { checked, worstOffset });
      t.eyes = null; await t.frames(5);
      t.check('the full original tile draw returns overhead', !model() && tile.geometry.drawRange.count >= complete);
      t.check('the additional arch meshes retire overhead', stonework()?.visible === false);
    } finally { t.eyes = null; t.paused = paused; }
  },
} satisfies Scenario;
