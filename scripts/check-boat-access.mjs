#!/usr/bin/env node
// CPU regressions for boat boarding, without a browser or GPU context.
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import * as THREE from 'three';

globalThis.location = { search: '' };
const server = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false, ws: false } });
try {
  const { Boats } = await server.ssrLoadModule('/src/boats.ts');
  const { fences } = await server.ssrLoadModule('/src/fences.ts');
  // Far outside the real city, so the fence fixture cannot affect a running game.
  const origin = 10000;
  let bankHeight = 0.4, wall = false, unloaded = false, inlet = false;
  const water = {
    waterAt: (x) => unloaded ? null : x < origin || (inlet && x > origin + 0.45 && x < origin + 0.8),
    terrainAt: (x, _y, onWater) => onWater || x < origin ? 0 : bankHeight,
    cellAt: (x) => wall && x > origin + 0.15 && x < origin + 0.4 ? 255 : 0,
  };
  const boats = new Boats(new THREE.Scene(), water, [origin, origin]);
  const b = boats.list.find(b => b.kind === 'pedal');
  Object.assign(b, { x: origin - 2, y: origin, h: Math.PI / 2, live: true, moored: true });
  const x = origin + 1, y = origin;
  assert.equal(boats.near(x, y, 0.4), b, 'low, clear bank boards');
  assert.ok(boats.landing(b), 'low bank has a landing');
  assert.equal(boats.near(x, y, 8), null, 'player on a deck above cannot board');
  assert.equal(boats.near(origin - 1, y, 0.4), null, 'player in water cannot board');
  assert.equal(boats.near(origin + 3, y, 0.4), null, 'reach stays at 4.5 metres');
  bankHeight = 4;
  assert.equal(boats.near(x, y, bankHeight), null, 'high quay cannot board');
  assert.equal(boats.landing(b), null, 'high quay is not a mooring or exit');
  bankHeight = 0.4;
  wall = true;
  assert.equal(boats.reachable(b, x, y), false, 'wall between bank and boat blocks boarding');
  wall = false;
  inlet = true;
  assert.equal(boats.reachable(b, x, y), false, 'path cannot leave land and cross water again');
  inlet = false;
  unloaded = true;
  assert.equal(boats.landing(b), null, 'unloaded ground is not a landing');
  unloaded = false;
  const fence = { x1: origin, y1: origin - 5, x2: origin, y2: origin + 5, h: 2, hedge: false, broken: false };
  fences.add([fence]);
  try {
    assert.equal(boats.reachable(b, x, y), false, 'bank railing blocks boarding');
  } finally { fences.remove([fence]); }
  const corridor = {
    waterAt: x => x < origin,
    terrainAt: (x, _y, onWater) => onWater || x < origin ? 0 : 0.4,
    cellAt: (x, y) => x >= origin && x <= origin + 1.5 && (y < origin || y >= origin + 0.5) ? 255 : 0,
  };
  const narrow = new Boats(new THREE.Scene(), corridor, [origin, origin]);
  const tiedBoat = narrow.list.find(b => b.kind === 'pedal');
  Object.assign(tiedBoat, { x: origin - 2, y: origin + 0.25, h: Math.PI / 2, live: true, moored: true });
  const bank = [origin + 2, origin + 0.25];
  assert.equal(corridor.cellAt(bank[0], bank[1]), 0, 'corridor endpoint itself is clear');
  assert.equal(narrow.reachable(tiedBoat, ...bank), false, 'narrow intermediate route cannot fit the walker');
  assert.equal(narrow.near(...bank), null, 'narrow route cannot board');
  assert.equal(narrow.landing(tiedBoat), null, 'narrow route cannot moor or exit');
  corridor.cellAt = x => x < origin ? 255 : 0;
  assert.equal(narrow.reachable(tiedBoat, ...bank), true, 'open bank works with solid water cells at the shoreline');
  assert.equal(narrow.near(...bank), tiedBoat, 'open bank boards without expanding reach');
  assert.ok(narrow.landing(tiedBoat), 'open bank still offers a landing');
  corridor.terrainAt = (x, y, onWater) => onWater || x < origin ? 0 : x <= origin + 1.5 && y > origin + 0.5 ? 4 : 0.4;
  assert.equal(narrow.reachable(tiedBoat, ...bank), false, 'intermediate footprint also checks bank height');
  for (const kind of ['cruise', 'pedal', 'swan']) {
    const model = boats.list.find(b => b.kind === kind).mesh;
    const values = model.geometry.getAttribute('glow').array;
    assert.ok(values.some(v => v === 2), `${kind} has night lamp geometry`);
    assert.equal(model.children.length, 0, `${kind} adds no per-boat light object`);
  }
  const passing = boats.list.find(o => o !== b && o.kind === 'pedal');
  Object.assign(passing, { x: b.x, y: b.y + 1, h: b.h, live: true, moored: false });
  const tied = [b.x, b.y];
  boats.update(0.1, origin, origin);
  assert.deepEqual([b.x, b.y], tied, 'passing boats cannot push a moored boat away from the bank');
  boats.list.forEach(o => Object.assign(o, { x: origin - 20, y: origin, live: true, moored: true }));
  b.live = passing.live = false;
  const attempts = [];
  boats.place = candidate => attempts.push(candidate);
  boats.update(0, origin, origin);
  boats.update(0, origin, origin);
  assert.deepEqual(attempts, [b, passing], 'failed mooring attempt does not starve the next boat');
  console.log('Boat access: low bank, high quay/deck, water, reach, wall, inlet, unloaded ground, railing, narrow route, route height, open shoreline, stable moorings, fair spawn attempts and all three lamp models passed.');
} finally {
  await server.close();
}
