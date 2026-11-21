// Exercise the real pedestrian graph in both directions, at a multilevel crossing
// and at the edge of the currently loaded city.
import assert from 'node:assert/strict';
import { WalkGraph } from '../src/network.ts';
import { walkingSearch } from '../src/walkingDirections.ts';
function findWalkingWay(...args) {
  const search = walkingSearch(...args);
  let next = search.next();
  while (!next.done) next = search.next();
  return next.value;
}
const graph = new WalkGraph();
function add(u, v, x, y, xx, yy, hw = 'footway', extra = {}) {
  graph.add([{ id: u + '>' + v, u, v, hw, width: 3, pts: [[x, y], [xx, yy]], ...extra }]);
}
add('a', 'b', 0, 0, 20, 0);
add('b', 'c', 20, 0, 20, 20, 'steps');
add('c', 'd', 20, 20, 45, 20, 'pedestrian', { name: 'Passage' });
const paths = { graph, near: () => graph.edges };
const up = findWalkingWay(paths, { x: 1, y: 0, level: 0 }, { x: 44, y: 20 });
assert.ok(up?.reached);
assert.equal(up.line.length, 63);
assert.ok(up.turns.some((t) => t.kind === 'stairs'));
assert.ok(up.turns.some((t) => t.kind === 'right' && t.onto === 'Passage'));
const back = findWalkingWay(paths, { x: 44, y: 20, level: 0 }, { x: 1, y: 0 });
assert.ok(back?.reached);
assert.equal(back.line.length, 63);
assert.deepEqual(back.line.pts[0], [44, 20]);
const same = findWalkingWay(paths, { x: 16, y: 0, level: 0 }, { x: 2, y: 0 });
assert.ok(same.reached);
assert.equal(same.line.length, 14);
const partial = findWalkingWay(paths, { x: 3, y: 0, level: 0 }, { x: 500, y: 100 });
assert.ok(partial && !partial.reached);
assert.deepEqual(partial.line.pts.at(-1), [45, 20]);
add('island-a', 'island-b', 80, 0, 90, 0);
const isolated = findWalkingWay(paths, { x: 3, y: 0, level: 0 }, { x: 90, y: 0 });
assert.ok(!isolated?.reached, 'two disconnected paths never become a walk through the gap');
add('p', 'q', 0, 0, 20, 0, 'footway', { bridge: true, level: 2 });
add('q', 'r', 20, 0, 75, 0, 'footway', { bridge: true, level: 2 });
const bridge = findWalkingWay(paths, { x: 3, y: 0, level: 2 }, { x: 65, y: 0, level: 2 });
assert.ok(bridge.reached);
assert.equal(bridge.line.length, 62);
assert.equal(findWalkingWay(paths, { x: 3, y: 0, level: -1 }, { x: 15, y: 0 }), null);
console.log(
  'Walking directions passed for turns, stairs, reverse travel, disconnected paths, a partial route and a bridge above a path',
);

const lawn = findWalkingWay({ ...paths, accessible: () => true }, { x: 1, y: 0, level: 0 }, { x: 40, y: 25 });
assert.deepEqual(lawn.line.pts.at(-1), [40, 25]);
const closed = findWalkingWay({ ...paths, accessible: (a, b) => b[1] !== 25 }, { x: 1, y: 0, level: 0 }, { x: 40, y: 25 });
assert.deepEqual(closed.line.pts.at(-1), [40, 20]);
assert.ok(closed.nearestPath);
