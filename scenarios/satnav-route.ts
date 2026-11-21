import type { Scenario } from '../src/testkit.ts';

// Directions to a spot picked on the map (src/satnav.ts): from Národní, heading east, to
// Karlovo náměstí. The way turns right into Spálená, lane assist follows it, the right
// indicator comes on before the turn, and stopping the directions clears the card.
export default {
  title: 'Directions from Národní to Karlovo náměstí, followed with lane assist',
  async run(t) {
    await t.go([50.08155, 14.41455], { heading: 90 });
    t.time('14:00');
    t.weather('clear');
    t.set({ stars: 0 });
    t.clearJobs();
    await t.drive('sedan');
    t.navTo(50.0768, 14.4193);
    // Standing, only the streets round the car are loaded: the way is partial until you
    // drive off and the view (and the tiles loaded with it) widens.
    // (Tiles stream in real time, while the world steps as fast as it can.)
    for (let i = 0; i < 40 && !t.nav().reached; i++) {
      await t.wait(0.25, { move: 1, run: true });
      await new Promise((go) => setTimeout(go, 300));
    }
    const way = t.nav();
    t.check('the way reaches the spot', way.reached, way);
    // (Measured from where the car is when the whole way first shows.)
    const me = t.where(), crow = Math.hypot(way.to!.x - me.x, way.to!.y - me.y);
    t.check('a sensible length', way.length > crow && way.length < crow * 2, `${way.length} m for ${Math.round(crow)} m as the crow flies`);
    t.check('first right into Spálená', way.turns[0]?.kind === 'right' && way.turns[0]?.onto === 'Spálená', way.turns);
    const card = document.getElementById('nav');
    t.check('the card names the turn', !!card && !card.hidden && card.innerText.includes('Spálená'), card?.innerText);
    // The full route may first load quite close to Spálená. Observe the approach
    // while the car moves, so the six-second lane-assist check cannot skip the turn.
    let near: ReturnType<typeof t.nav> | undefined, on = way;
    let earlySignal = false;
    for (let i = 0; i < 120; i++) {
      const now = t.nav(), gap = now.turns[0]?.at - now.along;
      if (gap >= 100 && now.signal) earlySignal = true;
      if (!near && gap > 0 && gap <= 35 && now.signal === 'right') near = now;
      if (i === 24) on = now;
      if (i >= 24 && (near || gap <= 0)) break;
      await t.wait(.25, { move: 1, run: true });
    }
    t.check('lane assist keeps to the way', on.along > way.along + 40 && on.length === way.length, `${way.along} → ${on.along} m along a ${on.length} m way`);
    t.check('no early indicator on the approach', !earlySignal);
    t.check('the right indicator before Spálená', !!near, near ? `${near.turns[0].at - near.along} m before` : t.nav());
    await t.shot('satnav-route');
    t.navTo();
    await t.frames(3);
    t.check('stopping clears the card', !t.nav().to && !!card?.hidden, t.nav());
  },
} satisfies Scenario;
