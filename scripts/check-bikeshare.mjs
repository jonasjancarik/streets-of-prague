#!/usr/bin/env node
// Shared-bike accounting and optional feed failures, without a map or renderer.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'vite';

globalThis.location = { search: '?lang=en' };
globalThis.localStorage = { getItem: () => null, setItem() {} };
globalThis.document = { querySelectorAll: () => [], documentElement: {} };
const server = await createServer({ configFile: false, optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false, ws: false } });
try {
  const { BikeShare } = await server.ssrLoadModule('/src/bikeshare.ts');
  const { Wallet } = await server.ssrLoadModule('/src/money.ts');
  const { rentalCost } = await server.ssrLoadModule('/src/pricing.ts');
  const WEEK = 7 * 86400;
  const minute = { plan_id: 'minute', name: 'Minute', currency: 'CZK', price: 0, per_min_pricing: [{ start: 0, interval: 1, rate: 1 }] };
  const system = (plans = [minute]) => ({ id: 'system', name: 'Bike', colour: '#f00', plans });
  const bike = (provider = 0, station = 'home') => ({ x: 0, y: 0, mode: 'player', burnt: false, share: { system: provider, station } });
  const wallet = money => new Wallet(new URLSearchParams(`money=${money}`));
  const world = loose => ({ loose, loaded: () => false });
  const data = (systems = [system()], stations = [[0, 0, 0, 4, 'home', 'Home']]) => ({ systems, stations });
  const share = async (feed = data()) => {
    globalThis.fetch = async () => ({ ok: true, json: async () => feed });
    const result = new BikeShare('fixture');
    await result.ready;
    return result;
  };
  const failures = [];
  let checked = 0;
  const check = async (name, run) => {
    try { await run(); checked++; }
    catch (error) { failures.push(`${name}: ${error.message}`); }
  };

  await check('rental elapsed time survives multiple weekly clock cycles', async () => {
    const rental = await share(), car = bike(), paid = wallet(100000);
    assert.ok(rental.rent(car, 0, n => paid.has(n)));
    for (const at of [0, WEEK - 60, 60, WEEK - 60, 60]) rental.charge(at, n => paid.take(n, 'bike'));
    assert.equal(rental.rental(car).paid, 2 * WEEK / 60 + 1);
    const done = rental.leave(car, 60);
    assert.equal(done.seconds, 2 * WEEK + 60);
    assert.equal(rental.done.length, 1);
    rental.charge(120, n => paid.take(n, 'bike'));
    assert.equal(done.paid, 20161, 'returning the bike stops further charges');
  });

  await check('ordinary Sunday/Monday rollover retains existing fare', async () => {
    const rental = await share(), car = bike(), paid = wallet(1000);
    assert.ok(rental.rent(car, WEEK - 600, n => paid.has(n)));
    rental.charge(WEEK - 600, n => paid.take(n, 'bike'));
    rental.charge(600, n => paid.take(n, 'bike'));
    assert.equal(rental.rental(car).paid, 20);
    assert.equal(rental.leave(car, 600).seconds, 1200);
  });

  await check('production cleanup settles final fare before removing rental', async () => {
    const source = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
    const marker = '      parkTwoWheelers(true);';
    const begin = source.indexOf(marker) + marker.length;
    const end = source.indexOf('      for (const { rental, fee }', begin);
    assert.ok(begin >= marker.length && end > begin, 'production bike maintenance block exists');
    const step = new Function('bikeShare', 'wallet', 'clock', 'px', 'py', 'bikeWorld', source.slice(begin, end));
    const rental = await share(), car = bike(), paid = wallet(1000);
    rental.rent(car, 0, n => paid.has(n));
    rental.charge(0, n => paid.take(n, 'bike'));
    car.mode = 'loose'; car.x = 700;
    step(rental, paid, { t: 61 }, () => 0, () => 0, world([]));
    assert.equal(rental.done[0].paid, 2, 'a removed or teleported-away bike pays its last interval');
    assert.equal(paid.balance, 998);
    assert.equal(rental.done[0].seconds, 61);
    assert.equal(rental.abandon(0, 0, 61)[0].fee, 500);
    assert.equal(rental.abandon(0, 0, 61).length, 0, 'cleanup reports the fee once');
  });

  await check('provider-scoped station IDs keep both stocks correct', async () => {
    const rental = await share(data([system(), system()], [[0, 0, 0, 4, 'same', 'First'], [100, 0, 1, 4, 'same', 'Second']]));
    const car = bike(1, 'same'), before = rental.stations.map(st => st.left);
    car.x = 100;
    assert.ok(rental.rent(car, 0, () => true));
    assert.deepEqual(rental.stations.map(st => st.left), [before[0], before[1] - 1]);
    rental.charge(60, n => n);
    assert.equal(rental.leave(car, 60).to, 'same');
    assert.deepEqual(rental.stations.map(st => st.left), before);
  });

  await check('parking away from own station keeps rental until return or abandonment', async () => {
    const rental = await share(data([system(), system()], [[0, 0, 0, 4, 'home', 'Home'], [100, 0, 1, 4, 'other', 'Other']]));
    const car = bike(), paid = wallet(1000);
    rental.rent(car, 0, n => paid.has(n));
    car.x = 100; car.mode = 'loose';
    rental.charge(61, n => paid.take(n, 'bike'));
    assert.equal(rental.leave(car, 61), null, 'another provider cannot end this rental');
    assert.ok(rental.rental(car));
    assert.equal(rental.abandon(100, 0, 61).length, 0, 'nearby parked rental stays active');
    car.x = 3200;
    const abandoned = rental.abandon(0, 0, 61);
    assert.equal(abandoned[0].fee, 1000);
    assert.equal(rental.rental(car), undefined);
    assert.equal(rental.abandon(0, 0, 61).length, 0);
  });

  await check('depleted wallet retains current partial-payment rules', async () => {
    const rental = await share(), car = bike(), paid = wallet(1);
    assert.ok(rental.rent(car, 0, n => paid.has(n)));
    rental.charge(0, n => paid.take(n, 'bike'));
    rental.charge(120, n => paid.take(n, 'bike'));
    assert.equal(paid.balance, 0);
    assert.equal(rental.rental(car).paid, 1);
    assert.equal(rental.leave(car, 120).paid, 1, 'return records only the amount actually paid');
    assert.equal(rental.rent(bike(), 120, n => paid.has(n)), false);
  });

  await check('missing pricing plan preserves explicitly free fallback', async () => {
    const rental = await share(data([system([])])), car = bike(), paid = wallet(0);
    assert.equal(rentalCost(undefined, 10), 0);
    assert.ok(rental.rent(car, 0, n => paid.has(n)));
    rental.charge(600, n => paid.take(n, 'bike'));
    assert.equal(paid.balance, 0);
    assert.equal(rental.leave(car, 600).paid, 0);
  });

  await check('unknown providers are absent before bike stock or rental offers', async () => {
    const rental = await share(data([system()], [[0, 0, 99, 4, 'bad', 'Bad'], [0, 0, 0, 4, 'home', 'Home']]));
    assert.equal(rental.stations.length, 1);
    assert.equal(rental.rent(bike(99), 0, () => true), false);
    assert.doesNotThrow(() => rental.charge(60, n => n));
  });

  await check('malformed provided pricing never reaches the wallet', async () => {
    const invalid = [null, { ...minute, price: -1 }, { ...minute, price: NaN }, { ...minute, price: Infinity },
      { ...minute, price: '20' }, { ...minute, per_min_pricing: {} },
      ...['start', 'interval', 'rate', 'end'].flatMap(field => [-1, NaN, Infinity, '10'].map(value => ({ ...minute, per_min_pricing: [{ start: 0, interval: 1, rate: 1, [field]: value }] })))];
    for (const plan of invalid) {
      assert.equal(Number.isFinite(rentalCost(plan, 1)), false, JSON.stringify(plan));
      const rental = await share(data([system([plan])])), paid = wallet(1000);
      assert.equal(rental.stations.length, 0, 'unsafe provided plan does not offer bikes');
      assert.equal(rental.rent(bike(), 0, n => paid.has(n)), false);
      assert.doesNotThrow(() => rental.charge(60, n => paid.take(n, 'bike')));
      assert.equal(paid.balance, 1000);
    }
  });

  await check('current valid feed prices are unchanged', async () => {
    const feed = JSON.parse(await readFile(new URL('../public/data/praha_now/bikes.json', import.meta.url), 'utf8'));
    const [standard, alternate] = feed.systems[0].plans;
    const [perMinute] = feed.systems[1].plans;
    assert.deepEqual([0, 30, 31, 360, 361, 1440, 1441].map(t => rentalCost(standard, t)), [39, 39, 78, 468, 500, 500, 539]);
    assert.deepEqual([0, 420, 421, 1440, 1441].map(t => rentalCost(alternate, t)), [35, 490, 500, 500, 535]);
    assert.deepEqual([0, 1, 1.01, 60].map(t => rentalCost(perMinute, t)), [1, 1, 2, 60]);
  });

  assert.equal(failures.length, 0, failures.join('\n'));
  console.log(`Bikeshare: ${checked} accounting, cleanup, malformed-feed and fare-preservation checks passed.`);
} finally { await server.close(); }
