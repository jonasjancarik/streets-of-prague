import type { Scenario } from '../src/testkit.ts';

export default {
  title: 'Saved games: one from before there was work opens with clean books; a newer or broken one is refused',
  async run(t) {
    const old = { v: 1, area: 'praha', at: 1, lat: 50.08, lon: 14.42, heading: 0, street: null, car: null, money: 420, ticket: null, health: 100, heat: 0, clock: 50000, weather: { kind: 'clear', fixed: false } };
    const up = t.upgradeSave(old);
    t.check('a version 1 save opens as version 2, money kept', !!up && up.v === 2 && up.money === 420, up);
    t.check('with nothing done and nobody knowing you', !!up && up.jobs.failed === 0 && up.jobs.earned === 0 && Object.keys(up.jobs.done).length === 0 && Object.keys(up.rep).length === 0, up);
    const now = t.upgradeSave({ ...old, v: 2, jobs: { done: { courier: 3 }, failed: 1, earned: 900 }, rep: { couriers: 12 } });
    t.check('a version 2 save keeps its books', !!now && now.jobs.done.courier === 3 && now.rep.couriers === 12, now);
    t.check('a save from a newer version is refused', t.upgradeSave({ ...old, v: 3 }) === null);
    t.check('a version 2 save without books is refused', t.upgradeSave({ ...old, v: 2 }) === null);
    t.check('something that is no save is refused', t.upgradeSave('nonsense') === null && t.upgradeSave(null) === null);
    await t.wait(0.1);
  },
} satisfies Scenario;
