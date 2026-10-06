import type { Scenario } from '../src/testkit.ts';

export default {
  title: 'A taxi fare: offered when you sit in a taxi, picked up, driven and paid; leave the car and it fails',
  async run(t) {
    await t.go('staromak', { heading: 0 });
    t.time('14:00');
    t.weather('clear');
    t.set({ money: 1000, stars: 0 });
    t.clearJobs();
    t.autoJobs(true);
    try {
      await t.drive('taxi');
      await t.wait(3.5);
      let j = t.job();
      t.check('sitting in a taxi brings a fare offer', j.state === 'offer' && j.id === 'taxi', j);
      t.exit();
      await t.wait(0.5);
      t.check('out of the taxi, the offer is gone', t.job().state === 'idle', t.job());
      t.autoJobs(false);

      // Done.
      await t.go('staromak', { heading: 0 });
      const cab = await t.drive('taxi');
      t.startJob('taxi');
      await t.toJob(6);
      for (let i = 0; i < 12 && t.job().step === 0; i++) await t.wait(1);
      j = t.job();
      if (!t.check('the fare gets in when you stop beside them', j.step === 1, j)) return;
      await t.shot('job-taxi');
      await t.toJob(4);
      await t.wait(1.5);
      j = t.job();
      const got = t.probe().money - 1000;
      t.check('at the address they get out and pay', j.state === 'idle' && j.done.taxi === 1 && got >= 60, { got, note: j.note });
      t.check('the taxi drivers think better of you', j.rep.taxis > 0, j.rep);

      // Failed: you leave the car with the fare in it.
      t.startJob('taxi');
      await t.toJob(6);
      for (let i = 0; i < 12 && t.job().step === 0; i++) await t.wait(1);
      t.exit();
      await t.wait(10);
      t.check('out of the car, the job waits for you a while', t.job().state === 'on' && t.job().out >= 8, t.job());
      await t.wait(12);
      j = t.job();
      t.check('too long, and it fails', j.state === 'idle' && j.failed === 1 && t.probe().money === 1000 + got, j);
      void cab;
    } finally {
      t.autoJobs(false);
    }
  },
} satisfies Scenario;
