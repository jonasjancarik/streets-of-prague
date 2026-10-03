#!/usr/bin/env node
// Deterministic tile network checks against the real TypeScript module, without a browser.
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { createServer } from 'vite';

globalThis.location = { search: '?go' };
globalThis.self = globalThis;
const server = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false, ws: false } });
const originalFetch = globalThis.fetch;
try {
  const { TileWorld } = await server.ssrLoadModule('/src/tiles.ts');
  const tile = { i: 0, j: 0, box: [0, 0, 250, 250], areas: {}, roads: {}, buildings: [], walls: [], trees: [], rails: [] };
  const bytes = new Uint16Array([1800, 1800, 1800, 1800]);
  const world = () => Object.assign(Object.create(TileWorld.prototype), {
    area: 'fixture', index: { terrain: { n: 2, step: 250 }, gzip: false },
    pending: new Map(), jsons: new Map(), jsonRange: null, photos: new Map(), cover: null, ortho: false,
    bare: new Set(), structures: new Set(), iprTiles: new Map([['0_0', false]]),
    osmBuildings: false, retry: new Map(), loaded: new Map(), builds: new Map(), buildTimes: [],
  });
  let requests = [];
  const network = handler => {
    requests = [];
    globalThis.fetch = async url => {
      requests.push(String(url));
      return String(url).endsWith('.json') ? Response.json(tile) : handler(String(url));
    };
  };
  for (const [name, prepare] of [
    ['height', () => {}],
    ['bare', w => w.bare.add('0_0')],
    ['levels', w => w.structures.add('0_0')],
    ['ipr', w => w.iprTiles.set('0_0', true)],
  ]) {
    const w = world(); prepare(w);
    network(url => url.endsWith(`.${name}.bin`) ? new Response('unavailable', { status: 503 }) : new Response(bytes));
    await assert.rejects(w.fetchTile('0_0'), new RegExp(`Tile 0_0: required ${name} data could not be loaded`));
    assert.equal(w.pending.has('0_0'), false, `${name}: failed cache is discarded`);
    assert.ok(w.retry.has('0_0'), `${name}: normal retry cooldown is scheduled`);
    network(() => new Response(bytes));
    const files = await w.fetchTile('0_0');
    assert.equal(files[name].byteLength, bytes.byteLength, `${name}: later fetch recovers`);
  }
  const optional = world();
  network(() => new Response(bytes));
  const files = await optional.fetchTile('0_0');
  assert.equal(files.bare, null); assert.equal(files.levels, null); assert.equal(files.ipr, null);
  assert.equal(requests.length, 2, 'metadata-absent files are not requested');

  const legacyIndex = world(); legacyIndex.iprTiles.delete('0_0');
  globalThis.fetch = async url => String(url).endsWith('.json') ? Response.json({ ...tile, ipr: {} })
    : String(url).endsWith('.ipr.bin') ? new Response('missing', { status: 404 }) : new Response(bytes);
  await assert.rejects(legacyIndex.fetchTile('0_0'), /required ipr data/, 'JSON-declared IPR is required too');

  const aborted = world();
  network(() => { throw new DOMException('request aborted', 'AbortError'); });
  await assert.rejects(aborted.fetchTile('0_0'), { name: 'AbortError' });
  assert.equal(aborted.pending.has('0_0'), false);

  const compressed = world(); compressed.index.gzip = true;
  const gzip = gzipSync(bytes);
  network(() => new Response(gzip.subarray(0, gzip.length - 4)));
  await assert.rejects(compressed.fetchTile('0_0'));
  assert.equal(compressed.pending.has('0_0'), false, 'truncated gzip cannot remain cached');
  network(() => new Response(gzip));
  assert.equal((await compressed.fetchTile('0_0')).height.byteLength, bytes.byteLength);
  const decoded = world(); decoded.index.gzip = true;
  network(() => new Response(bytes));
  assert.equal((await decoded.fetchTile('0_0')).height.byteLength, bytes.byteLength, 'HTTP-decoded gzip is accepted');

  const obsolete = world();
  let rejectOld;
  network(() => new Promise((_resolve, reject) => { rejectOld = reject; }));
  const old = obsolete.fetchTile('0_0');
  obsolete.pending.delete('0_0'); // The camera moved away from a prefetched tile.
  network(() => new Response(bytes));
  const replacement = obsolete.fetchTile('0_0');
  rejectOld(new Error('obsolete network failure'));
  await assert.rejects(old, /obsolete network failure/);
  await replacement;
  assert.equal(obsolete.pending.get('0_0'), replacement, 'obsolete failure cannot evict a replacement fetch');
  assert.equal(obsolete.retry.has('0_0'), false, 'obsolete failure does not pause the replacement');

  // Run the existing bounded startup retry loop without wall-clock delays or rendering.
  const originalTimer = globalThis.setTimeout, originalWarn = console.warn;
  try {
    globalThis.setTimeout = done => { queueMicrotask(done); return 0; };
    let warnings = 0;
    console.warn = () => { warnings++; };
    for (const permanent of [false, true]) {
      const startup = world(); startup.around = () => ['0_0'];
      let downloads = 0, builds = 0;
      startup.make = async (_key, files) => {
        builds++;
        assert.ok(files.height, 'startup never builds missing terrain');
        startup.loaded.set('0_0', tile);
        return tile;
      };
      network(() => (++downloads < 3 || permanent) ? new Response('unavailable', { status: 503 }) : new Response(bytes));
      await startup.loadNow(0, 0, 1);
      assert.equal(downloads, 3, 'startup keeps its existing three-attempt limit');
      assert.equal(builds, permanent ? 0 : 1);
      assert.equal(startup.loaded.has('0_0'), !permanent);
      if (permanent) {
        assert.equal(startup.pending.has('0_0'), false);
        assert.ok(startup.retry.has('0_0'));
      }
    }
    assert.equal(warnings, 1, 'persistent failure remains reported after startup retries');
  } finally {
    globalThis.setTimeout = originalTimer;
    console.warn = originalWarn;
  }
  console.log('Tile fetch: required binaries, recovery, optional omissions, abort, truncated/decoded gzip, obsolete-request isolation and bounded startup retries/reporting passed.');
} finally {
  globalThis.fetch = originalFetch;
  await server.close();
}
