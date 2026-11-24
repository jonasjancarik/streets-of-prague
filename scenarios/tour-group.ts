import type { Scenario } from '../src/testkit.ts';

export default {
  title: 'A tour group gathers round its guide at the Orloj and follows it to the Týn church',
  async run(t) {
    await t.go('staromak');
    t.time('11:00');
    t.weather('clear');
    for (let i = 0; i < 10; i++) await t.frames();
    t.endTours();
    const ended = t.toursEnded();
    // (Why groups ended since, when this one has.)
    const why = () => Object.entries(t.toursEnded()).filter(([k, n]) => n > (ended[k] ?? 0)).map(([k, n]) => `${k} ×${n - (ended[k] ?? 0)}`).join(', ');
    const id = t.tour('Orloj', 'Týn');
    if (!t.check('a group starts at the Orloj', id !== null)) return;
    const group = () => t.tours().find((g) => g.id === id);
    let g = group();
    const size = g?.size ?? 0;
    t.check('it stands round its guide', !!g && g.phase === 'talk' && g.spread < 5.5, `${size} people, the furthest ${g?.spread} m off`);
    await t.camera({ at: g!.at, height: 24, tilt: 0 });
    for (let i = 0; i < 4; i++) await t.frames();
    await t.shot('tour-gathered');
    await t.camera(null);

    // The guide talks for a while, then sets off; the group follows.
    for (let k = 0; k < 40 && g?.phase === 'talk'; k++) {
      await t.wait(2);
      g = group();
    }
    if (!t.check('the group sets off for the Týn church', g?.phase === 'walk' && g.next === 'Týn', g ? `${g.phase} to ${g.next}` : `gone, ended since: ${why()}`)) return;
    let behind = 0, spread = 0, steps = 0;
    for (let k = 0; k < 150 && g?.phase === 'walk'; k++) {
      await t.wait(2);
      g = group();
      if (g?.phase !== 'walk') break;
      behind = Math.max(behind, g.behind);
      spread = Math.max(spread, g.spread);
      if (++steps === 20) {
        await t.camera({ at: g.at, height: 24, tilt: 0 });
        for (let i = 0; i < 4; i++) await t.frames();
        await t.shot('tour-walking');
        await t.camera(null);
      }
    }
    t.check('they keep up with the guide', behind < 6 && spread < 12, `at most ${behind} m behind their place, ${spread} m from the guide`);
    t.check('they get there together', g?.phase === 'talk' && g.sight === 'Týn' && g.size >= size - 2,
      g ? `${g.phase} at ${g.sight}, ${g.size} of ${size}` : `gone, ended since: ${why()}`);
  },
} satisfies Scenario;
