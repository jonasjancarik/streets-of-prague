#!/usr/bin/env node
// Deterministic tile network checks against the real TypeScript module, without a browser.
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { createServer } from 'vite';

globalThis.location = { search: '?go' };
globalThis.self = globalThis;
const server = await createServer({ configFile: false, optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false, ws: false } });
const originalFetch = globalThis.fetch;
try {
  const { TileWorld } = await server.ssrLoadModule('/src/tiles.ts');
  const tile = { i: 0, j: 0, box: [0, 0, 250, 250], areas: {}, roads: {}, buildings: [], walls: [], trees: [], rails: [] };
  const bytes = new Uint16Array([1800, 1800, 1800, 1800]); // valid legacy unlabelled height
  const labelled = new Uint8Array(12); labelled.set(new Uint8Array(bytes.buffer));
  const iprBytes = (triangles = 1, materials = true, buildings = triangles) => {
    // Independent audited fixtures: T=0:8; T=1:31/32; T=2:50/52 bytes.
    const size = triangles === 0 ? 8 : triangles === 1 ? (materials ? 32 : 31) : (materials ? 52 : 50);
    const out = new Uint8Array(size), header = new DataView(out.buffer);
    header.setUint32(0, triangles, true); header.setUint32(4, buildings, true);
    return out;
  };
  const payloads = { height: labelled, bare: bytes, levels: bytes, ipr: iprBytes() };
  const valid = url => payloads[String(url).match(/\.(height|bare|levels|ipr)\.bin/)[1]];
  const structures = [{ level: 1, kind: 'bridge', polys: [] }];
  const metadata = kind => ({ ...tile, ...(kind === 'levels' ? { structures } : {}), ...(kind === 'ipr' ? { ipr: { triangles: 1, buildings: 1 } } : {}) });
  const world = () => Object.assign(Object.create(TileWorld.prototype), {
    area: 'fixture', index: { terrain: { n: 2, step: 250 }, gzip: false },
    pending: new Map(), jsons: new Map(), jsonRange: null, photos: new Map(), cover: null, ortho: false,
    available: new Set(['0_0']), bare: new Set(), structures: new Set(), iprTiles: new Map([['0_0', false]]),
    osmBuildings: false, retry: new Map(), loaded: new Map(), builds: new Map(), buildTimes: [],
  });
  let requests = [];
  const network = (handler, data = tile) => {
    requests = [];
    globalThis.fetch = async url => {
      requests.push(String(url));
      return String(url).endsWith('.json') ? Response.json(data) : handler(String(url));
    };
  };
  for (const [name, prepare] of [
    ['height', () => {}],
    ['bare', w => w.bare.add('0_0')],
    ['levels', w => w.structures.add('0_0')],
    ['ipr', w => w.iprTiles.set('0_0', true)],
  ]) {
    const w = world(); prepare(w);
    network(url => url.endsWith(`.${name}.bin`) ? new Response('unavailable', { status: 503 }) : new Response(valid(url)), metadata(name));
    await assert.rejects(w.fetchTile('0_0'), new RegExp(`Tile 0_0: required ${name} data could not be loaded`));
    assert.equal(w.pending.has('0_0'), false, `${name}: failed cache is discarded`);
    assert.ok(w.retry.has('0_0'), `${name}: normal retry cooldown is scheduled`);
    network(url => new Response(valid(url)), metadata(name));
    const files = await w.fetchTile('0_0');
    assert.equal(files[name].byteLength, payloads[name].byteLength, `${name}: later fetch recovers`);
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

  // Required successful responses must contain a complete decoded layout, before
  // a fulfilled fetch can be cached or handed to make/workers.
  const prepare = (kind, w) => {
    if (kind === 'bare') w.bare.add('0_0');
    if (kind === 'levels') w.structures.add('0_0');
    if (kind === 'ipr') w.iprTiles.set('0_0', true);
  };
  const malformed = {
    height: [new Uint8Array(7), new Uint8Array(9), new Uint8Array(13)],
    bare: [new Uint8Array(7), new Uint8Array(9), new Uint8Array(12)],
    levels: [new Uint8Array(6), new Uint8Array(7), new Uint8Array(16)],
    ipr: [new Uint8Array(7), iprBytes(2).slice(0, 20), iprBytes(2).slice(0, 49), iprBytes(2).slice(0, 51)],
  };
  let rejectedSuccesses = 0;
  for (const kind of Object.keys(payloads)) {
    for (const bad of [null, new Uint8Array(), ...malformed[kind]]) {
      const w = world(); prepare(kind, w);
      network(url => url.includes(`.${kind}.bin`) ? new Response(bad, { status: bad === null ? 204 : 200 }) : new Response(valid(url)), metadata(kind));
      await assert.rejects(w.fetchTile('0_0'), new RegExp(`Tile 0_0: invalid ${kind} data.*decoded bytes.*fixture_now/tiles/0_0`));
      assert.equal(w.pending.has('0_0'), false, `${kind}: corrupt success is not cached`);
      assert.equal(w.jsons.has('0_0'), false, `${kind}: retry refreshes JSON too`);
      assert.ok(w.retry.has('0_0'), `${kind}: corrupt success schedules retry`);
      network(url => new Response(valid(url)), metadata(kind));
      assert.equal((await w.fetchTile('0_0'))[kind].byteLength, payloads[kind].byteLength, `${kind}: recovery has a valid layout`);
      rejectedSuccesses++;
    }
  }
  const shortIPR = new Uint8Array(8); new DataView(shortIPR.buffer).setUint32(0, 0xffffffff, true);
  const hugeHeader = world(); prepare('ipr', hugeHeader);
  network(url => new Response(url.includes('.ipr.bin') ? shortIPR : valid(url)), metadata('ipr'));
  await assert.rejects(hugeHeader.fetchTile('0_0'), /invalid ipr data/);

  for (const triangles of [0, 1, 2]) for (const materials of [false, true]) {
    const w = world(); prepare('ipr', w);
    const body = iprBytes(triangles, materials);
    network(url => new Response(url.includes('.ipr.bin') ? body : valid(url)), { ...tile, ipr: { triangles, buildings: triangles } });
    assert.equal((await w.fetchTile('0_0')).ipr.byteLength, body.byteLength, 'legacy/current odd/even IPR layouts');
  }
  for (const counts of [{ triangles: 2, buildings: 1 }, { triangles: 1, buildings: 2 }, { triangles: '1' }]) {
    const w = world(); prepare('ipr', w);
    network(url => new Response(valid(url)), { ...tile, ipr: counts });
    await assert.rejects(w.fetchTile('0_0'), /IPR header .*matching tile metadata/);
  }
  const zeroPromise = world(); prepare('ipr', zeroPromise);
  network(url => new Response(url.includes('.ipr.bin') ? iprBytes(0) : valid(url)), metadata('ipr'));
  await assert.rejects(zeroPromise.fetchTile('0_0'), /header triangles matching tile metadata 1/);

  for (const omitted of [undefined, []]) {
    const w = world(); prepare('levels', w);
    network(url => new Response(valid(url)), { ...tile, structures: omitted });
    await assert.rejects(w.fetchTile('0_0'), /nonempty structures array/);
  }
  for (const n of [1, 1.5, Number.MAX_SAFE_INTEGER]) {
    const w = world(); w.index.terrain.n = n;
    network(url => new Response(valid(url)));
    await assert.rejects(w.fetchTile('0_0'), /terrain grid size|safe integer payload size/);
  }
  const zeroHeight = world();
  network(() => new Response(new Uint8Array(12)));
  assert.equal((await zeroHeight.fetchTile('0_0')).height.byteLength, 12, 'correctly sized zero heights stay valid');
  const offLevel = world(); prepare('levels', offLevel);
  network(url => new Response(url.includes('.levels.bin') ? new Uint8Array(8) : valid(url)), metadata('levels'));
  assert.equal((await offLevel.fetchTile('0_0')).levels.byteLength, 8, 'correctly sized zero/off-level samples stay valid');
  const multiLevel = world(); prepare('levels', multiLevel);
  network(url => new Response(url.includes('.levels.bin') ? new Uint8Array(16) : valid(url)), { ...tile, structures: [...structures, { ...structures[0], level: -1, kind: 'tunnel' }] });
  assert.equal((await multiLevel.fetchTile('0_0')).levels.byteLength, 16, 'multiple level grids stay valid');

  for (const kind of Object.keys(payloads)) for (const compressedBody of [false, true]) {
    const w = world(); prepare(kind, w); w.index.gzip = true;
    network(url => new Response(compressedBody ? gzipSync(valid(url)) : valid(url)), metadata(kind));
    assert.equal((await w.fetchTile('0_0'))[kind].byteLength, payloads[kind].byteLength, `${kind}: gzip and HTTP-decoded variants`);
    const bad = malformed[kind][0], invalid = world(); prepare(kind, invalid); invalid.index.gzip = true;
    network(url => new Response(url.includes(`.${kind}.bin`) ? (compressedBody ? gzipSync(bad) : bad) : gzipSync(valid(url))), metadata(kind));
    await assert.rejects(invalid.fetchTile('0_0'), new RegExp(`invalid ${kind} data`), 'successful decompression does not validate a corrupt body');
  }
  const withoutTerrain = world(); delete withoutTerrain.index.terrain;
  network(() => { throw Error('metadata-absent binary was requested'); });
  const absent = await withoutTerrain.fetchTile('0_0');
  assert.equal(absent.height, null); assert.equal(absent.bare, null); assert.equal(absent.levels, null); assert.equal(absent.ipr, null);
  assert.equal(requests.length, 1, 'a legacy tile without terrain needs only JSON');
  const legacyIPR = world(); delete legacyIPR.index.terrain; legacyIPR.iprTiles.delete('0_0');
  network(url => new Response(url.includes('.ipr.bin') ? iprBytes(2, false) : valid(url)), { ...tile, ipr: {} });
  assert.equal((await legacyIPR.fetchTile('0_0')).ipr.byteLength, 50, 'JSON-only declaration/RGB-only IPR works without terrain metadata');
  const osm = world(); osm.osmBuildings = true; prepare('ipr', osm);
  network(url => { assert.ok(!url.includes('.ipr.bin')); return new Response(valid(url)); }, metadata('ipr'));
  assert.equal((await osm.fetchTile('0_0')).ipr, null, 'OSM mode suppresses advertised IPR');
  const explicitFalse = world();
  network(url => { assert.ok(!url.includes('.ipr.bin')); return new Response(valid(url)); }, metadata('ipr'));
  assert.equal((await explicitFalse.fetchTile('0_0')).ipr, null, 'explicit false IPR flag still suppresses JSON declaration');

  // fetchBinary itself remains optional for callers such as lamps.
  const { fetchBinary } = await server.ssrLoadModule('/src/terrain.ts');
  globalThis.fetch = async () => new Response(null, { status: 404 });
  assert.equal(await fetchBinary('fixture-lamps.bin.gz', true), null, 'optional lamp-style 404 remains null');

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

  const staleBody = world();
  let resolveOld;
  network(() => new Promise(resolve => { resolveOld = resolve; }));
  const corruptOld = staleBody.fetchTile('0_0');
  staleBody.pending.delete('0_0');
  network(url => new Response(valid(url)));
  const validReplacement = staleBody.fetchTile('0_0'); await validReplacement;
  const replacementJSON = staleBody.jsons.get('0_0');
  resolveOld(new Response(null, { status: 204 }));
  await assert.rejects(corruptOld, /invalid height data/);
  assert.equal(staleBody.pending.get('0_0'), validReplacement, 'late corrupt body cannot evict a valid replacement');
  assert.equal(staleBody.jsons.get('0_0'), replacementJSON, 'late corrupt body preserves replacement JSON');
  assert.equal(staleBody.retry.has('0_0'), false, 'late corrupt body cannot pause the replacement');

  // Run the existing bounded startup retry loop without wall-clock delays or rendering.
  const originalTimer = globalThis.setTimeout, originalWarn = console.warn;
  try {
    globalThis.setTimeout = done => { queueMicrotask(done); return 0; };
    let warnings = 0;
    console.warn = () => { warnings++; };
    for (const mode of ['status', 'empty-level']) for (const permanent of [false, true]) {
      const startup = world(); if (mode === 'empty-level') prepare('levels', startup); startup.around = () => ['0_0'];
      let downloads = 0, builds = 0;
      startup.dress = async () => {}; // (the meshes are another matter: this is about the downloads)
      startup.make = async (_key, files) => {
        builds++;
        assert.ok(files.height, 'startup never builds missing terrain');
        if (mode === 'empty-level') assert.equal(files.levels.byteLength, 8, 'startup never builds empty levels');
        startup.loaded.set('0_0', tile);
        return tile;
      };
      if (mode === 'status') network(() => (++downloads < 3 || permanent) ? new Response('unavailable', { status: 503 }) : new Response(bytes));
      else network(url => url.includes('.levels.bin')
        ? (++downloads < 3 || permanent) ? new Response(null, { status: 204 }) : new Response(valid(url))
        : new Response(valid(url)), metadata('levels'));
      await startup.loadNow(0, 0, 1);
      assert.equal(downloads, 3, 'startup keeps its existing three-attempt limit');
      assert.equal(builds, permanent ? 0 : 1);
      assert.equal(startup.loaded.has('0_0'), !permanent);
      if (permanent) {
        assert.equal(startup.pending.has('0_0'), false);
        assert.ok(startup.retry.has('0_0'));
      }
    }
    assert.equal(warnings, 2, 'persistent HTTP and corrupt-success failures remain reported after startup retries');
  } finally {
    globalThis.setTimeout = originalTimer;
    console.warn = originalWarn;
  }
  console.log(`Tile fetch passed: ${rejectedSuccesses} corrupt successful responses/recovery; terrain/IPR layouts and counts; legacy/optional omissions; gzip/decoded bodies; abort; obsolete-request isolation; bounded startup retries/reporting.`);
} finally {
  globalThis.fetch = originalFetch;
  await server.close();
}
