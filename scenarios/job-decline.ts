import type { Scenario } from '../src/testkit.ts';

export default {
  title: 'Turning a job offer down (K) brings the next one straight away, and K with nothing on offer does nothing',
  async run(t) {
    await t.go('staromak', { heading: 0 });
    t.time('14:00');
    t.weather('clear');
    t.set({ money: 1000, stars: 0 });
    t.clearJobs();
    let j = t.pressK();
    t.check('K with nothing on offer does nothing', j.state === 'idle', j);
    j = t.pressJ();
    if (!t.check('J brings an offer', j.state === 'offer', j)) return;
    const first = j.id;
    j = t.pressK();
    t.check('K turns it down and another is offered at once', j.state === 'offer' && j.id !== first, { first, j });
    j = t.pressJ();
    t.check('the new one can be taken', j.state === 'on', j);
    t.check('and costs nothing', t.probe().money === 1000 && j.failed === 0, j);
  },
} satisfies Scenario;
