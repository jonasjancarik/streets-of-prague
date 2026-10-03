// No network or speakers: exercise stream lifetime against instrumented media elements.
import assert from 'node:assert/strict';

const saved = new Map();
globalThis.localStorage = { getItem: (key) => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) };
const media = [];
globalThis.Audio = class {
  paused = true;
  src = '';
  loads = 0;
  constructor() { media.push(this); }
  addEventListener() {}
  play() { this.paused = false; return Promise.resolve(); }
  pause() { this.paused = true; }
  removeAttribute(name) { if (name === 'src') this.src = ''; }
  load() { this.loads++; }
};
const param = () => ({ value: 0, cancelScheduledValues() {}, setTargetAtTime(v) { this.value = v; }, setValueAtTime(v) { this.value = v; }, linearRampToValueAtTime(v) { this.value = v; } });
const node = () => ({ gain: param(), frequency: param(), Q: param(), connect(other) { return other; }, disconnect() {}, start() {}, stop() {} });
const ctx = { currentTime: 0, createGain: node, createBiquadFilter: node, createMediaElementSource: node, createBufferSource: node };
const { Radio, STATIONS } = await import('../src/radio.ts');
const { stationAllowed, setStationAllowed } = await import('../src/radio-preferences.ts');
const radio = new Radio(ctx, {}, node());
const active = () => media.filter((el) => el.src);
const firstCar = {};
radio.pick(0);
radio.update(true, firstCar);
assert.equal(active().length, 1, 'one audible stream');
radio.update(false);
radio.warm(true, 1);
assert.equal(active().length, 2, 'audible car becomes a linger stream alongside next-car buffer');
const station = radio.station;
const before = [...active()];
radio.setStreaming(false);
assert.equal(active().length, 0, 'zero volume closes audible, warm and linger streams');
assert.ok(before.every((el) => el.paused && el.loads === 1), 'pause, clear src and load abort downloads');
radio.warm(true, 1, true);
radio.pick(2);
radio.update(true, firstCar);
assert.equal(active().length, 0, 'warm, tuning and car entry cannot reopen while muted');
assert.equal(radio.station, STATIONS[0], 'car keeps its remembered station');
radio.setStreaming(true);
assert.equal(active().length, 1, 'restoring volume resumes selected car');
assert.equal(radio.station, STATIONS[0]);
setStationAllowed('wave', false);
assert.notEqual(radio.station?.id, 'wave', 'blocking current station retunes immediately');
assert.ok(!active().some((el) => el.src === STATIONS[0].url), 'blocked stream closes');
radio.pick(0);
assert.notEqual(radio.station?.id, 'wave', 'manual pick cannot bypass exclusions');
radio.pick(-1);
assert.equal(active().length, 0, 'radio off closes lingering streams too');
radio.next();
assert.equal(radio.station, STATIONS[1], 'next skips blocked first station');
radio.prev();
assert.equal(radio.station, null, 'previous reaches off');
for (const s of STATIONS) setStationAllowed(s.id, false);
radio.set(true);
radio.warm(true, 1);
assert.equal(radio.station, null, 'all stations blocked is safe');
assert.equal(active().length, 0, 'all blocked downloads nothing');
setStationAllowed('kiss', true);
radio.set(true);
radio.update(true, { radio: 0 });
assert.equal(radio.station?.id, 'kiss', 'returning to a car skips its remembered blocked station');
assert.equal(firstCar.radio === 0, false, 'current car station was replaced when blocked');
assert.equal(stationAllowed('wave'), false);
assert.ok(JSON.parse(saved.get('radio-preferences')).blocked.includes('wave'), 'exclusions persist by ID');
radio.setStreaming(false);
assert.equal(active().length, 0);
console.log('Radio stream shutdown, resumption, exclusions, navigation and persistence passed.');
