#!/usr/bin/env node
// Browser regression checks for retained car pages. Run against a dev server:
// node scripts/check-car-pool.mjs --url http://localhost:5238/ --case all
import { spawnSync } from 'node:child_process';

const option = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? fallback : process.argv[i + 1];
};
const url = option('--url', 'http://localhost:5191/');
const selected = option('--case', 'all');
if (!['prepare', 'capacity', 'render', 'all'].includes(selected)) {
  console.error('Use --case prepare|capacity|render|all');
  process.exit(2);
}

const checks = `(async () => {
  const d = window.__drive, pool = d.carPool, r = d.renderer;
  const { Car, ordinaryCarBodies, COURIER_BOXES } = await import('/src/car.ts');
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  const page = (key) => pool.meshes.get(key)?.[0];
  const keyOf = ({type, paint, box}) => box ? type + '|' + paint + '|' + box : type + '|' + paint;
  const report = [];
  if (${selected === 'all' || selected === 'prepare'}) {
    let rngCalls = 0;
    const rng = () => { rngCalls++; return .5; };
    new Car('hatch', rng);
    const initialCalls = rngCalls;
    // The explicit inventory is independent of the game's RNG; the counter also
    // guards future changes to this preparation path.
    const bodies = ordinaryCarBodies(['#123456']);
    const keys = bodies.map(keyOf);
    assert(new Set(keys).size === keys.length, 'inventory keys unique');
    assert(keys.includes('hatch|#e8e6e1') && keys.includes('bus|#c8102e'), 'ordinary and fixed colours');
    assert(keys.includes('bike|#123456') && keys.includes('moto|#e07b1f'), 'bike and custom colours');
    assert(COURIER_BOXES.every(box => keys.includes('bike|#123456|' + box)), 'all courier boxes');
    const before = new Map([...pool.meshes].map(([k, pages]) => [k, pages.map(m => [m.uuid, m.instanceMatrix, m.instanceMatrix.count])]));
    pool.prepare(bodies);
    assert(pool.meshes.get('taxi|#e9c62f').length === 2 && pool.meshes.get('hatch|#bfc3c7').length === 2, 'measured dense keys reserve a second page');
    const first = new Map([...pool.meshes].map(([k, pages]) => [k, pages.map(m => [m.uuid, m.instanceMatrix, m.instanceMatrix.count])]));
    pool.prepare(bodies);
    assert(pool.meshes.size === first.size && keys.every(k => pool.prepared.has(k)), 'stable prepared keys');
    for (const [k, pages] of first) {
      const now = pool.meshes.get(k);
      assert(now.length === pages.length && now.every((m, i) => m.uuid === pages[i][0] && m.instanceMatrix === pages[i][1] && m.instanceMatrix.count === pages[i][2]), k + ': page identity and capacity');
      if (before.has(k)) assert(now[0].uuid === before.get(k)[0][0], k + ': original page retained');
    }
    assert(rngCalls === initialCalls, 'preparation advanced RNG');
    const retainedPages = [...pool.meshes.values()].reduce((n, pages) => n + pages.length, 0);
    report.push('prepare: ' + keys.length + ' explicit keys, ' + pool.meshes.size + ' retained keys / ' + retainedPages + ' pages, additional RNG calls ' + (rngCalls - initialCalls));
  }
  if (${selected === 'all' || selected === 'capacity'}) {
    pool.prepare([{type:'hatch', paint:'#010203'}]);
    const make = (n) => Array.from({length:n}, (_, i) => new Car('hatch', () => .01, 10000 + i, 0, 0, '#010203'));
    const cars = make(pool.constructor.pageCapacity * 2 + 3), key = cars[0].key;
    const old = page(key), uuid = old.uuid, buffer = old.instanceMatrix;
    const beforeOverflow = pool.overflowPages;
    pool.render(cars);
    let pages = pool.meshes.get(key);
    assert(pages.length >= 3 && pages[0] === old && old.uuid === uuid && old.instanceMatrix === buffer, 'primary page retained on overflow');
    assert(pages.every(m => m.castShadow && m.customDepthMaterial && !m.frustumCulled), 'page shadow and visibility settings');
    assert(pages.reduce((n, m) => n + m.count, 0) === cars.length, 'all cars present across pages');
    for (let i = 0; i < cars.length; i++) {
      const m = pages[Math.floor(i / pool.constructor.pageCapacity)];
      const matrix = m.instanceMatrix.array;
      assert(Math.abs(matrix[(i % pool.constructor.pageCapacity) * 16 + 12] - cars[i].x) < .01, 'unique car matrix ' + i);
    }
    assert(pool.overflowPages >= beforeOverflow + 2, 'overflow counted');
    const ids = pages.map(m => [m.uuid, m.instanceMatrix]);
    pool.render([]);
    assert([...pool.meshes.values()].every(group => group.every(m => m.count === 0 && !m.visible)), 'empty pages do not draw stale cars');
    pool.render(cars.slice(0, 1));
    assert(pages[0].count === 1 && pages[0].visible && pages.slice(1).every(m => m.count === 0 && !m.visible), 'shrunken pages empty');
    pool.render(cars);
    pages = pool.meshes.get(key);
    assert(pages.length === ids.length && pages.every((m, i) => m.uuid === ids[i][0] && m.instanceMatrix === ids[i][1]), 'overflow pages reused');
    const custom = new Car('bike', () => .2, 0, 0, 0, '#abcdef');
    const burnt = new Car('hatch', () => .2); burnt.burn();
    const beforeLate = pool.latePages;
    const expectedLate = Number(!pool.meshes.has(custom.key)) + Number(!pool.meshes.has(burnt.key));
    pool.render([custom, burnt]);
    assert(page(custom.key)?.count === 1 && page(burnt.key)?.count === 1, 'late custom and burnt bodies render');
    assert(pool.latePages === beforeLate + expectedLate, 'late variants counted');
    const buses = Array.from({length:18}, (_, i) => {
      const bus = new Car('bus', () => .2, 20000 + i, 0);
      bus.line = {ref:'12', to:'Test'};
      return bus;
    });
    pool.render(buses);
    assert(pool.meshes.get(buses[0].key).reduce((n, m) => n + m.count, 0) === 18, 'buses span pages');
    assert(pool.boards.filter(b => b.visible).length === 54, 'board index continues across pages');
    const bikes = Array.from({length:19}, (_, i) => {
      const bike = new Car('bike', () => .2, 30000 + i, 0, 0, '#123456');
      bike.rider = {shirt:'#224466', trousers:'#333333', skin:'#bb8866', hair:'#222222', sleeves:true};
      return bike;
    });
    pool.render(bikes, null, 1 / 60);
    assert(pool.riders.mesh.count === bikes.length, 'rider index continues across pages');
    pool.render([]);
    assert(pool.boards.every(b => !b.visible) && pool.riders.mesh.count === 0, 'riders and boards reset');
    report.push('capacity: ' + cars.length + ' cars, ' + ids.length + ' pages retained, riders and boards span pages, late variants render');
  }
  if (${selected === 'all' || selected === 'render'}) {
    const idle = [...pool.prepared].find(k => !k.includes('|#123456') && !pool.groups.has(k) && page(k)?.count === 0 && k.startsWith('hatch|'));
    assert(idle, 'an idle prepared hatch page exists');
    const mesh = page(idle), uuid = mesh.uuid, buffer = mesh.instanceMatrix;
    const reserved = pool.meshes.get('taxi|#e9c62f')[1], reservedUuid = reserved.uuid, reservedBuffer = reserved.instanceMatrix;
    assert(mesh.count === 0 && !mesh.visible && [0,5,10,15].every(i => buffer.array[i] === 1), 'warm instance restored after loading');
    const nodes = r._nodes, cache = nodes?.nodeBuilderCache;
    let fresh = 0;
    if (cache) {
      const get = nodes.getForRender;
      nodes.getForRender = function(ro, async) {
        const before = cache.size, result = get.call(this, ro, async);
        if ((ro.object === mesh || ro.object === reserved) && cache.size > before) fresh++;
        return result;
      };
      try {
        const [type, paint] = idle.split('|');
        pool.render([new Car(type, () => .1, 0, 0, 0, paint)]);
        r.render(d.scene, d.camera);
        pool.render(Array.from({length:17}, (_, i) => new Car('taxi', () => .1, i, 0)));
        assert(reserved.count === 1 && reserved.visible, 'reserved page used');
        r.render(d.scene, d.camera);
      } finally { nodes.getForRender = get; pool.render([]); }
      assert(fresh === 0, 'first visible prepared page built ' + fresh + ' new body shader state(s)');
    }
    assert(mesh.uuid === uuid && mesh.instanceMatrix === buffer && mesh.count === 0 && !mesh.visible, 'render retained page and restored count');
    assert(reserved.uuid === reservedUuid && reserved.instanceMatrix === reservedBuffer && reserved.count === 0 && !reserved.visible, 'reserved page retained and reset');
    report.push('render: prepared page retained; new builder states ' + fresh + '; ' + (r.backend?.isWebGPUBackend ? 'WebGPU' : 'WebGL'));
  }
  return report.join('\\n');
})()`;

for (const extra of selected === 'render' || selected === 'all' ? ['', '&renderer=webgl&dev'] : ['']) {
  const args = ['scripts/bench.mjs', '--url', url, '--scenes', 'stand', '--seconds', '1', '--dpr', '1', '--graphics', 'high', '--time', '14:00', '--weather', 'clear', '--fresh-browser', '--loading-frames', '--extra', extra, '--eval', checks, '--stack'];
  if (!extra) args.push('--require-webgpu');
  const run = spawnSync(process.execPath, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  process.stdout.write(run.stdout || '');
  process.stderr.write(run.stderr || '');
  if (run.status !== 0 || /console:|page error:/.test(run.stderr || '')) process.exit(run.status || 1);
}
