// Shared by the atmospheric trailer's shots (run through scripts/scene.mjs eval, with TL = timeline.json).
const settle = async (s = 4000) => { await t.wait(0.5); await new Promise((r) => setTimeout(r, s)); await t.wait(0.3); };
const compass = (h) => 90 - (h * 180) / Math.PI;
// (The trailer's car is always the same red one.)
// Into a car at the first of the places with room for one, facing `heading` (compass degrees).
const driveAt = async (places, type, heading) => {
  for (const p of places) { try { await t.go(p, { heading }); await t.drive(type); __drive.car.paint = '#c4161c'; t.push(0, heading); return; } catch { /* the next place */ } }
  throw new Error('No room for a car at any of the places');
};
// The camera for a frame of a driving shot, by name. `u`: 0..1 through the shot.
const ahead = (c, d) => ({ x: c.x + Math.cos(c.h) * d, y: c.y + Math.sin(c.h) * d });
const CAMS = {
  // Behind the car, looking down the street ahead of it.
  behind: (c, u) => ({ ...ahead(c, 18), height: 24 - 4 * u, tilt: 62, heading: compass(c.h) }),
  // Ahead of it, looking back as it comes.
  front: (c, u) => ({ ...ahead(c, 4), height: 22, tilt: 60, heading: compass(c.h) + 180 + 10 * u }),
  // Alongside.
  side: (c, u) => ({ ...ahead(c, 4), height: 24, tilt: 55, heading: compass(c.h) + 90 - 16 * u }),
  // Straight down, close, the car heading up the picture.
  top: (c, u) => ({ ...ahead(c, 6 + 6 * u), height: 34 + 10 * u, tilt: 0, heading: compass(c.h) }),
  // High behind: the street ahead.
  high: (c, u) => ({ ...ahead(c, 22), height: 34 + 6 * u, tilt: 55, heading: compass(c.h) }),
};
// Films a stretch of the drive: the car held at the timeline's speed for those frames
// (with a run-up at the first frame's speed), kept in its lane, the camera following.
const burst = async (seg, cam, lead = 1.2) => {
  const speed = (i) => TL.speed[Math.min(TL.engineFrames, seg.engineStart + i)];
  const DRIVE = { move: 1, run: true };
  const hold = (v) => { const c = __drive.car; const k = v / Math.max(0.1, Math.hypot(c.vx, c.vy)); if (Math.hypot(c.vx, c.vy) > 0.5) { c.vx *= k; c.vy *= k; } else { c.vx = Math.cos(c.h) * v; c.vy = Math.sin(c.h) * v; } };
  t.unhurt = true;
  for (let k = 0; k < lead * 30; k++) { hold(speed(0)); await t.wait(1 / 30, DRIVE); }
  await t.film(seg.shot, seg.frames / TL.fps, DRIVE, { each: (i, n) => { hold(speed(i)); t.cam = CAMS[cam](__drive.car, i / n); } });
  t.cam = null; t.unhurt = false;
  return Math.round(Math.hypot(__drive.car.vx, __drive.car.vy) * 3.6);
};
const seg = (shot) => TL.segments.find((s) => s.shot === shot);

// A still place: the camera drifts a little over it (`d`: what changes by the end).
const quiet = async (s, at, cam, d = {}) => {
  await t.go(at); t.set({ stars: 0 });
  const [x, y] = t.toLocal(at);
  await t.camera({ at, ...cam });
  await settle(5000);
  await t.film(s.shot, s.frames / TL.fps, {}, { each: (i, n) => {
    const u = i / n;
    t.cam = { x: x + (d.east ?? 0) * u, y: y + (d.north ?? 0) * u, height: cam.height + (d.height ?? 0) * u, tilt: cam.tilt + (d.tilt ?? 0) * u, heading: cam.heading + (d.heading ?? 0) * u };
  } });
  t.cam = null;
};
