import type * as THREE from 'three';
import type { Scenario } from '../src/testkit.ts';
import type { Bridge } from '../src/statues.ts';

export default {
  title: 'The real Hradčany roofline appears beyond the nearby bridge tiles in clear air',
  async run(t) {
    await t.onFoot(); await t.go([50.08663,14.41024]);
    const d = window.__drive as {
      scene: THREE.Scene; world: { charles: Bridge; lowestBridge(x: number,y: number): { level: number; h: number } | null };
      walker: { x: number; y: number; h: number; gz: number; level: number; sync(): void };
    };
    const site = d.world.charles.statues.find(s=>s.spec.look==='nepomuk')!;
    const x=site.x+site.fx*5, y=site.y+site.fy*5, deck=d.world.lowestBridge(x,y);
    if (!t.check('the camera is on the Charles Bridge walkway', !!deck) || !deck) return;
    const [tx,ty]=t.toLocal([50.09077,14.40052]);
    const paused=t.paused;
    try {
      t.time('15:30'); t.season('09-15'); t.weather('clear'); t.paused=true;
      Object.assign(d.walker,{x,y,h:Math.atan2(ty-y,tx-x),level:deck.level,gz:deck.h}); d.walker.sync();
      t.eyes={yaw:0,pitch:4};
      const ridge = () => d.scene.getObjectByName('Distant Hradčany');
      const until=performance.now()+40000;
      while (!ridge()?.visible && performance.now()<until) await t.frames(3);
      const shown=ridge()?.children.filter(v=>v.visible) ?? [];
      t.check('one or two depth views draw the distant ridge', !!ridge()?.visible && shown.length>=1 && shown.length<=2, { draws: shown.length });
      t.eyes=null; await t.frames(6);
      t.check('normal overhead zoom retires the ridge', !ridge()?.visible);
      t.weather('mist'); t.eyes={yaw:0,pitch:4}; await t.frames(15);
      t.check('thick mist hides the remote skyline', !ridge()?.visible);
    } finally { t.eyes=null; t.paused=paused; t.weather('clear'); }
  },
} satisfies Scenario;
