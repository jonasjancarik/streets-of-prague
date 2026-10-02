// Films one take of "the same street" (run through scripts/scene.mjs eval, with PLAN =
// plan.json, PATH = path.json, TAKE = the take's name, and optionally FROM/TO frames).
// The car is put on the path at every frame, so every take is the same drive; the
// camera is worked out from the car, so every take is the same shot. The game's own
// sound is rendered alongside, frame by frame, into <take>.wav.
const take = PLAN.takes.find((k) => k.name === TAKE);
const compass = (h) => 90 - (h * 180) / Math.PI;
const mix = (a, b, u) => a + (b - a) * u;
const ease = (u) => u * u * (3 - 2 * u);
const ahead = (c, d, side = 0) => ({ x: c.x + Math.cos(c.h) * d + Math.sin(c.h) * side, y: c.y + Math.sin(c.h) * d - Math.cos(c.h) * side });
// u: 0..1 through the camera's stretch of the route.
const CAMS = {
  // High over the river's edge, the whole embankment ahead, coming down towards the car.
  wide: (c, u) => ({ ...ahead(c, mix(55, 26, ease(u))), height: mix(95, 44, ease(u)), tilt: mix(44, 56, ease(u)), heading: compass(c.h) - mix(14, 4, u) }),
  // Behind the car, the street running away ahead.
  behind: (c, u) => ({ ...ahead(c, 20), height: mix(26, 21, u), tilt: 63, heading: compass(c.h) + mix(-5, 5, u) }),
  // From over the river: the car against the house fronts.
  side: (c, u) => ({ ...ahead(c, mix(-2, 8, u)), height: 24, tilt: 57, heading: compass(c.h) + 90 }),
  // Straight down, close, the car crossing the picture from left to right.
  top: (c, u) => ({ ...ahead(c, mix(2, 10, u)), height: mix(30, 40, u), tilt: 0, heading: compass(c.h) - 90 }),
  // Ahead of it, looking back as it comes, swinging round.
  front: (c, u) => ({ ...ahead(c, 6), height: 23, tilt: 60, heading: compass(c.h) + mix(205, 165, u) }),
  // High behind: the city ahead.
  high: (c, u) => ({ ...ahead(c, 40), height: mix(52, 60, u), tilt: 56, heading: compass(c.h) }),
  // Low and close behind for the last of it.
  chase: (c, u) => ({ ...ahead(c, 15), height: mix(19, 16, u), tilt: 66, heading: compass(c.h) + mix(6, -3, u) }),

  // ---- The `top` version: straight down throughout (a degree of tilt, so the heading turns the picture).
  // From high over the river, north up, coming down on the car as it pulls away.
  drop: (c, u) => ({ ...ahead(c, 6), height: mix(170, 72, ease(u)), tilt: 1, heading: 0 }),
  // The game's own view, turning a little.
  follow: (c, u) => ({ ...ahead(c, 10), height: 70, tilt: 1, heading: mix(0, 10, u) }),
  // Close, the car crossing the picture from left to right.
  cross: (c, u) => ({ ...ahead(c, mix(3, 11, u)), height: mix(32, 37, u), tilt: 1, heading: compass(c.h) - 90 }),
  // Turning round the car.
  spin: (c, u) => ({ ...ahead(c, 5), height: 46, tilt: 1, heading: compass(c.h) + mix(-45, 45, ease(u)) }),
  // The car low in the picture, the street it is heading into above it.
  lead: (c, u) => ({ ...ahead(c, 24), height: mix(56, 62, u), tilt: 1, heading: compass(c.h) }),
  // Half river, half street.
  river: (c, u) => ({ ...ahead(c, 14, -30), height: mix(98, 88, u), tilt: 1, heading: compass(c.h) }),
  // Close and closer for the last of it.
  tight: (c, u) => ({ ...ahead(c, 9), height: mix(28, 23, u), tilt: 1, heading: compass(c.h) + mix(5, -5, u) }),
};
// Which version is being filmed, and what its files are called.
const version = typeof VARIANT === 'string' ? VARIANT : 'street';
const NAME = `${version}-${TAKE}`;
// PICTURE_ONLY: without the sound (it is the same drive in both versions). SOUND_ONLY: only the sound.
const silent = typeof PICTURE_ONLY !== 'undefined' && PICTURE_ONLY;
const BUSES = ['engine', 'tyres', 'horns', 'trams', 'city', 'weather', 'bangs'];
const camAt = (i) => {
  const s = i / PLAN.fps, list = PLAN.cameras[version];
  let k = 0;
  while (k < list.length - 1 && list[k + 1][0] <= s) k++;
  const end = k < list.length - 1 ? list[k + 1][0] : PLAN.routeFrames / PLAN.fps;
  return [list[k][1], (s - list[k][0]) / (end - list[k][0])];
};
// The stretches of the route to film (RANGES, from needs.json; all of it without). A take
// that only stands still is its sound: so many seconds at the route's first frame.
// The rise is the start of the pull back: the car standing where the route ends, the camera
// going straight up from it (HEIGHTS: its height at each frame, from atmo/timeline.json).
const END = PLAN.routeFrames - 1;
const ranges = take.still ? [[0, take.still * PLAN.fps]] : take.rise ? [[0, HEIGHTS.filmed]] : typeof RANGES !== 'undefined' && RANGES ? RANGES : [[0, PLAN.routeFrames]];
// SOUND_ONLY: the takes' sound again without filming them.

// On foot, whatever the last take left you in.
for (let i = 0; i < 3 && t.where().mode !== 'foot'; i++) { __drive.enterOrExit(); await t.wait(0.3); }
t.time(take.time); t.weather(take.weather); t.set({ stars: 0 }); t.unhurt = true;
// Into a car wherever there is room for one; it is put on the path at once (see put).
for (const place of ['ujezd', 'karlak', 'vodickova']) { try { await t.go(place); await t.drive('sedan'); break; } catch { /* the next place */ } }
if (!__drive.car) throw new Error('No room for a car at any of the places');
const c = __drive.car;
c.paint = '#c4161c';
// (Unharmed whatever it brushes on the way: a led car would soon be a burning one.)
const put = (i) => { const p = PATH[Math.min(PATH.length - 1, i)], v = take.rise ? 0 : PLAN.speed[Math.min(PLAN.speed.length - 1, i)]; c.x = p[0]; c.y = p[1]; c.h = p[2]; c.vx = Math.cos(p[2]) * v; c.vy = Math.sin(p[2]) * v; c.w = 0; c.damage = 0; };
// Nothing else on the road within reach of the car, and no older red cars of earlier takes.
const clear = () => {
  const A = __drive.traffic.agents;
  for (let k = A.length - 1; k >= 0; k--) if (Math.hypot(A[k].car.x - c.x, A[k].car.y - c.y) < 60) A.splice(k, 1);
  const L = __drive.loose;
  for (let k = L.length - 1; k >= 0; k--) if (L[k] !== c && L[k].paint === '#c4161c') L.splice(k, 1);
};
const SR = 48000, Real = window.AudioContext, s = __drive.sound, peaks = [];
const key = (type) => window.dispatchEvent(new KeyboardEvent(type, { code: 'KeyW' }));

for (const [first, last] of ranges) {
  const frameOf = (k) => (take.still ? 0 : take.rise ? END : first + k);
  const camera = (k) => {
    if (take.rise) return { x: c.x, y: c.y, height: HEIGHTS.height[k], tilt: 0, heading: 0 };
    const [name, u] = camAt(frameOf(k));
    return { ...CAMS[name](c, u) };
  };
  put(frameOf(0)); clear();
  t.cam = take.rise ? { x: c.x, y: c.y, height: 600, tilt: 0, heading: 0 } : camera(0);
  await t.wait(0.5); await new Promise((r) => setTimeout(r, take.rise ? 9000 : 5000));
  // The police take: wanted, and given time for them to come.
  if (take.stars) { t.set({ stars: take.stars }); for (let k = 0; k < 14; k++) { put(frameOf(0)); await t.wait(1); } }

  // The game's sound, into a buffer instead of the loudspeakers, a frame's worth at a time:
  // the whole mix in the first two channels, then each of its buses (engine, tyres, …) in two more.
  const off = new OfflineAudioContext(2 + 2 * BUSES.length, Math.ceil(SR * ((last - first) / PLAN.fps + 5)), SR);
  off.createMediaElementSource = () => off.createGain();
  // (The game updates its sound only while its context is running; this one stands still between frames.)
  Object.defineProperty(off, 'state', { get: () => 'running' });
  // (The game asks its context to resume now and then: nothing to do before the rendering has started.)
  let started = false, at = 0, done = null;
  const resume = off.resume.bind(off);
  off.resume = () => (started ? resume() : Promise.resolve());
  if (!silent) {
    window.AudioContext = function () { return off; };
    Object.assign(s, { ctx: null, engine: null, tyres: null, weather: null, ambience: null, radio: null, voices: [], sirens: [], horns: null, clips: {} });
    s.on = true; s.start(); s.setRadio(false);
    window.AudioContext = Real;
    Object.assign(off.destination, { channelCount: 2 + 2 * BUSES.length, channelCountMode: 'explicit', channelInterpretation: 'discrete' });
    const merger = off.createChannelMerger(2 + 2 * BUSES.length);
    BUSES.forEach((b, k) => {
      const split = off.createChannelSplitter(2);
      s.buses[b].connect(split);
      split.connect(merger, 0, 2 + 2 * k);
      split.connect(merger, 1, 3 + 2 * k);
    });
    merger.connect(off.destination);
    await new Promise((r) => setTimeout(r, 3000));   // (the recordings load)
  }
  const step = async () => { if (silent) return; at += 1 / PLAN.fps; const p = off.suspend(at); if (!done) { done = off.startRendering(); started = true; } else resume(); await p; };
  // The pedal is down whenever the car moves (the engine's sound follows the pedal).
  const moving = (i) => !take.rise && PLAN.speed[i] > 0;
  key(moving(frameOf(0)) ? 'keydown' : 'keyup');
  const tick = () => new Promise((r) => requestAnimationFrame(() => r()));
  // Three seconds of the sound before the first frame, thrown away: the game's sound takes a moment to come up.
  const PRE = 3 * PLAN.fps;
  const was = t.paused;
  t.paused = true;
  for (let k = 0; k < (silent ? 0 : PRE); k++) { put(frameOf(0)); await tick(); await step(); }
  const lead = at;
  const each = async (k) => {
    const i = frameOf(k);
    key(moving(i) ? 'keydown' : 'keyup');
    put(i); clear();
    t.cam = camera(k);
    await step();
  };
  if (typeof SOUND_ONLY !== 'undefined' && SOUND_ONLY) {
    for (let k = 0; k < last - first; k++) { await each(k); __drive.simulate(1 / 60, {}); __drive.simulate(1 / 60, {}); await tick(); }
  } else await t.film(`${NAME}_${first}`, (last - first) / PLAN.fps, {}, { each });
  t.paused = was;
  key('keyup');
  t.set({ stars: 0 });
  if (silent) continue;
  resume();
  const buf = await done;
  const skip = Math.round(lead * SR), n = Math.round(at * SR) - skip;
  // A stereo WAV of two of the buffer's channels.
  const save = async (name, ch) => {
    const L = buf.getChannelData(ch).subarray(skip), R = buf.getChannelData(ch + 1).subarray(skip);
    const wav = new DataView(new ArrayBuffer(44 + n * 4));
    const str = (o, x) => { for (let i = 0; i < x.length; i++) wav.setUint8(o + i, x.charCodeAt(i)); };
    str(0, 'RIFF'); wav.setUint32(4, 36 + n * 4, true); str(8, 'WAVEfmt '); wav.setUint32(16, 16, true); wav.setUint16(20, 1, true); wav.setUint16(22, 2, true);
    wav.setUint32(24, SR, true); wav.setUint32(28, SR * 4, true); wav.setUint16(32, 4, true); wav.setUint16(34, 16, true); str(36, 'data'); wav.setUint32(40, n * 4, true);
    let peak = 0;
    for (let i = 0; i < n; i++) { peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i])); wav.setInt16(44 + i * 4, Math.max(-1, Math.min(1, L[i])) * 32767, true); wav.setInt16(46 + i * 4, Math.max(-1, Math.min(1, R[i])) * 32767, true); }
    let bin = ''; const bytes = new Uint8Array(wav.buffer);
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    await window.__saveFile(name, btoa(bin));
    return peak;
  };
  peaks.push(+(await save(`${TAKE}_${first}.wav`, 0)).toFixed(3));
  for (let k = 0; k < BUSES.length; k++) await save(`${TAKE}_${first}.${BUSES[k]}.wav`, 2 + 2 * k);
}
t.cam = null; t.unhurt = false;
return { take: NAME, ranges, peaks, where: t.where().street };
