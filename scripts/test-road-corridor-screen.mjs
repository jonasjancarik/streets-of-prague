import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'road-corridor-screen-'));
  t.after(() => rmSync(dir, { recursive: true }));
  const put = (name, data) => writeFileSync(join(dir, name), JSON.stringify(data));
  const digest = name => createHash('sha256').update(readFileSync(join(dir, name))).digest('hex');
  const read = name => JSON.parse(readFileSync(join(dir, name), 'utf8'));
  const run = (script, ...args) => execFileSync(process.execPath,
    [fileURLToPath(new URL(script, import.meta.url)), ...args.map(p => join(dir, p))], { stdio: 'pipe' });
  return { put, digest, read, run };
}

test('a smoother corridor must also preserve the approaches and match the measured sidecar', t => {
  const { put, digest, read, run } = fixture(t);
  const built = 'test';
  const ids = ['safe', 'rough-join', 'rough-neighbour', 'missing-asphalt'];
  const cases = ids.map(edge => ({ edge, id: 'corridor:' + edge, at: [50, 14] }));
  put('current', { built, patches: [{ id: 'prior' }] });
  put('trial', { built, patches: [...cases.map(({ id }) => ({ id })), { id: 'prior' }] });
  put('manifest', { built, baselineDigest: digest('current'), cases });
  const probe = (edge, active) => ({
    edge, active, asphalt: ['raster'], coveredStations: 80, stations: 80, samples: 800, coverageHash: 123,
    waves: [4, 6, 12, 20].map(span => ({ span, acrossAsphalt: { mesh: active ? .10 : .30 }, acrossDriving: active ? .11 : .28 })),
    joins: [0, 1].map(() => ({ meshStep: .07, drivingStep: .07, meshWave: .08, drivingWave: .08 })),
    guards: [{ id: 'nearby', profile: [[0, 0, 0], [0, 0, 0], [0, 0, 0]] }],
  });
  const before = { built, digest: digest('current'), results: ids.map(id => probe(id, false)) };
  const after = { built, digest: digest('trial'), results: ids.map(id => probe(id, true)) };
  after.results[1].joins[0].meshWave = .15;
  after.results[2].guards[0].profile[1][0] = .09;
  after.results[3].coverageHash = 124;
  put('before', before);
  put('after', after);
  const screen = () => run('./screen-road-corridors.mjs', 'manifest', 'current', 'trial', 'before', 'after', 'accepted', 'report');
  screen();
  assert.deepEqual(read('accepted').patches.map(p => p.id), ['corridor:safe', 'prior']);
  assert.deepEqual(read('report').map(r => r.reason), [null, 'corridor join got rougher',
    'adjoining-road grade increased', 'asphalt sample coverage differs or is incomplete']);
  put('after', { ...after, digest: 'stale' });
  assert.throws(screen, /sidecar digest differs/);
});

test('citywide verification prunes only new fits attributed to an unsafe approach', t => {
  const { put, digest, read, run } = fixture(t);
  const built = 'test';
  put('current', { built, patches: [{ id: 'prior' }] });
  put('trial', { built, patches: [{ id: 'new-good' }, { id: 'new-unsafe' }, { id: 'prior' }] });
  const road = { id: 'street', step: 0, bump: .2, lean: 0, crown: 0, twist: 0, off: 0 };
  put('before', { built, patchDigest: digest('current'), rows: [road] });
  put('after', { built, patchDigest: digest('trial'),
    rows: [{ ...road, bump: .04, unsafeApproach: true, patches: ['new-unsafe', 'prior'] }] });
  put('steps', { built, patchDigest: digest('trial'), changed: [] });
  assert.throws(() => run('./verify-road-corridors.mjs', 'current', 'trial', 'before', 'after', 'steps', 'pruned'),
    e => e.status === 1 && JSON.parse(e.stdout).excluded[0] === 'new-unsafe');
  assert.deepEqual(read('pruned').patches.map(p => p.id), ['new-good', 'prior']);
});
