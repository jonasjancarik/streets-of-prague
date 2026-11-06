import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bridgeRegressions } from './bridge-regressions.mjs';

test('a better worst bridge join cannot hide a worse join at the other end', () => {
  const before = { built: 'map', rows: [{ id: 'deck', break: 0, joins: [.8, -.1] }] };
  const after = { ...before, rows: [{ id: 'deck', break: 0, joins: [.3, -.35] }] };
  assert.equal(bridgeRegressions(before, after)[0].id, 'deck');
  assert.deepEqual(bridgeRegressions(before, { ...after, rows: [{ ...after.rows[0], joins: [.3, -.12] }] }), []);
  assert.deepEqual(bridgeRegressions(before, { ...after, built: 'different' }), [{ reason: 'bridge identities differ' }]);
});
