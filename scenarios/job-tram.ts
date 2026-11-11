import type { Scenario } from '../src/testkit.ts';

export default {
  title: 'A tram shift: each stop you serve pays, five make the shift; leave the cab and it fails',
  async run(t) {
    await t.go('ujezd', { heading: 0 });
    t.time('14:00');
    t.weather('clear');
    t.set({ money: 1000, stars: 0 });
    t.clearJobs();
    await t.wait(2);
    t.takeTram();
    await t.wait(0.5);
    let j = t.startJob('tram');
    t.check('the shift starts in the cab', j.state === 'on' && !!t.tram(), j);
    // (More than the shift's 4 minutes: queued behind a tram that waits for a car parked
    // on the track, or for a fire engine at work, the five stops can take longer. This
    // checks the stops and the pay, not the clock.)
    t.jobTime(600);
    // Drive: up to speed, slow down for the stop ahead, open the doors at it, wait, go on.
    let served: string | null = null, paidAfterOne = 0, shot = false;
    for (let s = 0; s < 900 && t.job().state === 'on'; s += 0.5) {
      const tram = t.tram();
      if (!tram) break;
      const v = tram.speed / 3.6;
      let move = 1;
      if (tram.doors) { move = 0; served = tram.at ?? served; if (!shot) { shot = true; await t.shot('job-tram'); } }
      else if (tram.at && tram.at !== served && v < 0.3) { t.tramDoors(); move = 0; }
      else if (tram.at && tram.at !== served) move = -1;
      else if (tram.next && tram.next.name !== served) move = v > Math.sqrt(2 * 0.9 * Math.max(0, tram.next.dist - 4)) ? -1 : v < 11 ? 1 : 0;
      else move = v < 11 ? 1 : 0;
      await t.wait(0.5, { move });
      if (!paidAfterOne && t.job().state === 'on' && t.job().pay > 0) paidAfterOne = t.job().pay;
    }
    j = t.job();
    const got = t.probe().money - 1000;
    t.check('a served stop adds to the pay', paidAfterOne >= 60, { paidAfterOne });
    t.check('five stops make the shift, and it is paid', j.state === 'idle' && j.done.tram === 1 && got >= 300, { got, j, tram: t.tram() });

    // Failed: out of the cab.
    if (!t.tram()) return;
    t.startJob('tram');
    for (let s = 0; s < 30 && (t.tram()?.speed ?? 0) > 3; s++) await t.wait(0.5, { move: -1 });
    t.exit();
    await t.wait(22);
    j = t.job();
    t.check('out of the cab for too long, the shift fails', j.state === 'idle' && j.failed === 1, { j, mode: t.probe().mode });
  },
} satisfies Scenario;
