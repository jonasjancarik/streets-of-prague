// Repeatable handling manoeuvres on a level, empty road using Car.update.
import assert from 'node:assert/strict';
import { carModule, loadModels, network } from './offline-city.mjs';
const { Car, TYPES } = carModule;
const { WET, SNOW, STREET_SNOW } = await import('../src/shading.ts');
await loadModels();
const flat = { at: () => 0 };
const gas = { throttle: 1, steer: 0, handbrake: false };
const brake = { ...gas, throttle: -1 }, coast = { ...gas, throttle: 0 };
const deg = r => r * 180 / Math.PI;
const slip = c => Math.abs(deg(Math.atan2(Math.sin(Math.atan2(c.vy, c.vx) - c.h), Math.cos(Math.atan2(c.vy, c.vx) - c.h))));
function car(type, kmh = 0) {
  const c = new Car(type, () => .3);
  c.spec = TYPES[type]; c.mass = c.spec.mass; c.mode = 'player'; c.vx = kmh / 3.6;
  return c;
}
function run(c, seconds, controls, hz = 60) {
  for (let i = 0; i < Math.round(seconds * hz); i++) c.update(1 / hz, controls, flat, true);
}
function launch(type, realistic) {
  const c = car(type);
  let t = 0;
  while (c.speed * 3.6 < 100 && t < 30) { c.update(1 / 60, gas, flat, realistic); t += 1 / 60; }
  assert.ok(t < 30 && Math.abs(c.y) < .001 && Math.abs(c.h) < .001, type + ' straight launch');
  return t;
}
function stopping(type, realistic) {
  const c = car(type, 50);
  let dip = 0;
  for (let i = 0; i < 600 && c.forwardSpeed > .1; i++) {
    c.update(1 / 60, brake, flat, realistic);
    dip = Math.min(dip, c.suspension?.pitch ?? 0);
  }
  assert.ok(c.forwardSpeed <= .1 && (!realistic || dip < -.025), type + ' brakes and dives');
  return c.x;
}
const times = {};
for (const type of ['hatch', 'sedan', 'suv', 'van', 'pickup', 'police']) {
  const original = launch(type, false), time = launch(type, true);
  const arcadeStop = stopping(type, false), stop = stopping(type, true);
  assert.ok(time > original * 1.5 && stop > arcadeStop * 1.25, type + ' has distinct acceleration and braking');
  times[type] = time;
  console.log(type.padEnd(7), '0–100 km/h', original.toFixed(1), '→', time.toFixed(1), 's; stop from 50', arcadeStop.toFixed(1), '→', stop.toFixed(1), 'm');
}
assert.ok(times.police < times.sedan && times.sedan < times.hatch && times.hatch < times.van);
const dry = stopping('sedan', true);
WET.value = 1;
const wet = stopping('sedan', true);
SNOW.value = STREET_SNOW.value = 1;
const snow = stopping('sedan', true);
assert.ok(wet > dry * 1.15 && snow > wet, 'wet and snowy roads extend stopping distance');
console.log('Sedan stops from 50 km/h, dry/wet/snow:', [dry,wet,snow].map(n => n.toFixed(1)).join(' / '), 'm');
WET.value = SNOW.value = STREET_SNOW.value = 0;

function bend(hz, sign = 1, handbrake = false, type = 'sedan') {
  const c = car(type, 50);
  run(c, .8, { throttle: .18, steer: sign, handbrake }, hz);
  return c;
}
const left = bend(60), right = bend(60, -1), slide = bend(60, 1, true);
assert.ok(left.h > .22 && Math.abs(left.h + right.h) < 1e-8 && Math.abs(left.y + right.y) < 1e-8);
assert.ok(left.suspension.roll > .04 && right.suspension.roll < -.04 && bend(60,1,false,'suv').suspension.roll > left.suspension.roll);
assert.ok(slip(slide) > slip(left) + 12 && slide.h > left.h * 1.3, 'handbrake loosens rear tyres');
console.log('Sedan 50 km/h bend, normal / handbrake slip:', slip(left).toFixed(1), '/', slip(slide).toFixed(1), 'degrees; body roll', deg(left.suspension.roll).toFixed(1));
for (const hz of [20, 30, 120]) {
  const other = bend(hz);
  assert.ok(Math.abs(other.h-left.h) < .008 && Math.hypot(other.x-left.x,other.y-left.y) < .23, 'turn at '+hz+' Hz');
}
run(left, 2, coast);
assert.ok(Math.abs(left.suspension.roll) < .008 && Math.abs(left.w) < .015, 'springs and heading settle');
const reverse = car('hatch');
run(reverse, 3, { ...brake, steer: .5 });
assert.ok(reverse.forwardSpeed < -2 && reverse.h < -.15, 'reverse steering');
const limited = car('sedan');
run(limited, 12, { ...gas, cap: 10 });
assert.ok(limited.speed > 9 && limited.speed < 10.1, 'lane-assist speed cap');
const hill = car('sedan'), grade = { at: flat.at, height: x => x * .10 };
for (let i = 0; i < 60; i++) hill.update(1/60, coast, grade, true);
assert.ok(hill.vx < -.2, 'coasting rolls downhill');
hill.vx = 0;
for (let i = 0; i < 60; i++) hill.update(1/60, { ...coast, handbrake: true }, grade, true);
assert.equal(hill.vx, 0, 'handbrake holds on a grade');
limited.update(1/60, coast, flat);
assert.equal(limited.suspension, undefined, 'switch back to classic while moving');
for (const type of ['bike','moto','bus','truck']) {
  const c = car(type); run(c,.1,gas);
  assert.equal(c.suspension, undefined, type+' keeps its original handling');
}
// A 45 m radius bend is wide enough for a 45 km/h cruise. Use the real lane
// controller, so the input conversion is tested along with the physical rack.
const { LaneAssist, project } = await import('../src/assist.ts');
const lane = new network.Polyline(Array.from({length: 121}, (_, i) => {
  const angle = i * Math.PI / 120;
  return [45 * Math.sin(angle), 45 * (1 - Math.cos(angle))];
}));
const edge = {path: lane, hw: 'residential'}, assist = new LaneAssist({out: new Map()}, () => [edge]);
const cruising = car('sedan', 45);
let laneError = 0;
for (let i = 0; i < 300; i++) {
  const steer = assist.steer(cruising, 0, cruising.suspension);
  assert.notEqual(steer, null, 'assist keeps the lane');
  cruising.update(1/60, {throttle: .25, steer, cap: 45/3.6, handbrake: false}, flat, true);
  laneError = Math.max(laneError, project(lane, cruising.x, cruising.y).d);
}
assert.ok(laneError < 1.3, 'lane assist drifted ' + laneError + ' m');
console.log('Lane assist peak offset on a 45 m radius bend:', laneError.toFixed(2), 'm');
const impactCar = car('sedan', 60);
const wall = {at: x => x >= 12 ? 255 : 0};
let impact = 0;
for (let i = 0; i < 90; i++) {
  impact = Math.max(impact, impactCar.update(1/60, coast, wall, true));
  assert.ok(impactCar.x < 12, 'car crossed the wall');
}
assert.ok(impact > 5 && impactCar.damage > 0 && impactCar.speed < 8, 'realistic car takes the normal collision impulse and damage');
console.log('Passed steering symmetry, spring settling, 20–120 Hz, reversing, cap, hills and model handoff.');
