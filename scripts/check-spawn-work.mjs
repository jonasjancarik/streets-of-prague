#!/usr/bin/env node
// Deterministic browser checks for the old spawn selection arithmetic and the
// pass-local replacements. Vite imports the TypeScript modules under test.
import { createRequire } from 'node:module';
import { checkIn } from './game-lock.mjs';

const option = (name, fallback) => {
  const at = process.argv.indexOf(name);
  return at < 0 ? fallback : process.argv[at + 1];
};
const url = option('--url', 'http://localhost:5241/');
const selected = option('--case', 'all');
if (!['all', 'people', 'traffic', 'pavement'].includes(selected)) throw new Error(`Unknown case: ${selected}`);

const check = `(async () => {
  const { preparePeople, pickPerson, prepareTraffic, pickTraffic } = await import('/src/spawn.ts');
  const { Traffic } = await import('/src/traffic.ts');
  const assert = (ok, label) => { if (!ok) throw Error(label); };
  const same = (a, b, label) => assert(JSON.stringify(a) === JSON.stringify(b), label + ': ' + JSON.stringify(a) + ' vs ' + JSON.stringify(b));
  const random = (values) => {
    let i = 0;
    return { next: () => values[i++ % values.length], count: () => i };
  };
  const edge = (id, length, pull = 1, hw = 'residential') => ({ id, hw, pull, path: { length, at: (s) => ({ x: s, y: id.charCodeAt(0), ang: 0 }) } });
  const peopleOld = (edges, r, ok) => {
    let total = 0;
    const upTo = edges.map((e) => (total += e.path.length * e.pull));
    if (!edges.length) return null;
    for (let t = 0; t < 8; t++) {
      const x = r() * total;
      let lo = 0, hi = upTo.length - 1;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (upTo[mid] < x) lo = mid + 1; else hi = mid; }
      const e = edges[lo], s = r() * e.path.length, at = e.path.at(s);
      if (!ok || ok(at.x, at.y)) return { e: e.id, s };
    }
    return null;
  };
  const trafficOld = (edges, r, ordinary) => {
    if (!edges.length) return null;
    const weight = (e) => e.path.length * (ordinary ? e.pull : 1);
    const total = edges.reduce((a, e) => a + weight(e), 0);
    let x = r() * total, chosen = edges[0];
    for (const e of edges) if ((x -= weight(e)) < 0) { chosen = e; break; }
    return chosen;
  };
  const result = [];
  if ('${selected}' === 'all' || '${selected}' === 'people') {
    const lists = [[], [edge('a', 20)], [edge('a', 10), edge('b', 40, 2), edge('c', 30, 0.4)]];
    let fixtures = 0, weightCalls = 0;
    for (const edges of lists) {
      const weights = edges.map((e) => e.path.length * e.pull), total = weights.reduce((a, b) => a + b, 0);
      const values = [[0, 0], [0.1, 0.25], [weights[0] / total || 0, 1], [(weights[0] + (weights[1] || 0)) / total || 0, 0.3], [1, 0.5], [0.9999999999999999, 0.7]];
      for (const draws of values) for (const reject of [0, 2, 8]) {
      const a = random(draws), b = random(draws);
      let ia = 0, ib = 0;
      const old = peopleOld(edges, a.next, reject ? () => ia++ >= reject : null);
      const sampler = preparePeople(edges, (e) => { weightCalls++; return e.path.length * e.pull; });
      const got = pickPerson(sampler, b.next, reject ? () => ib++ >= reject : null);
      same(old, got && { e: got.e.id, s: got.s }, 'person selection');
      same([a.count(), ia], [b.count(), ib], 'person random/rejections');
      fixtures++;
    }
    }
    const edges = lists[2], sampler = preparePeople(edges, (e) => { weightCalls++; return e.path.length * e.pull; });
    for (let n = 0; n < 6; n++) pickPerson(sampler, random([0.6, 0.4]).next, null);
    assert(weightCalls === 18 * 4 + 3, 'people weights once per prepared list');
    result.push('people ' + fixtures + ' selections; 6 picks reused 3 weights');
  }
  if ('${selected}' === 'all' || '${selected}' === 'traffic') {
    const lists = [[], [edge('a', 20)], [edge('a', 20, 0.1), edge('b', 40, 2), edge('c', 25, 0.5)], [edge('a', 1), edge('b', 2), edge('c', 3)]];
    let fixtures = 0;
    for (const edges of lists) for (const ordinary of [true, false]) {
      const weights = edges.map((e) => e.path.length * (ordinary ? e.pull : 1)), total = weights.reduce((a, b) => a + b, 0);
      for (const values of [[0], [0.5], [1], [0.9999999999999999], [weights[0] / total || 0], [(weights[0] + (weights[1] || 0)) / total || 0], [0.1 + Number.EPSILON]]) {
      let calls = 0;
      const sampler = prepareTraffic(edges, (e) => { calls++; return e.path.length * (ordinary ? e.pull : 1); }, ordinary);
      assert(calls === edges.length, 'traffic weights once');
      const a = random(values), b = random(values);
      const old = trafficOld(edges, a.next, ordinary), got = pickTraffic(sampler, b.next);
      same(old?.id, got?.id, 'traffic selection');
      same(a.count(), b.count(), 'traffic random calls');
      fixtures++;
    }
    }
    // Successive spawns must test occupancy against cars added by earlier picks.
    for (const ordinary of [true, false]) for (const rejects of [0, 2, 40]) {
      const edges = lists[2], a = random([0.68, 0.5, 0.34, 0.8]), b = random([0.68, 0.5, 0.34, 0.8]);
      const sampler = prepareTraffic(edges, (e) => e.path.length * (ordinary ? e.pull : 1), ordinary);
      const run = (pick, r) => {
        const cars = [], out = [];
        for (let n = 0; n < 3; n++) {
          let found = null;
          for (let t = 0; t < 40; t++) {
            const e = pick(r); if (!e || e.path.length < 12) continue;
            const s = 4 + r() * (e.path.length - 8), p = e.path.at(s);
            if (t < rejects || cars.some((car) => car.id === e.id && Math.abs(car.s - s) < 12)) continue;
            found = { id: e.id, s }; cars.push(found); break;
          }
          out.push(found);
        }
        return out;
      };
      const old = run((r) => trafficOld(edges, r, ordinary), a.next);
      const got = run((r) => pickTraffic(sampler, r), b.next);
      same(old, got, 'traffic successive attempts');
      same(a.count(), b.count(), 'traffic successive RNG');
    }
    const changed = [edge('z', 17, 5)];
    same(pickTraffic(prepareTraffic(changed, (e) => e.path.length * e.pull, true), random([0.4]).next)?.id, 'z', 'candidate list change');
    // Exercise Traffic.spawn itself through all 40 failed attempts, without
    // constructing a vehicle: the rejection happens before that point.
    const busEdges = [edge('a', 20), edge('b', 40)], a = random([0.8, 0.3]), b = random([0.8, 0.3]);
    const oldAttempts = () => {
      for (let t = 0; t < 40; t++) {
        const e = trafficOld(busEdges, a.next, false);
        e.path.at(4 + a.next() * (e.path.length - 8));
      }
      return null;
    };
    const instance = Object.create(Traffic.prototype);
    instance.g = { edges: busEdges }; instance.agents = []; instance.r = b.next;
    const prepared = instance.prepareSpawn(busEdges, 'bus');
    same(oldAttempts(), instance.spawn(() => false, busEdges, 'bus', prepared), 'actual bus rejection');
    same(a.count(), b.count(), 'actual traffic RNG after 40 rejections');
    assert(a.count() === 80, 'bus rejection consumes 80 draws');
    let wrongMode = false;
    try { instance.spawn(() => false, busEdges, null, prepared); } catch { wrongMode = true; }
    assert(wrongMode, 'reject a sampler prepared for another weight mode');
    result.push('traffic ' + fixtures + ' selectors, successive/40-attempt cases');
  }
  if ('${selected}' === 'all' || '${selected}' === 'pavement') {
    const traffic = Object.create(Traffic.prototype);
    traffic.agents = [];
    traffic.kerbAgents = [];
    let visits = 0;
    const compare = () => {
      traffic.gatherPavementCars();
      for (const [x, y, d] of [[0, 0, 12], [12, 0, 12], [30, 30, 5]]) {
        const old = traffic.agents.some((a) => { visits++; return a.kerb && Math.abs(a.car.x - x) < d && Math.abs(a.car.y - y) < d; });
        same(old, traffic.pavementNear(x, y, d), 'pavement query');
      }
    };
    compare(); // K = 0
    const on = { car: { x: 0, y: 0 }, kerb: { left: 10 } };
    const off = { car: { x: 20, y: 0 } };
    traffic.agents.push(on, off); compare(); // adopt
    on.car.x = 10; compare(); // next substep reads live coordinates
    delete on.kerb; compare(); // kerb completion
    on.kerb = { left: 1 }; compare();
    traffic.release(on); compare(); // release
    assert(traffic.kerbAgents.length === 0, 'no stale kerb agents');
    result.push('pavement adopt/release/kerb-completion/substep; reference visits ' + visits);
  }
  return 'Spawn checks passed: ' + result.join('; ');
})()`;

const require = createRequire(import.meta.url);
let playwright;
try { playwright = require(process.env.PLAYWRIGHT_PATH || 'playwright'); }
catch { playwright = require(`${process.env.HOME}/projects/micromachines-clone/node_modules/playwright`); }
await (await checkIn('game')).take(); // not while another session benchmarks
const browser = await playwright.chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.stack || error.message));
  // A Vite module URL gives the browser the game's origin without loading the
  // whole renderer/map. The fixtures import the actual TypeScript source below.
  await page.goto(new URL('/src/spawn.ts', url).href);
  console.log(await page.evaluate(check));
  if (errors.length) throw new Error(errors.join('\n'));
} finally { await browser.close(); }
