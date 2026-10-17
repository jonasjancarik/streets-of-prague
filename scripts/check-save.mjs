#!/usr/bin/env node
// Save parsing and browser-storage failures, without a map, network or browser.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'vite';

const storage = new Map();
let blocked = false;
const access = () => { if (blocked) throw new Error('Storage blocked'); };
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  get length() { access(); return storage.size; },
  getItem(key) { access(); return storage.get(key) ?? null; },
  setItem(key, value) { access(); storage.set(key, String(value)); },
  key(index) { access(); return [...storage.keys()][index] ?? null; },
  removeItem(key) { access(); storage.delete(key); },
} });
globalThis.location = { search: '?lang=en' };
const server = await createServer({ configFile: false, optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false, ws: false } });
try {
  const { readSave, unreadable, writeSave, listSaves, clearSave, describe } = await server.ssrLoadModule('/src/save.ts');
  const { TYPES } = await server.ssrLoadModule('/src/car.ts');
  const { KINDS } = await server.ssrLoadModule('/src/weather.ts');

  const game = {
    v: 1, area: 'prague', at: Date.now(), lat: 50.08, lon: 14.42, heading: 90,
    street: 'Karlova', car: { type: 'hatch', paint: '#336699', variant: null, damage: 12 },
    money: 9320, ticket: { from: 3600, minutes: 90 }, health: 80, heat: 2,
    clock: 5400, season: 270, weather: { kind: 'rain', fixed: true },
  };
  writeSave('auto', game);
  assert.deepEqual(readSave('auto', game.area), game, 'current save round trips');
  assert.equal(unreadable('auto', game.area), false);
  assert.match(describe(readSave('auto', game.area)), /Karlova/);
  assert.equal(readSave('auto', 'another-map'), null, 'saves stay with their own map');
  assert.equal(unreadable('auto', 'another-map'), false, 'another map is not corruption');

  const legacy = structuredClone(game);
  delete legacy.season;
  writeSave('legacy', legacy);
  assert.deepEqual(readSave('legacy', game.area), legacy, 'pre-season and pre-radio/lamp saves still open');
  const current = structuredClone(game);
  Object.assign(current.car, { box: 'parcel', radio: -1, broken: 15, ram: true });
  writeSave('current', current);
  assert.deepEqual(readSave('current', game.area), current, 'optional car state survives');
  const foot = { ...game, car: null, ticket: null, street: null };
  writeSave('foot', foot);
  assert.deepEqual(readSave('foot', game.area), foot, 'walking without a ticket is valid');
  writeSave('removed-model', { ...game, car: { ...game.car, type: 'a-removed-type', variant: 'a-removed-model' } });
  assert.ok(readSave('removed-model', game.area), 'removed vehicle models do not discard the rest of a save');
  for (const kind of KINDS) {
    writeSave('weather', { ...game, weather: { kind, fixed: false } });
    assert.equal(readSave('weather', game.area)?.weather.kind, kind, 'all existing weather kinds remain readable');
  }

  const corrupt = [
    ['invalid JSON', '{'], ['empty value', ''], ['null root', 'null'], ['array root', '[]'],
    ...[
      ['unknown version', { v: 2 }], ['missing area', { area: undefined }],
      ['bad position', { lat: 91 }], ['longitude outside the globe', { lon: 181 }],
      ['nonfinite number after JSON parse', { money: null }],
      ['missing street', { street: undefined }], ['object street', { street: {} }],
      ['negative clock', { clock: -1 }], ['clock past the week', { clock: 604800 }],
      ['extreme finite clock', { clock: 1e20 }], ['invalid heading', { heading: 1e308 }],
      ['missing weather kind', { weather: {} }], ['unknown weather kind', { weather: { kind: 'hail', fixed: true } }],
      ['wrong weather fixed type', { weather: { kind: 'rain', fixed: 'yes' } }],
      ['wrong date type', { season: 'winter' }], ['incomplete car', { car: {} }],
      ['wrong car type', { car: 'car' }], ['incomplete ticket', { ticket: {} }],
      ['wrong ticket type', { ticket: '90 minutes' }], ['expired invalid duration', { ticket: { from: 0, minutes: -90 } }],
      ...['type', 'paint', 'variant', 'damage', 'box', 'radio', 'broken', 'ram'].map(field => [
        `bad car ${field}`, { car: { ...game.car, [field]: {} } },
      ]),
    ].map(([name, patch]) => [name, JSON.stringify({ ...game, ...patch })]),
    ['numeric JSON overflow', JSON.stringify(game).replace('"health":80', '"health":1e400')],
  ];
  for (const [name, raw] of corrupt) {
    storage.set('save:auto', raw);
    assert.equal(readSave('auto', game.area), null, name);
    assert.equal(unreadable('auto', game.area), true, `${name} is reported as unreadable`);
    assert.equal(storage.get('save:auto'), raw, `${name} is preserved for recovery or deletion`);
  }

  storage.clear();
  writeSave('hand:older', { ...game, at: game.at - 1000 });
  writeSave('hand:newer', game);
  writeSave('hand:other-map', { ...game, area: 'another-map' });
  storage.set('save:hand:broken', '{}');
  storage.set('unrelated', 'untouched');
  assert.deepEqual(listSaves(game.area).map(({ slot }) => slot), ['hand:newer', 'hand:older', 'hand:broken']);
  assert.equal(listSaves(game.area).at(-1).data, null, 'broken manual saves remain listed for deletion');
  clearSave('hand:broken');
  assert.equal(storage.has('save:hand:broken'), false);
  assert.equal(storage.get('unrelated'), 'untouched');
  assert.equal(unreadable('missing', game.area), false, 'missing storage is not corruption');

  // Run the actual resume closure with inert world/car substitutes. This tests the
  // startup guard without a GPU or running the rest of main.ts's browser boot code.
  const main = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
  const resumeSource = main.match(/const resume = async \(s: SaveData\) => \{[\s\S]*?\n  \};/)?.[0];
  assert.ok(resumeSource, 'locate the production restore closure');
  const cars = [];
  const state = {
    clock: {}, world: { hasAt: () => true }, season: { set() {} }, weather: { begin() {} },
    automaticWeather: kind => kind, wallet: {}, health: {}, dev: { toLocal: () => [1, 2] },
    index: {}, clamp: Math.max, teleportTo: async () => {}, police: {}, TYPES,
    Car: class {
      constructor(type, rng, x, y, h) {
        assert.ok(Object.hasOwn(TYPES, type), `${type} must not be constructed as a car`);
        Object.assign(this, { type, x, y, h, spec: TYPES[type] }); cars.push(this);
      }
      setVariant() {}
      armour() { this.ram = true; }
    },
    seeded: () => 0.5, loose: [], restingStale: false, walker: { sync() {} }, enterOrExit() {},
  };
  const resume = new Function(...Object.keys(state), resumeSource.replace('const resume = async (s: SaveData)', 'return async (s)'))(...Object.values(state));
  for (const type of ['a-removed-type', 'toString', 'constructor', '__proto__']) {
    const data = { ...game, car: { ...game.car, type } };
    writeSave('unknown-car', data);
    await resume(readSave('unknown-car', game.area));
    assert.equal(cars.length, 0, `unknown ${type} falls back to walking`);
    assert.equal(state.wallet.balance, game.money, 'fallback keeps the rest of the game');
  }
  await resume(current);
  assert.equal(cars.length, 1, 'known car is restored');
  assert.equal(cars[0].damage, current.car.damage);
  assert.equal(cars[0].radio, -1);
  assert.equal(cars[0].broken, 15);
  assert.equal(cars[0].ram, true);

  blocked = true;
  assert.equal(readSave('auto', game.area), null);
  assert.equal(unreadable('auto', game.area), false);
  assert.deepEqual(listSaves(game.area), []);
  assert.doesNotThrow(() => writeSave('auto', game));
  assert.doesNotThrow(() => clearSave('auto'));
  console.log(`Save regressions passed: current and legacy state, ${corrupt.length} corrupt cases, map isolation, listing and blocked storage.`);
} finally {
  await server.close();
}
