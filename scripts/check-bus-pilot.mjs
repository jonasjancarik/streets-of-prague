#!/usr/bin/env node
// Verify placement and trip identity across a traffic unload, and both 227
// approaches to Nové náměstí against the built Prague road graph.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { City } from './offline-city.mjs';
import { BusPilot } from '../src/busPilot.ts';
import { busAt, BusRun } from '../src/buses.ts';

const city = new City('praha');
const data = JSON.parse(readFileSync(new URL('buses.json', city.dir), 'utf8')).pilot227;
assert.ok(data, 'rebuild the Prague bus data before running this check');
const pilot = new BusPilot(data);
const tiles = [];
for (let i = 104; i <= 111; i++) for (let j = 38; j <= 43; j++) tiles.push(`${i}_${j}`);
const graph = city.graph(tiles);
const outgoing = (node) => graph.out.get(node) || [];
for (const to of ['Nedvězí', 'Háje']) {
  const trip = pilot.trips.find(({ line }) => line.to === to);
  const [at] = trip.visits.find((visit) => visit[1] === 'Nové náměstí');
  const start = busAt(trip.line, at - 300, graph.edges, () => true, outgoing);
  assert.ok(start, `${to}: joins the road graph before Nové náměstí`);
  const { run } = start;
  let edge = start.edge;
  for (let i = 0; edge && i < 100 && run.ahead < at + 160; i++) {
    assert.doesNotMatch(edge.id, /35002971|293404568|323407433|1119588110/, `${to}: stays off Morávkova`);
    edge = run.pick(edge, outgoing(edge.v).filter((next) => next !== edge.twin));
  }
  assert.ok(run.ahead >= at, `${to}: reaches Nové náměstí`);
}

const fixture = new BusPilot({
  shapes: { road: [[0, 0], [500, 0], [1000, 0]] },
  trips: [['test', 'road', 'East', ['weekday'], [
    [0, 'First', 'A', 100, 100], [500, 'Second', 'B', 200, 200], [1000, 'End', 'C', 300, 300],
  ]]],
});
const spawned = [];
const spawn = (line, along, max, schedule) => {
  assert.ok(along < max);
  const run = new BusRun(line, along);
  run.schedule = schedule;
  spawned.push(run);
  return run;
};
const active = new Set();
fixture.update(150, active, () => false, undefined, spawn);
assert.equal(spawned.length, 0);
fixture.update(151, active, () => true, undefined, spawn);
const first = spawned[0];
assert.ok(first);
active.add(first);
fixture.update(152, active, () => true, undefined, spawn);
assert.equal(spawned.length, 1);
first.along = 250;
active.clear();
fixture.update(153, active, () => false, undefined, spawn);
fixture.update(154, active, () => true, undefined, spawn);
assert.equal(spawned.length, 2);
assert.equal(spawned[1].schedule.key, first.schedule.key);
assert.equal(spawned[1].along, 255, 'the trip retains its delay after the vehicle is unloaded');
console.log('227 approaches, trip identity and delay across an unload passed');
