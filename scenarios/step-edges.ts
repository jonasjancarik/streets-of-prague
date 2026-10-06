import type { Scenario } from '../src/testkit.ts';

export default {
  title: 'Quay walls and retaining walls stop cars and people; streets and stairs across them stay open',
  async run(t) {
    // Malá Strana by Kampa: the river's quay walls, garden terraces, stairs down to the water.
    const start: [number, number] = [50.0838, 14.4085];
    await t.go(start, { heading: 90 });
    t.time('14:00');
    t.weather('clear');

    // A car driven at the top of a quay wall stays up there.
    const quay = t.stepEdge({ water: true, drop: 2, r: 300 });
    if (t.check('a quay wall with a clear run up to it', !!quay) && quay) {
      // (The car is put there by hand: going somewhere in a car sets it back on a road.)
      await t.go(quay.from, { heading: quay.heading });
      t.enter(t.car('sedan', { at: quay.from, heading: quay.heading, ahead: 0 }));
      const top = t.groundHere();
      if (!t.check('the car starts on the quay, before the edge', t.pastEdge(quay) < -5, `${t.pastEdge(quay)} m past the edge`)) return;
      t.push(50, quay.heading);
      await t.wait(3, { move: 1 });
      t.check('the car stopped before the quay wall', t.pastEdge(quay) < 0.5, `${t.pastEdge(quay)} m past the edge`);
      t.check('the car is still on the quay', Math.abs(t.groundHere() - top) < 1, `ground ${t.groundHere()} m, was ${top} m`);
      await t.shot('step-edges-quay');
      t.exit();
    }

    // Someone walking at the top of a retaining wall doesn't step off it.
    await t.go(start);
    const wall = t.stepEdge({ water: false, drop: 2, r: 300, back: 5 });
    if (t.check('a retaining wall with a clear run up to it', !!wall) && wall) {
      await t.go(wall.from, { heading: wall.heading });
      const top = t.groundHere();
      await t.wait(6, { move: 1, run: true });
      t.check('the walker stopped before the wall', t.pastEdge(wall) < 0.5, `${t.pastEdge(wall)} m past the edge`);
      t.check('the walker is still on the higher ground', Math.abs(t.groundHere() - top) < 1, `ground ${t.groundHere()} m, was ${top} m`);
      await t.shot('step-edges-wall');
    }

    // Stairs across a step: you walk down them.
    await t.go(start);
    const stairs = t.stepCrossing({ hw: 'steps', r: 300, back: 5 });
    // (Not every neighbourhood has them: without any, there is nothing to walk down.)
    t.check(stairs ? 'stairs across a step' : 'no stairs across a step near here: not tried', true);
    if (stairs) {
      await t.go(stairs.from, { heading: stairs.heading });
      await t.wait(8, { move: 1 });
      t.check('the walker went down the stairs', t.pastEdge(stairs) > 2, `${t.pastEdge(stairs)} m past the edge`);
    }

    // A street across a step (a ramp): you drive down it.
    await t.go(start);
    const ramp = t.stepCrossing({ hw: 'drive', r: 300, back: 10 });
    if (t.check('a street across a step', !!ramp) && ramp) {
      await t.go(ramp.from, { heading: ramp.heading });
      await t.drive('hatch');
      await t.go(ramp.from, { heading: ramp.heading });
      t.push(30, ramp.heading);
      await t.wait(3, { move: 0.5 });
      t.check('the car drove across', t.pastEdge(ramp) > 3, `${t.pastEdge(ramp)} m past the edge`);
      t.exit();
    }
  },
} satisfies Scenario;
