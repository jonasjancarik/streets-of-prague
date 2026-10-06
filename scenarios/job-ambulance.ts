import type { Scenario } from '../src/testkit.ts';

export default {
  title: 'A patient run: picked up with an ambulance, taken to hospital and paid; out of time, it fails',
  async run(t) {
    await t.go('staromak', { heading: 0 });
    t.time('14:00');
    t.weather('clear');
    t.set({ money: 1000, stars: 0 });
    t.clearJobs();
    await t.drive('ambulance');
    let j = t.startJob('ambulance');
    t.check('the job starts with a patient to fetch', j.state === 'on' && j.step === 0 && !!j.at, j);
    await t.toJob(6);
    for (let i = 0; i < 12 && t.job().step === 0; i++) await t.wait(1);
    j = t.job();
    if (!t.check('the patient gets in when you stop beside them', j.step === 1, j)) return;
    await t.toJob(4);
    await t.wait(1.5);
    j = t.job();
    const got = t.probe().money - 1000;
    t.check('at the hospital the run is paid', j.state === 'idle' && j.done.ambulance === 1 && got >= 250, { got, note: j.note });

    t.startJob('ambulance');
    t.jobTime(0.5);
    await t.wait(1);
    j = t.job();
    t.check('out of time, it fails and costs nothing', j.state === 'idle' && j.failed === 1 && t.probe().money === 1000 + got, j);
  },
} satisfies Scenario;
