import type { Scenario } from '../src/testkit.ts';

export default {
  title: 'A courier job: offered on the phone, done on foot and paid; out of time, it fails and costs nothing',
  async run(t) {
    await t.go('staromak', { heading: 0 });
    t.time('14:00');
    t.weather('clear');
    t.set({ money: 1000, stars: 0 });
    t.clearJobs();
    // The phone: J asks for work, J again takes it, J twice gives it up.
    let j = t.pressJ();
    if (!t.check('J on foot brings a courier offer', j.state === 'offer' && j.id === 'courier', j)) return;
    j = t.pressJ();
    t.check('J again takes it', j.state === 'on' && j.step === 0 && !!j.at && j.left! > 30, j);
    t.pressJ();
    j = t.pressJ();
    t.check('J twice gives it up, at no cost', j.state === 'idle' && t.probe().money === 1000 && j.failed === 0, j);

    // Done: to the parcel, then to where it goes.
    t.startJob('courier');
    await t.toJob();
    await t.wait(0.5);
    j = t.job();
    t.check('at the first place the parcel is picked up', j.step === 1 && t.bags().carried !== null, { step: j.step, objective: j.objective, bag: t.bags().carried });
    await t.shot('job-courier');
    const pay = j.pay;
    await t.toJob();
    await t.wait(0.5);
    j = t.job();
    const got = t.probe().money - 1000;
    t.check('at the second it is delivered and paid', j.state === 'idle' && j.done.courier === 1 && got >= pay && got <= pay * 1.6, { got, pay, note: j.note });
    t.check('the parcel is off your back', t.bags().carried === null);
    t.check('the couriers think better of you, the taxi drivers worse', j.rep.couriers > 0 && j.rep.taxis < 0, j.rep);

    // Failed: the time runs out.
    t.startJob('courier');
    t.jobTime(0.5);
    await t.wait(1);
    j = t.job();
    t.check('out of time, the job is off', j.state === 'idle' && j.failed === 1 && j.done.courier === 1, j);
    t.check('and failing costs nothing', t.probe().money === 1000 + got && j.rep.couriers > 0, { money: t.probe().money, rep: j.rep });
  },
} satisfies Scenario;
