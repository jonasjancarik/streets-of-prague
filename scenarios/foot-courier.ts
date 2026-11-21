import type { Scenario } from '../src/testkit.ts';
import type { Walker } from '../src/people.ts';
import type { Missions } from '../src/missions.ts';
import type { Dialog } from '../src/portraits.ts';
import type { Bags } from '../src/bags.ts';
import { Polyline } from '../src/network.ts';
import { project } from '../src/assist.ts';

export default {
  title: 'Walk a neighbourhood delivery and hand the parcel over in person',
  async run(t) {
    const { walker, missions, bags, dialog } = window.__drive as { walker: Walker; missions: Missions; bags: Bags; dialog: Dialog };
    const saved = t.eyes;
    await t.go([50.08084206, 14.42449525], { heading: 127 });
    try {
      t.clearJobs();
      t.eyes = { yaw: 0, pitch: 0 };
      t.time('14:00');
      t.weather('clear');
      await t.frames(3);
      const money = t.probe().money;
      t.offerJob('courier');
      const offer = t.job();
      if (!t.check('the phone offers a local courier job', offer.state === 'offer' && offer.id === 'courier', offer)) return;
      t.pressJ();
      if (!t.check('the dispatcher explains the handoff', dialog.active)) return;
      dialog.next();
      await t.wait(.1);
      for (const [i, label] of ['Take parcel', 'Hand over parcel'].entries()) {
        const target = missions.target();
        if (!t.check('the job marks a person waiting nearby', !!target && !!missions.handoff, target) || !target) return;
        for (let n = 0; n < 45 && !t.navLine(); n++) await t.frames(1);
        const first = t.navLine();
        if (!t.check('walking directions lead to the handoff', !!first && !!t.nav().to?.job, t.nav())) return;
        // Aim along the minimap line and walk with the same controls as the player.
        let walked = 0;
        for (let n = 0; n < 360 && !missions.handoffLabel(); n++) {
          const route = t.navLine(), end = Math.hypot(target.x - walker.x, target.y - walker.y);
          let aim = target;
          if (route && end > 6) {
            const path = new Polyline(route.pts), on = project(path, walker.x, walker.y);
            aim = path.at(on.s + (on.d > 2 ? .5 : 2));
          }
          const { x, y } = walker;
          walker.h = Math.atan2(aim.y - y, aim.x - x);
          await t.wait(.18, { move: 1 });
          walked += Math.hypot(walker.x - x, walker.y - y);
        }
        if (!t.check('walked into reach without automatically exchanging the parcel', missions.handoffLabel() === label && t.job().step === i + 1, { walked, job: t.job(), x: walker.x, y: walker.y })) return;
        const towards = walker.h;
        walker.h += Math.PI;
        t.check('a contact behind you does not claim the action button', !missions.handoffLabel());
        walker.h = towards;
        await t.frames(2);
        await t.shot(i ? 'foot-courier-recipient' : 'foot-courier-sender');
        t.press();
        await t.wait(.1);
        if (!i) t.check('taking the parcel starts the delivery', t.job().step === 2 && bags.back.visible && t.probe().money === money);
      }
      const j = t.job();
      t.check('handing it over pays once and clears the walking route', j.done.courier === 1 && j.earned === t.probe().money - money && j.earned > 0 && !t.navLine() && !bags.back.visible, j);
    } finally {
      missions.stop();
      t.eyes = saved;
    }
  },
} satisfies Scenario;
