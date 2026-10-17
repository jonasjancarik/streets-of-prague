// No network or speakers: exercise stream lifetime against instrumented media elements.
import assert from 'node:assert/strict';

const saved = new Map();
globalThis.localStorage = { getItem: (key) => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) };
const media = [];
const staticSources = [];
globalThis.Audio = class {
  paused = true;
  src = '';
  loads = 0;
  listeners = new Map();
  constructor() { media.push(this); }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  emit(type) { this.listeners.get(type)?.(); }
  play() { this.paused = false; return Promise.resolve(); }
  pause() { this.paused = true; }
  removeAttribute(name) { if (name === 'src') this.src = ''; }
  load() { this.loads++; }
};
const param = () => ({ value: 0, cancelScheduledValues() {}, setTargetAtTime(v) { this.value = v; }, setValueAtTime(v) { this.value = v; }, linearRampToValueAtTime(v) { this.value = v; } });
const node = () => ({ gain: param(), frequency: param(), Q: param(), stops: 0, connect(other) { return other; }, disconnect() {}, start() {}, stop() { this.stops++; } });
const ctx = { currentTime: 0, createGain: node, createBiquadFilter: node, createMediaElementSource: node, createBufferSource() { const source = node(); staticSources.push(source); return source; } };
const { Radio, STATIONS, selectStation } = await import('../src/radio.ts');
const { stationAllowed, setStationAllowed, stationDistribution, setStationDistribution } = await import('../src/radio-preferences.ts');
const radio = new Radio(ctx, {}, node());
const active = () => media.filter((el) => el.src);
const firstCar = {};
radio.pick(0);
radio.update(true, firstCar);
assert.equal(active().length, 1, 'one audible stream');
radio.update(false);
radio.warm(true, 1);
assert.equal(active().length, 2, 'audible car becomes a linger stream alongside next-car buffer');
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
radio.warm(false, 61); // no next-car buffer when leaving this time
const leavingStatic = staticSources.at(-1);
radio.update(false);
radio.warm(false, 61);
assert.equal(active().length, 0, 'walking away expires both buffers');
assert.equal(leavingStatic.stops, 1, 'loading static stops after leaving the car, even without a playing event');
radio.update(true, firstCar);
const oldWave = active()[0];
radio.pick(1);
radio.pick(0);
const currentWave = active()[0], currentStatic = staticSources.at(-1);
oldWave.emit('playing');
assert.equal(currentStatic.stops, 0, 'late playing from a closed stream cannot stop its replacement static');
currentWave.emit('playing');
assert.equal(currentStatic.stops, 1, 'the current stream playing event stops its own loading static');
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
for (const s of STATIONS) setStationAllowed(s.id, true);
assert.equal(stationDistribution(), 'random', 'equal chance remains the default');
for (let i = 0; i < STATIONS.length; i++) {
  assert.equal(selectStation(-1, () => (i + 0.5) / STATIONS.length), i, 'equal chance covers each station evenly');
}
const current = radio.station;
setStationDistribution('audience');
assert.equal(radio.station, current, 'changing distribution keeps current station');
const expected = [38, 277, 38, 38, 38, 500, 668, 38, 42, 38];
const total = expected.reduce((sum, n) => sum + n, 0);
const counts = STATIONS.map(() => 0);
for (let i = 0; i < total; i++) counts[selectStation(6, () => (i + 0.5) / total)]++;
assert.deepEqual(counts, expected, 'independent audience draws preserve exact proportions, including repeats');
setStationAllowed('evropa2', false);
for (let i = 0; i < 100; i++) assert.notEqual(selectStation(-1, () => (i + 0.5) / 100), 6, 'audience selection excludes blocked stations');
assert.equal(JSON.parse(saved.get('radio-preferences')).distribution, 'audience', 'blocking preserves chosen distribution');
const reloaded = await import('../src/radio-preferences.ts?reload');
assert.equal(reloaded.stationDistribution(), 'audience', 'distribution survives reload');
assert.equal(reloaded.stationAllowed('evropa2'), false, 'exclusions survive reload');
setStationDistribution('random');
assert.equal(stationAllowed('evropa2'), false, 'changing distribution preserves exclusions');
assert.equal(active().length, 0, 'settings changes cannot reopen muted streams');
console.log('Radio stream lifetime, exclusions, navigation, equal/weighted selection and persistence passed.');
