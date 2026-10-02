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
      t.check('the paramedics saw to them and they got up', !t.rescue(p).hurt && s < 150, `after ${s} s: ${JSON.stringify(t.rescue(p))}`);
      for (let i = 0; i < 60 && t.rescue(p).ambulance; i++) await t.wait(1);
      t.check('the ambulance drove off again', t.rescue(p).ambulance === null);

      // Someone badly hurt is carried to the ambulance and taken away.
      await t.go('ujezd', { heading: 180 });
      await t.wait(2);
      const q = t.hurt(true);
      t.check('someone else was close enough to be badly hurt', !!q);
      if (!q) return;
      let loaded = false;
      for (s = 0; s < 150 && !loaded; s++) {
        await t.wait(1);
        loaded = t.rescue(q).carried;
        if (!loaded && t.rescue(q).treated >= 9 && s % 2 === 0) await t.shot('ambulance-carry');
      }
      t.check('the patient was carried to the ambulance and loaded', loaded, `after ${s} s: ${JSON.stringify(t.rescue(q))}`);
      for (let i = 0; i < 80 && t.rescue(q).ambulance; i++) await t.wait(1);
      t.check('and the ambulance drove off with them', t.rescue(q).ambulance === null);

      // Taking an ambulance (a carjack, as with a fire engine): the paramedics who are out run after you.
      await t.go('ujezd', { heading: 180 });
      await t.wait(2);
      const v = t.hurt()!;
      for (s = 0; s < 100 && t.rescue(v).ambulance !== 'work'; s++) await t.wait(1);
      await t.wait(1);
      const chasing = t.steal(v);
      t.check('the ambulance could be taken, with its crew running after you', chasing === 2, `${chasing} after you`);
      t.exit();
    } finally {
      t.unhurt = false;
    }
  },
} satisfies Scenario;
