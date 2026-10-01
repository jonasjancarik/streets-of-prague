// One day over the Old Town Square: the camera stays, the clock runs from 04:40 to 23:40
// over 720 frames (the same numbers as in src/day.rs), people at four times their pace.
const FRAMES = 720, FROM = 4 * 60 + 40, TO = 23 * 60 + 40;
const clock = (i) => { const m = Math.round(FROM + (TO - FROM) * i / (FRAMES - 1)); return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };
t.weather('clear'); t.time(clock(0)); t.set({ stars: 0 });
await t.go('staromak');
const [x, y] = t.toLocal('staromak');
await t.camera({ at: 'staromak', height: 72, tilt: 52, heading: 20 });
await t.wait(0.5); await new Promise((r) => setTimeout(r, 6000));
await t.film('day', FRAMES / 30, {}, { each: async (i, n) => {
  t.time(clock(i));
  t.cam = { x, y, height: 72 - 6 * i / n, tilt: 52, heading: 20 + 5 * i / n };
  await t.wait(0.1);
} });
t.cam = null;
return clock(FRAMES - 1);
