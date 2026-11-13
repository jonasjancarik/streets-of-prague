import type { Scenario } from '../src/testkit.ts';

// Photo mode (src/photo.ts): C stops the game, hides everything but the picture and frees
// the camera; leaving it puts the clock and the camera back.
const key = (code: string) => window.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true }));

export default {
  title: 'Photo mode frees the camera, and leaving it puts the clock back',
  async run(t) {
    await t.go('staromak');
    t.time('14:00');
    t.weather('clear');
    const paused = t.paused;
    key('KeyC');
    await t.frames();
    t.check('the screen is cleared for the picture', document.body.classList.contains('photo'));
    t.check('the camera is free', !!t.cam);
    t.check('the game is paused', t.paused);
    const bar = document.getElementById('photo');
    if (!t.check('the bar is there', !!bar)) return;
    const [time, tilt] = [...bar!.querySelectorAll('input')] as HTMLInputElement[];
    time.value = String(19 * 60 + 30);
    time.dispatchEvent(new Event('input'));
    tilt.value = '40';
    tilt.dispatchEvent(new Event('input'));
    await t.frames();
    t.check('the hour follows its slider', t.probe().time === '19:30', t.probe().time);
    t.check('the camera tilts with its slider', Math.abs((t.cam?.tilt ?? 0) - 40) < 0.5, `tilt ${t.cam?.tilt}`);
    await t.shot('photo-mode');
    key('Escape');
    await t.frames();
    t.check('the screen is back', !document.body.classList.contains('photo'));
    t.check('the camera follows you again', !t.cam);
    t.check('the game goes on as it was', t.paused === paused);
    t.check('the clock is back', t.probe().time === '14:00', t.probe().time);
  },
} satisfies Scenario;
