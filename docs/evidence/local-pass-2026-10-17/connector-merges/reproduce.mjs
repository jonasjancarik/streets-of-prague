#!/usr/bin/env node
// CPU-only evidence replay. No renderer, map rebuild, HTTP requests or production edits.
// From the repository root: node docs/evidence/local-pass-2026-10-17/connector-merges/reproduce.mjs
// From a temporary location: node repro.mjs --root /path/to/repo --prototype-source /path/to/candidate-v5.ts.txt
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const option = name => { const at = process.argv.indexOf(name); return at < 0 ? null : process.argv[at + 1]; };
const root = resolve(option('--root') ?? fileURLToPath(new URL('../../../../', import.meta.url)));
const baselineCommit = '22deab55a10fb8019c5a42b98e95399af921ee79';
const prototypeFile = option('--prototype-source') ?? fileURLToPath(new URL('candidate-v5.ts.txt', import.meta.url));
const sha = source => createHash('sha256').update(source).digest('hex');
const sources = {
  baseline: readFileSync(option('--baseline-source') ?? new URL('baseline-traffic.ts.txt', import.meta.url), 'utf8'),
  candidate: readFileSync(prototypeFile, 'utf8'),
};
const hashes = {
  baseline: 'f3843d7d1d66dc23541db590d534ff6f02bae076bbbceefc1e8a6f1bd6299510',
  candidate: '31fe647ba28b3cbc06b506b076c2fc277aa1a37c58fc95def7a73d9bc345f8b7',
};
for (const key of Object.keys(sources)) assert.equal(sha(sources[key]), hashes[key], `${key} source must match the recorded experiment`);
const metadata = JSON.parse(readFileSync(new URL('sources.json', import.meta.url), 'utf8'));
for (const [file, expected] of Object.entries(metadata.dependencies)) {
  assert.equal(sha(readFileSync(resolve(root, file))), expected, `${file} differs from the recorded experiment`);
}
const require = createRequire(resolve(root, 'package.json'));
const ts = require('typescript');
registerHooks({ load(url, context, next) {
  if (!url.startsWith('file:')) return next(url, context);
  const file = new URL(url);
  if (!file.pathname.endsWith('.ts')) return next(url, context);
  const variant = file.pathname.endsWith('/src/traffic.ts') ? file.searchParams.get('evidence') : null;
  const source = variant ? sources[variant] : readFileSync(file, 'utf8');
  return { format: 'module', shortCircuit: true, source: ts.transpileModule(source.replaceAll('import.meta.env', '({})'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText };
} });
globalThis.location = { search: '?lang=en' };
globalThis.self = globalThis;
globalThis.document = { getElementById: () => null, querySelectorAll: () => [], documentElement: { lang: 'en' } };
globalThis.localStorage = { getItem: () => null, setItem() {} };
globalThis.ProgressEvent = class extends Event { constructor(type, init) { super(type); Object.assign(this, init); } };
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  if (!String(input?.url ?? input).startsWith('data:')) throw new Error('This replay prohibits network requests');
  return originalFetch(input, init);
};
const moduleURL = file => pathToFileURL(resolve(root, file)).href;
const THREE = await import(moduleURL('node_modules/three/build/three.module.js'));
const { Car, loadCars } = await import(moduleURL('src/car.ts'));
const { DriveGraph, Route } = await import(moduleURL('src/network.ts'));
await loadCars('data:model/gltf-binary;base64,' + readFileSync(resolve(root, 'public/cars.glb')).toString('base64'));
const trafficTypes = {};
for (const variant of Object.keys(sources)) trafficTypes[variant] = (await import(moduleURL('src/traffic.ts') + '?evidence=' + variant)).Traffic;

const road = (id, u, v, pts, more = {}) => ({ id, u, v, pts, width: 12, lanes: 1, oneway: true, hw: 'residential', ...more });
const capturedRoads = [
  road('ch45412352_72492443>n289970128_181651168>0', 'h45412352_72492443', 'n289970128_181651168', [[-1836.67, 13824.55], [-1829.41, 13785.39], [-1819.65, 13740.49]], { lanes: null, oneway: false, hw: 'secondary' }),
  road('cn289970128_181651168>n289970060_181651556>0', 'n289970128_181651168', 'n289970060_181651556', [[-1819.65, 13740.49], [-1822.92, 13721.95]], { lanes: null, hw: 'secondary' }),
  road('cn289970280_181651536>n289970128_181651168>0', 'n289970280_181651536', 'n289970128_181651168', [[-1812.38, 13722.91], [-1819.65, 13740.49]], { lanes: null, hw: 'secondary' }),
];
const heldRoads = [
  road('straight', 'west', 'join', [[-50, 0], [0, 0]]),
  road('branch', 'north', 'join', [[0, 50], [0, 0]]),
  road('out', 'join', 'end', [[0, 0], [100, 0]]),
];
const bodyGap = (a, b) => Math.min(...a.circles().flatMap(([x, y]) => b.circles().map(([u, v]) => Math.hypot(x - u, y - v) - a.r - b.r)));
function replay(Type, name) {
  const held = name === 'held_connector_release';
  const graph = new DriveGraph(), edges = graph.add(held ? heldRoads : capturedRoads);
  const incoming = edges[0], outgoing = edges[held ? 2 : 1], branch = edges[held ? 1 : 2];
  const traffic = new Type(graph, new THREE.Scene(), () => 0.5, 0);
  function add(edge, s, speed, connector = false) {
    const route = new Route(graph, edge, s, () => 0.5);
    route.follow([outgoing]);
    if (connector) route.advance(route.leg.s1 - route.s + 1.5);
    const p = route.leg.path.at(route.s), car = new Car('suv', () => 0.5, p.x, p.y, p.ang);
    Object.assign(car, { mode: 'traffic', gz: 0, vx: Math.cos(p.ang) * speed, vy: Math.sin(p.ang) * speed });
    const agent = { car, route, speed, stuck: 0, jam: 0, off: 0, ignore: 0, cruise: 1 };
    traffic.agents.push(agent);
    return agent;
  }
  const lead = add(branch, 0, held ? 0 : 7.8, held), follower = add(incoming, held ? 10 : 61, held ? 8 : 3);
  const p = held ? lead.route.leg.path.at(lead.route.s + 3) : null;
  const person = p ? { x: p.x, y: p.y, z: 0, r: 0.35, vx: 0, vy: 0, kind: 'person' } : null;
  const initialGap = bodyGap(lead.car, follower.car);
  let minimumGap = initialGap, firstOverlap = null, firstIgnore = null;
  for (let frame = 0; frame < 3600; frame++) {
    const obstacles = traffic.agents.flatMap(a => a.car.circles().map(([x, y]) => ({ x, y, z: 0, r: a.car.r, vx: a.car.vx, vy: a.car.vy, kind: 'car', car: a.car })));
    if (person && frame / 60 < 3.5) obstacles.push(person);
    traffic.update(1 / 60, () => obstacles);
    if (follower.ignore > 0 && firstIgnore === null) firstIgnore = frame / 60;
    if (lead.gone || follower.gone) continue;
    const gap = bodyGap(lead.car, follower.car);
    minimumGap = Math.min(minimumGap, gap);
    if (gap < 0 && firstOverlap === null) firstOverlap = frame / 60;
  }
  return { name, initialGap, minimumGap, firstOverlapFrameSeconds: firstOverlap, firstIgnoreFrameSeconds: firstIgnore,
    person, personReleaseSeconds: held ? 3.5 : null,
    final: { leadGone: !!lead.gone, followerGone: !!follower.gone, leadJam: lead.jam, followerJam: follower.jam } };
}
const results = [];
for (const [variant, Type] of Object.entries(trafficTypes)) for (const name of ['captured_connector_merge', 'held_connector_release']) results.push({ variant, ...replay(Type, name) });
console.log(JSON.stringify({ baselineCommit, hashes, dt: 1 / 60, seconds: 60, type: 'suv', randomValue: 0.5, results }, null, 2));
