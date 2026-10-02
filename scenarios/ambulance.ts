import type { Scenario } from '../src/testkit.ts';

export default {
  title: 'An ambulance comes to someone lying hurt, the paramedics see to them and they get up',
  async run(t) {
    t.exit();
    await t.go('ujezd', { heading: 180 });
    t.time('14:00');
    t.weather('clear');
    t.unhurt = true;
    try {
      await t.wait(2);
      const p = t.hurt();
      t.check('someone was close enough to be left hurt', !!p);
      if (!p) return;
      let s = 0, arrived = -1, shot = false;
      for (; s < 150 && t.rescue(p).hurt; s++) {
        await t.wait(1);
        const r = t.rescue(p);
        if (arrived < 0 && r.ambulance === 'work') arrived = s;
        if (!shot && r.medics > 0 && r.treated > 2) { shot = true; await t.shot('ambulance'); }
      }
      t.check('an ambulance got to them', arrived >= 0, `after ${arrived} s`);
      t.check('the paramedics saw to them and they got up', !t.rescue(p).hurt && s < 150, `after ${s} s`);
      for (let i = 0; i < 60 && t.rescue(p).ambulance; i++) await t.wait(1);
      t.check('the ambulance drove off again', t.rescue(p).ambulance === null);
    } finally {
      t.unhurt = false;
    }
  },
} satisfies Scenario;
