import type { Scenario } from '../src/testkit.ts';
import type { Trams } from '../src/trams.ts';

// Enter the street camera beside each type, change its door state, walk out of
// detail range and return. Each articulated section should keep its own pose.
export default {
  title: 'All five tram types have glazed cabins, working doors and route displays at street level',
  async run(t) {
    await t.go('vodickova');
    const g = window.__drive as { trams: Trams; walker: { x: number; y: number; h: number } };
    const tm = g.trams, w = g.walker;
    const line = tm.lines.find(l => l.ref === '9' && l.halts.some(s => s.name === 'Vodičkova'));
    if (!line) throw new Error('Line 9 is missing at Vodičkova');
    const at = line.halts.find(s => s.name === 'Vodičkova')!.s, p = line.path.at(at - 15);
    const paused = t.paused;
    t.paused = true;
    try {
      for (const kind of ['T3', '15T', '14T', 'KT8', '52T']) {
        t.eyes = null;
        const v = tm.add(line, at - 15);
        try {
          v.kind = kind; v.dwell = 20;
          w.x = p.x + Math.sin(p.ang) * 5; w.y = p.y - Math.cos(p.ang) * 5; w.h = p.ang + Math.PI / 2;
          await t.frames(3);
          const look = v.look;
          if (!look || !t.check(kind + ' has its overhead board', look.sign.visible)) continue;
          const low = look.sections[0].geometry;
          t.eyes = { yaw: 0, pitch: 0 };
          for (let i = 0; i < 180 && !look.street?.visible; i++) await t.frames(2);
          if (!t.check(kind + ' switches to its street model', !!look.street?.visible && !look.sign.visible)) continue;
          const detailed = look.sections[0].geometry;
          t.check(kind + ' opens to let people board', look.sections.every(m => m.morphTargetInfluences?.[0] === 1));
          t.check(kind + ' has modeled moving leaves', look.sections.some(m =>
            m.geometry.morphAttributes.position?.[0].array.some(n => Math.abs(n) > .10)));
          v.dwell = 0;
          tm.sync(w.x, w.y, 100, () => 0, true, 1);
          t.check(kind + ' shuts to depart', look.sections.every(m => m.morphTargetInfluences?.[0] === 0));
          t.eyes = null; await t.frames(3);
          t.check(kind + ' returns to its original roof and body', look.sign.visible && look.sections[0].geometry === low);
          t.eyes = { yaw: 0, pitch: 0 }; await t.frames(3);
          t.check(kind + ' reuses its fitted body', look.sections[0].geometry === detailed);
        } finally { tm.remove(v); }
      }
    } finally { t.eyes = null; t.paused = paused; }
  },
} satisfies Scenario;
