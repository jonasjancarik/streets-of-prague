import type { Scenario } from '../src/testkit.ts';

// The jobs added on 3 November: a sightseeing tour, bringing a car, wrecking one and a
// getaway. Each is started at once (no first-time talk) and taken through to its pay.
export default {
  title: 'Tour, bring a car, settle a debt and the getaway: each done and paid',
  async run(t) {
    await t.go('staromak', { heading: 0 });
    t.time('14:00');
    t.weather('clear');
    t.set({ money: 1000, stars: 0 });
    t.clearJobs();
    const g = window.__drive as { walker: { x: number; y: number }; grid: { at: (x: number, y: number) => number }; loose: { x: number; y: number }[] };
    const paid = (before: number) => t.probe().money - before;
    // Waits up to `s` seconds for the job to reach a step (or end).
    const until = async (ok: () => boolean, s = 12) => { for (let i = 0; i < s * 2 && !ok(); i++) await t.wait(0.5); return ok(); };

    // The tour: picked up, three sights, back again.
    await t.drive('sedan');
    let j = t.startJob('tour');
    t.check('a tour has five steps', j.steps === 5, j);
    await t.toJob(6);
    if (!t.check('the tourist gets in', await until(() => t.job().step === 1), t.job())) return;
    for (let i = 1; i <= 3; i++) {
      await t.toJob(30);
      t.check(`sight ${i} is passed`, await until(() => t.job().step === i + 1, 3), t.job());
    }
    let money = t.probe().money;
    await t.toJob(4);
    await until(() => t.job().state === 'idle', 4);
    j = t.job();
    t.check('back where they started, the tour is paid', j.done.tour === 1 && paid(money) >= 500, { got: paid(money), note: j.note });
    await t.shot('job-tour');

    // Bring a car: find it, get in, bring it to the yard.
    await t.go('staromak', { heading: 0 });
    t.startJob('fetch');
    await t.toJob(40);
    await until(() => !!t.jobCar(), 4);
    const car = t.jobCar();
    if (!t.check('the car to bring is there', !!car)) return;
    t.enter(car!);
    if (!t.check('getting into it is the first step done', await until(() => t.job().step === 1, 3), t.job())) return;
    money = t.probe().money;
    await t.toJob(5);
    await until(() => t.job().state === 'idle', 4);
    j = t.job();
    t.check('in the yard, it pays', j.done.fetch === 1 && paid(money) >= 300, { got: paid(money), note: j.note });
    t.check('the Regulars know you now', (j.rep.pubs ?? 0) > 0, j.rep);

    // Settle a debt: the car is shot at until it burns out.
    await t.go('staromak', { heading: 0 });
    t.set({ stars: 0 });
    t.startJob('wreck');
    await t.toJob(40);
    await until(() => !!t.jobCar(), 4);
    const debt = t.jobCar();
    if (!t.check('the debtor’s car is there', !!debt)) return;
    // Stand 10 m off it with a clear shot.
    const clear = (x: number, y: number) => {
      if (g.loose.some((c) => c !== debt && Math.hypot(c.x - x, c.y - y) < 4)) return false;
      for (let s = 0; s <= 0.8; s += 0.05) if (g.grid.at(x + (debt!.x - x) * s, y + (debt!.y - y) * s) !== 0) return false;
      return true;
    };
    const spot = Array.from({ length: 16 }, (_, i) => [debt!.x + Math.cos(i * Math.PI / 8) * 10, debt!.y + Math.sin(i * Math.PI / 8) * 10]).find(([x, y]) => clear(x, y));
    if (!t.check('somewhere to shoot it from', !!spot)) return;
    if (t.probe().car) t.exit();
    g.walker.x = spot![0]; g.walker.y = spot![1];
    money = t.probe().money;
    for (let i = 0; i < 20 && debt!.damage < 92; i++) { t.shoot({ x: debt!.x, y: debt!.y }); await t.wait(0.3); }
    t.check('the bullets set it burning', debt!.damage >= 90, `damage ${Math.round(debt!.damage)}`);
    await until(() => t.job().state === 'idle', 30);
    j = t.job();
    t.check('on fire, the debt is settled and paid', j.done.wreck === 1 && paid(money) >= 600, { got: paid(money), note: j.note, burnt: debt!.burnt });

    // The getaway: picked up, the police set on you, lost, dropped off.
    await t.go('staromak', { heading: 0 });
    t.set({ stars: 0 });
    await t.drive('sedan');
    t.startJob('getaway');
    await t.toJob(6);
    if (!t.check('Venca gets in', await until(() => t.job().step === 1), t.job())) return;
    t.check('and the police are after you', t.probe().stars >= 2, t.probe().stars);
    t.check('the drop-off waits while they are', t.job().objective === 'Lose the police', t.job());
    t.set({ stars: 0 });
    t.check('lost, you can go on', await until(() => t.job().step === 2, 2), t.job());
    money = t.probe().money;
    await t.toJob(4);
    await until(() => t.job().state === 'idle', 4);
    j = t.job();
    t.check('dropped off, the getaway pays', j.done.getaway === 1 && paid(money) >= 600, { got: paid(money), note: j.note });
  },
} satisfies Scenario;
