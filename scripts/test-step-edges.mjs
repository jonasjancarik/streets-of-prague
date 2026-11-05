// The edges at the tops of steps (src/stepEdges.ts), on a made-up tile: no browser or map needed.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stepEdges, stampEdges, parapetArrays, EDGE_DROP } from '../src/stepEdges.ts';
import { bridgeApproaches } from '../src/roadLevels.ts';

// A terrace (label 2) over the west half of a 100 m tile, `drop` m below the rest.
const box = [0, 0, 100, 100];
const terrace = [{ label: 2, polys: [[[[0, 0], [50, 0], [50, 100], [0, 100]]]] }];
const height = (drop) => (x, y, side) => (side === 2 ? 0 : typeof drop === 'function' ? drop(y) : drop);
const metres = (edges) => edges.reduce((a, e) => a + Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1]), 0);

test('a step of 3 m is an edge all along, facing the higher ground', () => {
  const edges = stepEdges(terrace, [], height(3), box, []);
  assert.ok(Math.abs(metres(edges) - 100) < 1e-6, `${metres(edges)} m`);
  for (const e of edges) { assert.equal(e.nx, 1); assert.equal(e.ha, 3); assert.equal(e.drop, 3); assert.ok(e.parapet); }
  assert.ok(edges[0].first && edges.at(-1).last && !edges[1].first);
});

test('a low step is none, and a ramp is open where it is low', () => {
  assert.equal(stepEdges(terrace, [], height(EDGE_DROP - 0.1), box, []).length, 0);
  const edges = stepEdges(terrace, [], height((y) => y * 0.05), box, []); // 0 m at the south end, 5 m at the north
  assert.ok(edges.every((e) => (e.a[1] + e.b[1]) / 2 > EDGE_DROP / 0.05 - 1));
  assert.ok(Math.abs(metres(edges) - (100 - EDGE_DROP / 0.05)) < 1.5, `${metres(edges)} m`);
});

test('a way across the step opens it over its width; one along it does not', () => {
  const across = stepEdges(terrace, [], height(3), box, [{ pts: [[30, 40], [70, 40]], half: 3 }]);
  assert.ok(across.every((e) => Math.abs((e.a[1] + e.b[1]) / 2 - 40) >= 3));
  assert.ok(Math.abs(metres(across) - 93) <= 1.01, `${metres(across)} m`);
  const along = stepEdges(terrace, [], height(3), box, [{ pts: [[49, 0], [51, 100]], half: 3 }]);
  assert.ok(Math.abs(metres(along) - 100) < 1e-6);
});

test('a quay low above the water has no parapet, and a bank below the water no edge', () => {
  const water = [[[[0, 0], [50, 0], [50, 100], [0, 100]]]];
  const H = (up) => (x, y, side) => (side === true || side === 1 ? 0 : up);
  const low = stepEdges([], water, H(1.5), box, []);
  assert.ok(low.length && low.every((e) => e.wet && !e.parapet));
  assert.ok(stepEdges([], water, H(4), box, []).every((e) => e.parapet));
  assert.equal(stepEdges([], water, H(-2), box, []).length, 0);
});

test('the edge is solid in the grid on the higher side, and parapets have geometry', () => {
  const edges = stepEdges(terrace, [], height(3), box, [{ pts: [[30, 40], [70, 40]], half: 3 }]);
  const w = 200, h = 200, cells = new Uint8Array(w * h);
  stampEdges(edges, cells, w, h, (x, y) => [x * 2, (100 - y) * 2]);
  const at = (x, y) => cells[Math.floor((100 - y) * 2) * w + Math.floor(x * 2)];
  assert.equal(at(50.2, 80), 255);
  assert.equal(at(50.2, 40), 0);
  assert.equal(at(52, 80), 0);
  assert.equal(at(48, 80), 0);
  const p = parapetArrays(edges);
  assert.ok(p.position.length > 0 && p.position.length === p.normal.length && p.position.every(Number.isFinite));
});

// A bridge can open a pad at its raised stretch's ends, including where a raw edge
// continues onto ground. Its overhead middle must leave the wall below intact.
test('bridge approaches open pads at level transitions, not below the middle of a deck', () => {
  const edge = { bridge: true, pts: [[10, 40], [90, 40]], levels: [[0, 0], [40, 1], [70, 0]] };
  const ways = bridgeApproaches(edge).map((pts) => ({ pts, half: 3 }));
  const approach = stepEdges(terrace, [], height(3), box, ways);
  assert.ok(approach.every((e) => Math.abs((e.a[1] + e.b[1]) / 2 - 40) >= 3));
  assert.ok(metres(approach) < 95);
  const middle = { bridge: true, pts: [[10, 40], [90, 40]], level: 1 };
  const below = stepEdges(terrace, [], height(3), box, bridgeApproaches(middle).map((pts) => ({ pts, half: 3 })));
  assert.equal(metres(below), 100);
  assert.deepEqual(bridgeApproaches({ ...edge, bridge: false }), []);
  assert.deepEqual(bridgeApproaches({ bridge: true, pts: edge.pts, level: 0 }), []);
});
