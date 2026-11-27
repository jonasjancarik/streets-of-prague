// Physical handling (src/physicalHandling.ts) on test ground with Car.update: it stands
// on its springs, launches and stops, understeers under power, slides with the
// handbrake, is the same at any frame rate, trips over a kerb when sliding sideways fast,
// a van swerving hard goes over and a saloon doesn't, it jumps and lands, and a car left
// on its side becomes an ordinary overturned car. `-v` prints each manoeuvre's numbers.
import assert from 'node:assert/strict';
import { carModule, loadModels } from './offline-city.mjs';
const { Car, TYPES } = carModule;
await loadModels();
const verbose = process.argv.includes('-v');
const say = (...a) => { if (verbose) console.log(...a); };
const deg = r => r * 180 / Math.PI;
const flat = { at: () => 0, height: () => 0 };
const coast = { throttle: 0, steer: 0, handbrake: false };
function car(type, kmh = 0) {
  const c = new Car(type, () => .3);
  c.spec = TYPES[type]; c.mass = c.spec.mass; c.mode = 'player'; c.vx = kmh / 3.6;
  return c;
}
// Runs it, noting the most it leaned and how many wheels it had off the road at once.
function run(c, seconds, controls, ground = flat, hz = 60) {
  let hit = 0, lean = 0, lifted = 0, air = 0;
  for (let i = 0; i < Math.round(seconds * hz); i++) {
    hit = Math.max(hit, c.update(1 / hz, typeof controls === 'function' ? controls(i / hz) : controls, ground, 'physical'));
    assert.ok([c.x, c.y, c.h, c.vx, c.vy, c.w].every(Number.isFinite), 'stays finite');
    const ph = c.physics;
    if (!ph) continue;
    lean = Math.max(lean, Math.abs(deg(ph.rollAngle)));
    const off = ph.wheels.filter(w => !w.contact || w.load <= 0).length;
    lifted = Math.max(lifted, off);
    if (off === 4) air += 1 / hz;
  }
  return { hit, lean, lifted, air };
}
const slip = c => Math.abs(deg(Math.atan2(Math.sin(Math.atan2(c.vy, c.vx) - c.h), Math.cos(Math.atan2(c.vy, c.vx) - c.h))));
const face = c => c.roll?.face ?? (c.physics?.tipped ? 'tipping' : 'wheels');

{
  const c = car('sedan');
  run(c, 3, coast);
  assert.ok(Math.hypot(c.x, c.y) < .01 && Math.abs(c.physics.origin[2]) < .01 && c.physics.planted, 'stands still on its springs');
}
for (const type of ['hatch', 'sedan', 'suv', 'van', 'pickup', 'police']) {
  let c = car(type), t = 0, squat = 0;
  while (c.speed * 3.6 < 100 && t < 40) { c.update(1 / 60, { ...coast, throttle: 1 }, flat, 'physical'); t += 1 / 60; squat = Math.max(squat, Math.asin(c.physics.axes[2])); }
  c = car(type, 50);
  let dive = 0;
  for (let i = 0; i < 900 && c.forwardSpeed > .1; i++) { c.update(1 / 60, { ...coast, throttle: -1 }, flat, 'physical'); dive = Math.min(dive, Math.asin(c.physics.axes[2])); }
  say(type.padEnd(7), '0–100 km/h', t.toFixed(1), 's; stop from 50', c.x.toFixed(1), 'm; squat', deg(squat).toFixed(1), '° dive', deg(dive).toFixed(1), '°');
  assert.ok(t > 6 && t < 25 && c.x > 8 && c.x < 16 && squat > .003 && dive < -.015, type + ' launches squatting and stops diving');
}
// A front-drive saloon pushes on under power at the limit; the handbrake swings the back out.
{
  const power = car('sedan', 90), lift = car('police', 50), brake = car('sedan', 50);
  let pushed = 0;
  for (let i = 0; i < 150; i++) { power.update(1 / 60, { throttle: 1, steer: .5, handbrake: false }, flat, 'physical'); pushed = Math.max(pushed, slip(power)); }
  run(lift, .8, { throttle: .2, steer: 1, handbrake: false });
  run(brake, .8, { throttle: 0, steer: 1, handbrake: true });
  say('slip: power at 90', pushed.toFixed(1), '°; bend at 50', slip(lift).toFixed(1), '°; handbrake', slip(brake).toFixed(1), '°');
  assert.ok(pushed < 6, 'a front-drive car understeers under power');
  assert.ok(slip(brake) > slip(lift) + 15 && brake.skidBack > .5, 'the handbrake slides the back');
}
// Body roll leans out of a bend, more in a van; the same at any frame rate.
{
  const left = car('sedan', 50), right = car('sedan', 50), van = car('van', 50);
  run(left, .8, { throttle: .18, steer: 1, handbrake: false });
  run(right, .8, { throttle: .18, steer: -1, handbrake: false });
  run(van, .8, { throttle: .18, steer: 1, handbrake: false });
  say('roll in a 50 km/h bend: sedan', deg(left.physics.rollAngle).toFixed(1), 'van', deg(van.physics.rollAngle).toFixed(1));
  assert.ok(left.physics.rollAngle > .04 && Math.abs(left.physics.rollAngle + right.physics.rollAngle) < 1e-6 && Math.abs(left.h + right.h) < 1e-6, 'leans out, the same both ways');
  assert.ok(van.physics.rollAngle > left.physics.rollAngle, 'a van leans more');
  for (const hz of [20, 30, 120, 144]) {
    const other = car('sedan', 50);
    run(other, .8, { throttle: .18, steer: 1, handbrake: false }, flat, hz);
    assert.ok(Math.abs(other.h - left.h) < .01 && Math.hypot(other.x - left.x, other.y - left.y) < .1, 'the same at ' + hz + ' Hz');
  }
  run(left, 3, coast);
  assert.ok(Math.abs(left.physics.rollAngle) < .005, 'and settles');
}
// Holds on a hill with the handbrake; rolls down it off the brakes; reverses.
{
  const hill = { at: () => 0, height: x => x * .1 };
  const held = car('sedan'), rolling = car('sedan'), back = car('hatch');
  run(held, 2, { ...coast, handbrake: true }, hill);
  run(rolling, 1, coast, hill);
  run(back, 3, { throttle: -1, steer: .5, handbrake: false });
  assert.ok(Math.abs(held.x) < .05 && rolling.vx < -.2, 'holds on a hill, rolls down it');
  assert.ok(back.forwardSpeed < -2 && back.h < -.15, 'reverses');
}
// Sideways into a 14 cm kerb: stopped slowly, tripped over fast (a van sooner).
{
  const kerb = { at: () => 0, height: (x, y) => y < -2 ? .14 : 0 };
  const slide = (type, kmh) => { const c = car(type); c.vy = -kmh / 3.6; const r = run(c, 6, coast, kerb); return { face: face(c), ...r, c }; };
  const slow = slide('sedan', 15), fast = slide('sedan', 40), van = slide('van', 25), faster = slide('sedan', 60);
  say('kerb: sedan 15 km/h', slow.face, slow.lean.toFixed(0), '°; 40 km/h', fast.face, '; 60 km/h', faster.face, faster.lean.toFixed(0), '°; van 25 km/h', van.face);
  assert.ok(slow.face === 'wheels' && slow.lean < 30, 'a slow slide into a kerb stays on its wheels');
  assert.ok(fast.face !== 'wheels' && van.face !== 'wheels' && faster.lean > 150, 'a fast one trips it over');
  assert.ok(!fast.c.physics && fast.c.overturned && fast.c.damage > 3, 'lying still, it is an overturned car (rollover.ts)');
  fast.c.update(1 / 60, { throttle: 1, steer: 0, handbrake: false }, kerb, 'physical');
  assert.ok(!fast.c.physics && fast.c.speed < .01, 'and nobody drives it');
}
// Thrown from one lock to the other: a van goes over; a saloon, an SUV and a pickup don't.
{
  const hook = t => ({ throttle: t < 1.5 ? .3 : 0, steer: t < .5 ? 1 : t < 1.5 ? -1 : 0, handbrake: false });
  for (const [type, kmh, over] of [['sedan', 90, false], ['suv', 90, false], ['pickup', 90, false], ['van', 50, false], ['van', 75, true]]) {
    const c = car(type, kmh), r = run(c, 6, hook);
    say('swerve', type, kmh, 'km/h:', face(c), r.lean.toFixed(0), '°, wheels off', r.lifted);
    assert.equal(face(c) !== 'wheels', over, `${type} swerving at ${kmh} km/h ${over ? 'goes' : "doesn't go"} over`);
  }
}
// Off a 1.2 m ramp: airborne, lands on its wheels.
{
  const ramp = { at: () => 0, height: x => x > 10 && x < 18 ? (x - 10) * .15 : 0 };
  const c = car('sedan', 70), r = run(c, 4, { ...coast, throttle: .5 }, ramp);
  say('ramp at 70 km/h:', r.air.toFixed(2), 's in the air, landing', r.hit.toFixed(1));
  assert.ok(r.air > .4 && face(c) === 'wheels' && c.x > 40, 'jumps and lands on its wheels');
}
// A wall head on: a van's nose dives into it. Back to Classic: the speed carries on.
{
  const wall = { at: x => x > 12 ? 1 : 0, height: () => 0 };
  const van = car('van', 60);
  let dive = 0;
  for (let i = 0; i < 120; i++) { van.update(1 / 60, coast, wall, 'physical'); dive = Math.max(dive, -Math.asin(van.physics?.axes[2] ?? 0)); }
  assert.ok(van.x < 12 - van.spec.L / 2 + .2 && deg(dive) > 8, 'a wall stops it and its nose dives');
  const c = car('sedan', 50);
  run(c, 1, { ...coast, throttle: .3 });
  const v = c.speed;
  c.update(1 / 60, { ...coast, throttle: .3 }, flat, 'classic');
  assert.ok(!c.physics && Math.abs(c.speed - v) < .1, 'switching back to Classic keeps the speed');
}
console.log('Passed physical handling: springs, launches, stops, understeer, handbrake, roll, 20–144 Hz, hills, kerb trips, swerves, a jump, a wall and the handoffs.');
