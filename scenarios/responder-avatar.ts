import type { Scene } from 'three';
import type { Crowd, Walker } from '../src/people.ts';
import type { Officer, Police } from '../src/police.ts';
import type { Scenario } from '../src/testkit.ts';

// A patrol arriving after every avatar slot is occupied used to stay a simple
// figure indefinitely, even when the player was standing right beside it.
export default {
  title: 'A nearby officer gets a uniformed avatar in a full crowd',
  async run(t) {
    await t.go([50.08727, 14.4211], { heading: 265 });
    const { crowd, walker, police, scene } = window.__drive as { crowd: Crowd; walker: Walker; police: Police; scene: Scene };
    const car = t.car('police', { ahead: 7 });
    const people = crowd.people.slice(0, 26).map(p => ({ p, x: p.x, y: p.y }));
    const shown = () => scene.getObjectByName('rocketbox')?.children.filter(o => o.visible && o.getObjectByName('Bip01')) ?? [];
    const until = async (ok: () => boolean) => {
      const end = performance.now() + 30000;
      while (!ok() && performance.now() < end) await t.frames(2);
      return ok();
    };
    const paused = t.paused;
    let officer: Officer | undefined;
    try {
      t.paused = true;
      people.forEach(({ p }, i) => {
        const angle = i * Math.PI * 2 / people.length;
        p.x = walker.x + Math.cos(angle) * 7;
        p.y = walker.y + Math.sin(angle) * 7;
      });
      t.eyes = { yaw: 0, pitch: 0 };
      if (!t.check('the square has filled the avatar pool', await until(() => shown().length >= 24))) return;
      const count = shown().length;
      police.getOut(car);
      officer = police.officers[police.officers.length - 1];
      officer.x = walker.x + 2.5;
      officer.y = walker.y;
      const byOfficer = () => shown().some(o => Math.hypot(o.position.x - officer!.x, o.position.z + officer!.y) < 0.03);
      t.check('the arriving officer is drawn life size', await until(byOfficer));
      t.check('the pool stays within its previous count', shown().length <= count, shown().length);
      t.eyes = null;
      await t.frames(4);
      t.check('the officer returns to the overhead figure', officer.fig.mesh.instanceMatrix.array[15] === 1 &&
        Math.abs(officer.fig.mesh.instanceMatrix.array[5]) > 0.5 && !byOfficer());
    } finally {
      for (const { p, x, y } of people) { p.x = x; p.y = y; }
      if (officer) {
        police.dismiss(officer);
        police.officers.splice(police.officers.indexOf(officer), 1);
      }
      t.paused = paused;
      t.eyes = null;
    }
  },
} satisfies Scenario;
