#!/usr/bin/env node
// CPU regressions for the cruise boats on the fairway and for the ferries' timetable,
// without a browser or map data.
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import * as THREE from 'three';

globalThis.location = { search: '' };
const server = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false, ws: false } });
try {
  const { Boats } = await server.ssrLoadModule('/src/boats.ts');
  const { Ferries } = await server.ssrLoadModule('/src/ferries.ts');
  const { parseRiver } = await server.ssrLoadModule('/src/river.ts');
  // A straight river 60 m wide and 900 m long, far from the real city, whose water
  // drops 2 m at x = 500 (a lock's worth).
  const O = 20000, half = 30;
  const water = {
    waterAt: (x, y) => (x < O - 50 || x > O + 950 ? null : Math.abs(y - O) < half),
    terrainAt: (x) => (x < O + 500 ? 2 : 0),
    cellAt: () => 0,
  };
  const pts = [];
  for (let x = 0; x <= 900; x += 12) pts.push([O + x, O, half]);
  const boats = new Boats(new THREE.Scene(), water, null, undefined, [{ pts }]);
  const b = boats.list[0];
  assert.equal(b.kind, 'cruise');
  boats.update(0, O + 450, O);
  for (let i = 0; i < 50 && !b.live; i++) boats.update(0, O + 450, O);
  assert.ok(b.live && b.course, 'a cruise boat is put on the fairway near the player');
  for (const o of boats.list) if (o !== b) { o.live = false; o.mesh.visible = false; }
  boats.place = () => {}; // just this one
  Object.assign(b, { x: O + 300, y: O - 10, h: 0, along: 300, dir: 1, v: 0, about: 0, z: null });
  let turned = 0, dir = b.dir, maxOff = 0, maxRise = 0, z = null, reached = 0;
  const dt = 0.1;
  for (let i = 0; i < 12000; i++) {
    boats.update(dt, b.x, b.y);
    assert.ok(b.live, 'the boat stays on the water');
    if (b.dir !== dir) { turned++; dir = b.dir; }
    maxOff = Math.max(maxOff, Math.abs(b.y - O));
    if (z !== null) maxRise = Math.max(maxRise, Math.abs(b.z - z));
    z = b.z;
    reached = Math.max(reached, b.x - O);
  }
  assert.ok(maxOff < half - 3.2, `it keeps off the banks (${maxOff.toFixed(1)} m from the middle)`);
  assert.ok(reached > 800, `it sails to the end of the stretch (${reached.toFixed(0)} m)`);
  assert.ok(turned >= 1, 'and turns round there');
  assert.ok(maxRise <= 0.3 * dt + 1e-6, `its height follows a 2 m step in the water gradually (${maxRise.toFixed(3)} m a step)`);

  // Ferries: one all-year line and one seasonal, 200 m across.
  const line = (ref, allYear) => ({ ref, name: ref, colour: '#00B3CB', allYear, every: 15, hours: [6, 20], mins: [2],
    stops: [{ name: 'West', berth: [O, O + 100], gate: [O - 8, O + 100] }, { name: 'East', berth: [O + 200, O + 100], gate: [O + 208, O + 100] }],
    legs: [[[O, O + 100], [O + 200, O + 100]]] });
  const river = parseRiver({ fairway: [{ pts }], locks: [], ferries: [line('P1', true), line('P9', false), { ref: 'broken' }] });
  assert.equal(river.ferries.length, 2, 'a ferry line that does not fit is left out');
  const clock = { t: 0 };
  let day = 196;
  const ferries = new Ferries(river.ferries, new THREE.Scene(), { clock, day: () => day, water: () => 0, ground: () => 1 });
  const [p1, p9] = ferries.list;
  clock.t = 3 * 3600; ferries.update(0);
  assert.ok(!p1.open && p1.stop === 0, 'at night the ferry lies at its first landing');
  assert.equal(ferries.near(O - 8, O + 100), null, 'and cannot be boarded');
  assert.ok(ferries.near(O - 8, O + 100, true), 'but is there to ask about');
  clock.t = 6 * 3600 + 10; ferries.update(0);
  assert.ok(p1.open && p1.stop === 0 && p1.to === 1, 'in the morning it waits at the first landing');
  assert.equal(ferries.near(O - 8, O + 100), p1, 'and can be boarded from the gate');
  let crossed = false, back = false, far = 0;
  for (let s = 0; s < 900; s += 0.5) {
    const x = p1.x;
    clock.t += 0.5; ferries.update(0.5);
    far = Math.max(far, Math.abs(p1.x - x));
    if (p1.stop === 1) crossed = true;
    if (crossed && p1.stop === 0) back = true;
  }
  assert.ok(crossed && back, 'it crosses and comes back');
  assert.ok(far <= 2.4 * 0.5 + 1e-6, `without jumping (${far.toFixed(2)} m in half a second)`);
  assert.ok(p9.open, 'the seasonal line sails in July');
  day = 15; ferries.update(0);
  assert.ok(!p9.open && p1.open, 'and not in January, when the all-year one does');
  ferries.board(p1);
  const walker = { x: 0, y: 0, h: 0, vx: 0, vy: 0 };
  ferries.seat(walker);
  assert.deepEqual([walker.x, walker.y], [p1.x, p1.y], 'the rider goes with the boat');
  const [ax] = ferries.ashore(p1.line.stops[1], (x, y) => [x, y]);
  assert.ok(ax > O + 208, 'and steps off onto the bank beyond the gate');
  console.log('River boats: fairway following, keeping off the banks, turning at the end, gradual height change, ferry hours, season, crossing and landing passed.');
} finally {
  await server.close();
}
