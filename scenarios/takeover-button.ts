import type { Scenario } from '../src/testkit.ts';

// The touch controls' "Take over the tram" button showed in a taxi (and on a ferry or the
// funicular), where it did nothing. Only a tram can be taken over. Needs the touch controls:
//   node scripts/scene.mjs run takeover-button --extra "&touch"
export default {
  title: 'The take-over button shows only on a tram, not in a taxi or on a ferry',
  async run(t) {
    const touch = document.getElementById('touch')!, steal = document.getElementById('t-steal')!;
    const shown = () => getComputedStyle(touch).display !== 'none' && getComputedStyle(steal).display !== 'none';
    if (!new URLSearchParams(location.search).has('touch')) {
      t.check('skipped: the touch controls are off (open the game with ?touch)', true);
      return;
    }
    // On a tram the button is there, and takes it over.
    t.time('12:15');
    t.weather('cloudy');
    t.season('11-01');
    await t.go('vodickova');
    if (!t.check('on a tram', await t.boardTram(), t.where().mode)) return;
    await t.frames();
    t.check('the take-over button shows on the tram', touch.dataset.mode === 'tram' && shown(), touch.dataset.mode);
    steal.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    await t.frames();
    t.check('and takes it over', t.where().mode === 'tram' && touch.dataset.mode !== 'tram', touch.dataset.mode);
    t.exit();

    // V Tůních, where the player called the taxi.
    await t.go([50.07614, 14.42718], { heading: 356 });
    t.set({ money: 10000, stars: 0, health: 100 });
    await t.wait(3);
    t.check('a taxi is on its way', t.orderTaxi().state === 'coming', t.taxi());
    let waited = 0;
    for (; waited < 120 && !t.taxi().near; waited += 2) await t.wait(2);
    if (!t.check('it pulls up', t.taxi().near, { waited, ...t.taxi() })) return;
    if (!t.check('you get in', t.boardTaxi(), t.taxi())) return;
    await t.frames();
    t.check('riding in the taxi, the touch controls are the passenger ones', touch.dataset.mode === 'tram', touch.dataset.mode);
    t.check('and there is no take-over button', !shown(), steal.textContent);
    await t.shot('takeover-button-taxi');
    t.exit();

    // The P5 ferry from Výtoň (sailing in summer), once it lies at a landing.
    t.time('10:00');
    t.season('07-15');
    await t.go([50.0674, 14.4150]);
    await t.wait(2);
    const p5 = () => t.ferries().find(f => f.ref === 'P5');
    for (let k = 0; k < 80 && (!p5()?.open || p5()?.stop == null); k++) await t.wait(5);
    if (!t.check('the P5 ferry lies at a landing', !!p5()?.open && p5()?.stop != null, JSON.stringify(p5() ?? null))) return;
    await t.go(p5()!.landings[p5()!.stop!].gate);
    if (!t.check('aboard the ferry', t.boardFerry(), t.where().mode)) return;
    await t.frames();
    t.check('no take-over button on the ferry either', touch.dataset.mode === 'tram' && !shown(), touch.dataset.mode);
    t.exit();
  },
} satisfies Scenario;
