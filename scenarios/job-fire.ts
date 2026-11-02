import type { Scenario } from '../src/testkit.ts';

export default {
  title: 'A fire call: a car burns where the job sends you, your cannon puts it out and you are paid; left to burn, it blows up and the job fails',
  async run(t) {
    await t.go('staromak', { heading: 0 });
    t.time('14:00');
    t.weather('clear');
    t.set({ money: 1000, stars: 0 });
    t.clearJobs();
    t.unhurt = true;
    try {
      await t.drive('fire');
      let j = t.startJob('fire');
      t.check('the call is some way off', j.state === 'on' && j.away! > 150, j);
      await t.toJob(60);
      await t.wait(1.5);
      const car = t.jobCar();
      if (!t.check('near the place, a car is on fire', !!car && t.fire(car).burning, car ? t.fire(car) : t.job())) return;
      t.check('no engine but yours is sent to it', t.fire(car!).engine === null, t.fire(car!));
      t.aimAtCar(car!, 13);
      t.cannon(true);
      let out = -1;
      for (let s = 0; s < 20 && out < 0; s++) {
        await t.wait(1);
        if (s === 2) await t.shot('job-fire');
        if (t.job().state !== 'on') out = s + 1;
      }
      t.cannon(false);
      j = t.job();
      const got = t.probe().money - 1000;
      t.check('the cannon puts it out and the call is paid', j.state === 'idle' && j.done.fire === 1 && got >= 400 && !car!.burnt, { out, got, note: j.note });

      // Failed: the next one is left to burn.
      t.exit();
      await t.go('staromak', { heading: 0 });
      await t.drive('fire');
      t.startJob('fire');
      await t.toJob(60);
      await t.wait(1.5);
      const second = t.jobCar();
      if (!t.check('the next call has a burning car too', !!second && t.fire(second).burning)) return;
      for (let s = 0; s < 100 && t.job().state === 'on'; s += 5) await t.wait(5);
      j = t.job();
      t.check('left alone it blows up and the job fails', j.state === 'idle' && j.failed === 1 && !!second!.burnt && t.probe().money === 1000 + got, { j, burnt: !!second!.burnt });
    } finally {
      t.cannon(false);
      t.unhurt = false;
    }
  },
} satisfies Scenario;
