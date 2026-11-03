// Films the launch video's shots (run through scripts/scene.mjs eval by film.sh, with
// SHOT = the shot's name, FRAMES = how many, PLAN = plan.json, before shots.js). Every
// shot is straight down, as the game is played. `record` films a shot frame by frame and
// renders the game's own sound alongside into <shot>.wav, as "the same street" does.
const d = window.__drive;
const compass = (h) => 90 - (h * 180) / Math.PI;
const mix = (a, b, u) => a + (b - a) * u;
const ease = (u) => u * u * (3 - 2 * u);
const clamp01 = (u) => Math.max(0, Math.min(1, u));
const ahead = (c, m, side = 0) => ({ x: c.x + Math.cos(c.h) * m + Math.sin(c.h) * side, y: c.y + Math.sin(c.h) * m - Math.cos(c.h) * side });
const tick = () => new Promise((r) => requestAnimationFrame(() => r()));
const settle = async (ms = 5000) => { await t.wait(0.5); await new Promise((r) => setTimeout(r, ms)); await t.wait(0.3); };
// Straight down, the picture's top the way of `heading` (compass degrees).
const above = (p, height, heading = 0) => ({ x: p.x, y: p.y, height, tilt: 0, heading, level: true });
const at = (x, y) => { const [lon, lat] = d.dev.toLonLat(x, y); return [lat, lon]; };

// On foot, the police and the jobs called off, and the day and weather of the shot.
async function begin(where, { date = '08-28', time = '12:00', weather = 'clear' } = {}) {
  // (A helicopter in the air has to land first: t.onFoot does that.)
  if (t.where().mode === 'helicopter') await t.onFoot();
  for (let i = 0; i < 3 && t.where().mode !== 'foot'; i++) { d.enterOrExit(); await t.wait(0.3); }
  t.set({ stars: 0 }); t.cam = null; t.unhurt = true; t.autoJobs(false);
  await t.go(where);
  t.season(date); t.time(time); t.weather(weather);
}

// A red car of this type here, on its way along `line` (from `route`).
const RED = '#c4161c';
async function redCar(type = 'sedan') {
  // (Not beside the red car of an earlier shot, left standing where it was.)
  for (let k = d.loose.length - 1; k >= 0; k--) if (d.loose[k].paint === RED) d.loose.splice(k, 1);
  const c = await t.drive(type);
  c.paint = RED;
  return c;
}
// Puts a car at `s` m along a line, going at `v` m/s.
function put(c, line, s, v) {
  const p = along(line, s);
  Object.assign(c, { x: p.x, y: p.y, h: p.h, vx: Math.cos(p.h) * v, vy: Math.sin(p.h) * v, w: 0, damage: 0 });
}
// Nothing else on the road within `r` m of the car, but the police.
function clear(c, r = 40) {
  const A = d.traffic.agents;
  for (let k = A.length - 1; k >= 0; k--) if (A[k].car.type !== 'police' && Math.hypot(A[k].car.x - c.x, A[k].car.y - c.y) < r) A.splice(k, 1);
}

// The way by car from one place to another through the loaded streets, as a line of
// points in the map's metres: kept to the right-hand lane (`lane` m right of the middle),
// smoothed through the corners, every half metre.
function route(from, to, lane = 1.8) {
  const r = t.route(from, to);
  if (!r) throw new Error(`No way by car from ${from} to ${to}`);
  let pts = r.line.map((p) => t.toLocal(p));
  // Every half metre along it.
  const even = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, ay] = pts[i], [bx, by] = pts[i + 1], len = Math.hypot(bx - ax, by - ay), n = Math.max(1, Math.round(len / 0.5));
    for (let k = 0; k < n; k++) even.push([mix(ax, bx, k / n), mix(ay, by, k / n)]);
  }
  even.push(pts[pts.length - 1]);
  // Smoothed (a moving average some 12 m long), then moved right by the lane.
  const W = 12;
  const smooth = even.map((_, i) => {
    let x = 0, y = 0, n = 0;
    for (let k = Math.max(0, i - W); k <= Math.min(even.length - 1, i + W); k++) { x += even[k][0]; y += even[k][1]; n++; }
    return [x / n, y / n];
  });
  const line = smooth.map(([x, y], i) => {
    const [px, py] = smooth[Math.max(0, i - 1)], [nx, ny] = smooth[Math.min(smooth.length - 1, i + 1)];
    const h = Math.atan2(ny - py, nx - px);
    return { x: x + Math.sin(h) * lane, y: y - Math.cos(h) * lane, h };
  });
  let s = 0;
  line.forEach((p, i) => { if (i) s += Math.hypot(p.x - line[i - 1].x, p.y - line[i - 1].y); p.s = s; });
  return line;
}
function along(line, s) {
  s = Math.max(0, Math.min(line[line.length - 1].s, s));
  let i = 0;
  while (i < line.length - 2 && line[i + 1].s < s) i++;
  const a = line[i], b = line[i + 1], u = b.s > a.s ? (s - a.s) / (b.s - a.s) : 0;
  return { x: mix(a.x, b.x, u), y: mix(a.y, b.y, u), h: Math.atan2(b.y - a.y, b.x - a.x) };
}
const lengthOf = (line) => line[line.length - 1].s;

// Films FRAMES frames of the shot as SHOT-0001.png …, and its sound into SHOT.wav.
// `each(k, n)` runs before every frame (set `t.cam`, put the car); `pedal(k)`: whether the
// accelerator is down (the engine's sound follows it); `ctl`: what the world is driven with.
const SR = 48000, Real = window.AudioContext;
const key = (type) => window.dispatchEvent(new KeyboardEvent(type, { code: 'KeyW' }));
async function record(each, { pedal = () => false, ctl = {}, n = FRAMES } = {}) {
  const fps = PLAN.fps, s = d.sound;
  const off = new OfflineAudioContext(2, Math.ceil(SR * (n / fps + 5)), SR);
  off.createMediaElementSource = () => off.createGain();
  // (The game updates its sound only while its context is running; this one stands still between frames.)
  Object.defineProperty(off, 'state', { get: () => 'running' });
  let started = false, time = 0, done = null;
  const resume = off.resume.bind(off);
  off.resume = () => (started ? resume() : Promise.resolve());
  window.AudioContext = function () { return off; };
  Object.assign(s, { ctx: null, engine: null, tyres: null, weather: null, ambience: null, radio: null, voices: [], sirens: [], horns: null, clips: {} });
  s.on = true; s.start(); s.setRadio(false);
  window.AudioContext = Real;
  await new Promise((r) => setTimeout(r, 3000));   // (the recordings load)
  const step = async () => { time += 1 / fps; const p = off.suspend(time); if (!done) { done = off.startRendering(); started = true; } else resume(); await p; };
  const was = t.paused;
  t.paused = true;
  // Three seconds of sound before the first frame, thrown away: the game's sound takes a moment to come up.
  await each(0, n);
  for (let k = 0; k < 3 * fps; k++) { await tick(); await step(); }
  const lead = time;
  await t.film(SHOT, n / fps, ctl, { fps, each: async (k) => { key(pedal(k) ? 'keydown' : 'keyup'); await each(k, n); await step(); } });
  t.paused = was;
  key('keyup');
  resume();
  const buf = await done;
  const skip = Math.round(lead * SR), m = Math.round(time * SR) - skip;
  const L = buf.getChannelData(0).subarray(skip), R = buf.getChannelData(1).subarray(skip);
  const wav = new DataView(new ArrayBuffer(44 + m * 4));
  const str = (o, x) => { for (let i = 0; i < x.length; i++) wav.setUint8(o + i, x.charCodeAt(i)); };
  str(0, 'RIFF'); wav.setUint32(4, 36 + m * 4, true); str(8, 'WAVEfmt '); wav.setUint32(16, 16, true); wav.setUint16(20, 1, true); wav.setUint16(22, 2, true);
  wav.setUint32(24, SR, true); wav.setUint32(28, SR * 4, true); wav.setUint16(32, 4, true); wav.setUint16(34, 16, true); str(36, 'data'); wav.setUint32(40, m * 4, true);
  let peak = 0;
  for (let i = 0; i < m; i++) { peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i])); wav.setInt16(44 + i * 4, Math.max(-1, Math.min(1, L[i])) * 32767, true); wav.setInt16(46 + i * 4, Math.max(-1, Math.min(1, R[i])) * 32767, true); }
  let bin = ''; const bytes = new Uint8Array(wav.buffer);
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  await window.__saveFile(`${SHOT}.wav`, btoa(bin));
  t.cam = null; t.unhurt = false; t.set({ stars: 0 });
  return { shot: SHOT, frames: n, peak: +peak.toFixed(3) };
}
