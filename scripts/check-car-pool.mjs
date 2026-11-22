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
const baseline = option('--baseline', '');
if (!['prepare', 'capacity', 'render', 'all'].includes(selected)) {
  console.error('Use --case prepare|capacity|render|all');
  process.exit(2);
}

const checks = `(async () => {
  const d = window.__drive, pool = d.carPool, r = d.renderer;
  const loadedModule = (path) => performance.getEntriesByType('resource').filter(e => new URL(e.name).pathname === path).at(-1)?.name || path;
  const { Car, ordinaryCarBodies, COURIER_BOXES, WHEEL_LEVEL } = await import(loadedModule('/src/car.ts'));
  const THREE = await import(loadedModule('/node_modules/.vite/deps/three.js'));
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  const page = (key) => pool.meshes.get(key)?.[0];
  const keyOf = ({type, box}) => box ? type + '|box:' + box : type;
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
    assert(keys.includes('hatch') && keys.includes('bus'), 'ordinary and fixed colours');
    assert(keys.includes('bike') && keys.includes('moto') && keys.length === ordinaryCarBodies().length, 'bike and custom colours');
    assert(COURIER_BOXES.every(box => keys.includes('bike|box:' + box)), 'all courier boxes');
    const before = new Map([...pool.meshes].map(([k, pages]) => [k, pages.map(m => [m.uuid, m.instanceMatrix, m.instanceMatrix.count])]));
    pool.prepare(bodies);
    assert(pool.meshes.get('taxi').length === 1 && pool.meshes.get('hatch').length === 1 && page('hatch').instanceMatrix.count === 128, 'measured peaks fit one page per type');
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
    pool.prepare([{type:'hatch'}]);
    const make = (n) => Array.from({length:n}, (_, i) => new Car('hatch', () => .01, 10000 + i, 0, 0, i % 2 ? '#010203' : '#c0ffee'));
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
      const paint = m.geometry.getAttribute('paint'), colour = new THREE.Color(cars[i].paint), slot = i % pool.constructor.pageCapacity;
      assert(Math.abs(paint.getX(slot) - colour.r) < 1e-7 && Math.abs(paint.getY(slot) - colour.g) < 1e-7 && Math.abs(paint.getZ(slot) - colour.b) < 1e-7, 'linear paint ' + i);
      assert(m.instanceColor === null, 'fixed parts must not use instanceColor');
      assert(paint.updateRanges.length === 1 && paint.updateRanges[0].count === m.count * paint.itemSize, 'active paint upload range');
    }
    assert(pool.overflowPages >= beforeOverflow + 2, 'overflow counted');
    assert(pages[0].geometry !== pages[1].geometry && pages[0].geometry.getAttribute('paint') !== pages[1].geometry.getAttribute('paint'), 'pages own independent paint buffers');
    assert(pages[0].geometry.getAttribute('position') === pages[1].geometry.getAttribute('position'), 'body vertices shared across pages');
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
    const buses = Array.from({length:pool.constructor.pageCapacity + 1}, (_, i) => {
      const bus = new Car('bus', () => .2, 20000 + i, 0);
      bus.line = {ref:'12', to:'Test'};
      return bus;
    });
    pool.render(buses);
    assert(pool.meshes.get(buses[0].key).reduce((n, m) => n + m.count, 0) === buses.length, 'buses span pages');
    assert(pool.boards.filter(b => b.visible).length === buses.length * 3, 'board index continues across pages');
    const bikes = Array.from({length:pool.constructor.pageCapacity + 3}, (_, i) => {
      const bike = new Car('bike', () => .2, 30000 + i, 0, 0, '#123456');
      if (i >= pool.constructor.pageCapacity - 3) bike.rider = {shirt:'#224466', trousers:'#333333', skin:'#bb8866', hair:'#222222', sleeves:true};
      return bike;
    });
    pool.render(bikes, null, 1 / 60);
    assert(pool.riders.mesh.count === 6, 'rider index continues across pages');
    pool.render([]);
    assert(pool.boards.every(b => !b.visible) && pool.riders.mesh.count === 0, 'riders and boards reset');
    report.push('capacity: ' + cars.length + ' cars, ' + ids.length + ' pages retained, riders and boards span pages, late variants render');
  }
  if (${selected === 'all' || selected === 'render'}) {
    const idle = 'fire';
    const mesh = page(idle), uuid = mesh.uuid, buffer = mesh.instanceMatrix;
    const reserved = page('bike|box:' + COURIER_BOXES[0]), reservedUuid = reserved.uuid, reservedBuffer = reserved.instanceMatrix;
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
        pool.render([new Car(idle, () => .1, 0, 0, 0)]);
        r.render(d.scene, d.camera);
        pool.render([new Car('bike', () => .1, 0, 0, 0, '#123456', COURIER_BOXES[0])]);
        assert(reserved.count === 1 && reserved.visible, 'reserved page used');
        r.render(d.scene, d.camera);
      } finally { nodes.getForRender = get; pool.render([]); }
      assert(fresh === 0, 'first visible prepared page built ' + fresh + ' new body shader state(s)');
    }
    assert(mesh.uuid === uuid && mesh.instanceMatrix === buffer && mesh.count === 0 && !mesh.visible, 'render retained page and restored count');
    assert(reserved.uuid === reservedUuid && reserved.instanceMatrix === reservedBuffer && reserved.count === 0 && !reserved.visible, 'reserved page retained and reset');
    const saloon = new Car('sedan', () => .3, 3, 0), distant = new Car('sedan', () => .3, 60, 0);
    const eye = { x: 0, z: 0 };
    const heroKey = 'sedan|coachwork|street-wheels';
    assert(!page(heroKey), 'overhead preparation creates no hero sedan page');
    const wheels = page('sedan|street-wheels');
    pool.render([saloon, distant], null, 0, undefined, true, eye);
    assert(wheels.count === 1 && page('sedan').count === 1, 'only nearby street cars use the fitted wheels');
    const roll = wheels.geometry.getAttribute('roll'), phase = [roll.getX(0), roll.getY(0)], registration = roll.getW(0);
    saloon.x += .31; saloon.vx = 3; saloon.w = .4;
    pool.render([saloon,distant], null, 0, undefined, true, eye);
    assert(Math.hypot(phase[0]-roll.getX(0),phase[1]-roll.getY(0)) > .5 && Math.abs(roll.getZ(0)) > .1,
      'wheels roll with travel and the front axle steers through the bend');
    assert(roll.getW(0) === registration && registration >= 100000 && registration <= 999999,
      'a moving car keeps its registration');
    const panes = wheels.geometry.groups;
    assert(panes.length === 2 && panes[0].count + panes[1].count === wheels.geometry.index.count &&
      wheels.material[1].transparent && !wheels.material[1].depthWrite, 'street car has separate glazing');
    const driversShown = () => [...pool.drivers.meshes()].reduce((n,m) => n+m.count, 0);
    assert(driversShown() === 0 && !performance.getEntriesByType('resource').some(e => e.name.endsWith('/car-drivers.glb')),
      'parked cars do not request the seated avatars');
    saloon.mode = 'traffic';
    const until = performance.now()+15000;
    do {
      pool.render([saloon,distant], null, 0, undefined, true, eye);
      if (driversShown()) break;
      await new Promise(requestAnimationFrame);
    } while (performance.now()<until);
    assert(driversShown() === 1 && page('sedan').count === 1, 'only the occupied near car draws a driver');
    saloon.mode = 'loose';
    pool.render([saloon,distant],null,0,undefined,true,eye);
    assert(!driversShown(), 'driver leaves with the occupant');
    const heroDeadline = performance.now() + 15000;
    while (!page(heroKey)?.count && performance.now() < heroDeadline) {
      await new Promise(requestAnimationFrame);
      pool.render([saloon,distant],null,0,undefined,true,eye);
    }
    const hero = page(heroKey);
    assert(hero?.count === 1 && wheels.count === 0 && page('sedan').count === 1, 'loaded coachwork replaces only the close sedan');
    assert(hero.geometry.groups.length === 2 && hero.material[0].isMeshPhysicalMaterial &&
      hero.material[1].transparent && !hero.material[1].depthWrite, 'baked coachwork and clear panes use two draws');
    const heroRoll = hero.geometry.getAttribute('roll'), hinges = hero.geometry.getAttribute('hinge');
    assert(heroRoll.getW(0) === registration, 'model swap preserves registration');
    assert(saloon.streetHeadlights?.forward > 2 && saloon.streetHeadlights?.height > .6 &&
      !distant.streetHeadlights,'near beams are fitted to the exported projector');
    const tags = new Set(Array.from({length:hinges.count},(_,i)=>hinges.getZ(i)));
    assert([1,2,3,4,14,15,16].every(tag=>tags.has(tag)) && [...tags].some(tag=>tag < -2), 'four hinged doors, instruments, cloth, and steering calipers');
    saloon.mode='traffic';saloon.vx=12;
    pool.render([saloon],null,0,undefined,true,eye);
    assert(Math.abs(Math.hypot(heroRoll.getX(0),heroRoll.getY(0)) - (2+12*3.6/240))<.001, 'speedometer receives road speed');
    saloon.mode='loose';pool.render([saloon],null,0,undefined,true,eye);
    let samples = 0;
    const kerb = (x,y) => { samples++; return x>saloon.x && y>saloon.y ? .10 : 0; };
    pool.render([saloon],kerb,0,1,true,eye);
    const stance = new THREE.Matrix4();
    pool.matrixOf(saloon,stance);
    const twist = Math.floor((heroRoll.getZ(0)+1)/2)*.0025;
    for (const x of [1.48,-1.50]) for(const z of [-.765,.765]){
      const tyre = new THREE.Vector3(x,Math.sign(-x*z)*twist,z).applyMatrix4(stance);
      const pavement = x>0 && z<0 ? .10 : 0;
      assert(Math.abs(tyre.y-pavement)<.002,'individual tyre stays on the kerb or carriageway');
    }
    pool.render([saloon],kerb,0,1,true,eye);
    assert(samples===4,'a parked hero reuses its four contact samples');
    const placed = new THREE.Matrix4();
    assert(pool.matrixOf(saloon, placed) && Math.abs(placed.elements[12]-saloon.x) < .001, 'close body matrix available');
    pool.render([saloon,distant]);
    assert(!wheels.visible && page('sedan').count === 2, 'overhead uses the original body for both cars');

    // All close passenger bodies use the distant body's hinges. Wait for the
    // actual optional GLBs here so a missing variant cannot pass via fallback.
    const formedCars = ['hatch','estate','suv','taxi','van','pickup'].map(type => new Car(type, () => .2));
    for (const roll of [.2,.9]) {
      formedCars.push(new Car('police', () => roll));
      const armoured = new Car('police', () => roll); armoured.armour(); formedCars.push(armoured);
    }
    const modelKey = c => c.key + '|formed|street-wheels';
    const visible = (c, distance, street = true) => pool.render([c],null,0,undefined,street,{ x:distance,z:0 });
    // Trigger the prefetch, then inspect selection at both distances.
    for (const c of formedCars) visible(c, 32);
    const formsDeadline = performance.now() + 20000;
    do {
      pool.render(formedCars,null,0,undefined,true,eye);
      if (formedCars.every(c => page(modelKey(c))?.count === 1)) break;
      await new Promise(requestAnimationFrame);
    } while (performance.now() < formsDeadline);
    for (const c of formedCars) {
      const detailed = page(modelKey(c)), fallback = page(c.key + '|street-wheels');
      visible(c, 5);
      assert(detailed?.count === 1 && !fallback.visible && !page(c.key).visible, c.key + ' selects its sculpted shell');
      assert(detailed.geometry.groups.length === 2 && detailed.material[1].transparent && c.streetHeadlights?.forward > 1,
        c.key + ' has fitted glazing and lamp origins');
      const hinge = geometry => {
        const result = new Map(), attr = geometry.attributes.hinge;
        for (let i=0;i<attr.count;i++) {
          const n=attr.getZ(i);
          if(n>=1 && n<=4 && !result.has(n)) result.set(n,[attr.getX(i),attr.getY(i)]);
        }
        return result;
      };
      const original = hinge(fallback.geometry), replacement = hinge(detailed.geometry);
      assert(original.size === c.doors.length && [...original].every(([n,p]) => {
        const q = replacement.get(n); return q && Math.hypot(p[0]-q[0],p[1]-q[1]) < .001;
      }), c.key + ' retains all original door pivots');
      c.open(1,true); c.swing(1); visible(c,5);
      assert(detailed.geometry.attributes.doors.getX(0) > 1 && pool.matrixOf(c,new THREE.Matrix4()),
        c.key + ' animates the driver door on the rendered body');
      visible(c,32);
      assert(page(c.key).count === 1 && !detailed.visible && !c.streetHeadlights,c.key + ' uses the original distant body');
      visible(c,5,false);
      assert(page(c.key).count === 1 && !detailed.visible,c.key + ' uses the original overhead body');
    }
    // The sprung chassis and its driver tilt; all four wheel contacts stay on
    // the terrain. Exercise the hero and the ordinary close-wheel shader inputs.
    const { ROLL_CENTRE } = await import(loadedModule('/src/streetHandling.ts'));
    for (const type of ['sedan', 'suv']) {
      const car = new Car(type, () => .2), parked = new Car(type, () => .2, 5, 0);
      car.mode = 'player'; car.vx = 14;
      for (let i = 0; i < 60; i++) car.update(1/60,{throttle:.2,steer:1,handbrake:false},{at:()=>0},true);
      assert(car.suspension.roll > .05, type + ' chassis has taken a set');
      Object.assign(car, {x:0,y:0,h:0});
      const bump = (x,y) => x>0 && y>0 ? .12 : 0;
      pool.render([car, parked],bump,0,1,true,eye);
      const active = page(type === 'sedan' ? heroKey : modelKey(car)), attr = active.geometry.attributes.roll;
      assert(attr.getW(0)<0 && attr.getW(1)>0,type + ' suspension applies only to the player instance');
      const matrix = new THREE.Matrix4(); pool.matrixOf(car,matrix);
      const q = new THREE.Quaternion().fromArray(WHEEL_LEVEL.value.toArray()), pivot = new THREE.Vector3(0,ROLL_CENTRE,0);
      const hinge = active.geometry.attributes.hinge, hubs = new Map();
      for(let i=0;i<hinge.count;i++) if(hinge.getZ(i)<0) hubs.set(hinge.getX(i)+','+hinge.getY(i), [hinge.getX(i),hinge.getY(i)]);
      assert(hubs.size===4,type+' has four wheel contacts');
      for(const [x,z] of hubs.values()) {
        const warp = Math.sign(-x*z) * Math.floor((attr.getZ(0)+1)/2)*.0025;
        const contact = new THREE.Vector3(x,warp,z).sub(pivot).applyQuaternion(q).add(pivot).applyMatrix4(matrix);
        assert(Math.abs(contact.y-bump(x,-z))<.003,type+' wheel clears the road by '+contact.y);
      }
    }
    const rig = new Car('ambulance', () => .3, 19, 27, .5);
    const matrix = new THREE.Matrix4();
    for (const wreck of [false, true]) {
      if (wreck) rig.burn();
      const simple = rig.key, detail = 'ambulance|street' + (wreck ? '|burnt' : '');
      for (const street of [false, true, false]) {
        pool.render([rig], null, 0, undefined, street);
        const active = page(street ? detail : simple), inactive = page(street ? simple : detail);
        assert(active.visible && active.count === 1 && !inactive?.visible, 'one ambulance body in the selected view');
        assert(pool.matrixOf(rig, matrix) && matrix.elements[12] === 19 && matrix.elements[14] === -27,
          'same ambulance placement through camera changes');
        if (street) {
          assert(active.geometry.getAttribute('position').count > page(simple).geometry.getAttribute('position').count,
            'street ambulance uses the detailed geometry');
          if (!wreck) {
            const groups = active.geometry.groups, materials = active.material;
            assert(groups.length === 2 && groups[1].start === groups[0].count &&
              groups[1].start + groups[1].count === active.geometry.getAttribute('position').count,
              'cab windows and body cover exactly one model');
            assert(materials[0].map?.isTexture && materials[1].transparent && !materials[1].depthWrite,
              'printed body and see-through cab windows');
          } else assert(!Array.isArray(active.material) && !active.material.map, 'wreck has no bright printed livery');
        }
      }
    }
    pool.render([]);
    for (const type of ['bus', 'minibus', 'truck', 'artic', 'garbage', 'bike', 'moto']) {
      const two = type === 'bike' || type === 'moto';
      const vehicle = new Car(type, () => .2, 0, 0, 0, '#e75394', two ? COURIER_BOXES[0] : undefined);
      const fitted = vehicle.key + '|fitted', simple = page(vehicle.key);
      for (const [street, distance, close] of [[true, 6, true], [true, 40, false], [false, 6, false], [true, 6, true]]) {
        pool.render([vehicle], null, 0, undefined, street, { x: distance, z: 0 });
        assert(page(fitted).count === Number(close) && simple.count === Number(!close), type + ' near/far/overhead');
        assert(pool.matrixOf(vehicle, new THREE.Matrix4()), type + ' accessory transform follows its active body');
      }
      const mesh = page(fitted);
      assert(mesh.geometry.attributes.position.count > simple.geometry.attributes.position.count, type + ' fitted geometry');
      if (two) {
        assert(mesh.geometry.attributes.painted.array.some(value => value === 1), type + ' uses the rider’s paint');
      } else {
        assert(mesh.geometry.groups.length === 2 && mesh.material[1].transparent && !mesh.material[1].depthWrite,
          type + ' has separate cab glazing');
        vehicle.mode = 'traffic';
        pool.render([vehicle], null, 0, undefined, true, eye);
        assert(driversShown() === 1, type + ' occupied driver seat');
      }
      vehicle.burn();
      pool.render([vehicle], null, 0, undefined, true, eye);
      assert(page(vehicle.key).count === 1 && mesh.count === 0, type + ' keeps its charred wreck');
    }
    const tender = new Car('fire', () => .2);
    for (const [street, distance, detail] of [[true, 8, true], [true, 40, false], [false, 8, false]]) {
      pool.render([tender], null, 0, undefined, street, {x:distance, z:0});
      assert(page('fire|street').visible === detail && page('fire').visible !== detail, 'fire engine detail by view and distance');
      assert(pool.matrixOf(tender, matrix), 'fire engine transform available in either view');
    }
    assert(page('fire|street').geometry.groups.length === 2, 'one opaque body and one glazed cab');
    for (const roll of [.2, .85]) {
      const patrol = new Car('police', () => roll);
      const body = roll < .65 ? 'police' : 'police_city';
      assert(patrol.key === body && patrol.doors.length === 4 && patrol.doors.every(d => d.real), 'marked body with hinged doors');
      const saved = new Car('police', () => 1-roll, 0,0,0,patrol.paint);
      assert(saved.key === body, 'saved patrol keeps its body and paint');
      patrol.armour();
      pool.render([patrol],null,0,undefined,true,{x:0,z:0});
      assert(page(modelKey(patrol)).count === 1 && patrol.ram, 'close marked patrol retains ram');
      patrol.burn();
      pool.render([patrol]);
      assert(page(body+'|ram|burnt').count === 1, 'charred patrol retains correct silhouette');
    }
    pool.render([]);
    report.push('render: prepared page retained; new builder states ' + fresh + '; ' + (r.backend?.isWebGPUBackend ? 'WebGPU' : 'WebGL'));
  }
  if (${!!baseline} && r.backend?.isWebGPUBackend) {
    const base = ${JSON.stringify(baseline)};
    const old = await import(base + 'src/car.ts');
    const oldFigures = await import(base + 'src/figures.ts');
    await old.loadCars(base + 'cars.glb');
    old.useKit(await oldFigures.loadKit(base + 'figures.glb'));
    const oldPool = new old.CarPool(new THREE.Scene());
    const bodies = old.ordinaryCarBodies(['#123456']);
    oldPool.prepare(bodies);
    let vertices = 0, maxError = 0;
    for (const body of bodies) {
      const c = new Car(body.type, () => .2, 0, 0, 0, body.paint, body.box);
      const before = oldPool.meshes.get(body.box ? body.type + '|' + body.paint + '|' + body.box : body.type + '|' + body.paint)[0].geometry;
      const after = page(c.key).geometry;
      const baked = before.getAttribute('color'), shade = after.getAttribute('color'), mask = after.getAttribute('painted'), paint = new THREE.Color(c.paint);
      assert(baked.count === shade.count && mask.count === shade.count, 'same vertex count ' + c.key);
      for (let i = 0; i < baked.count; i++) {
        for (let axis = 0; axis < 3; axis++) {
          const expected = shade.array[i * 3 + axis] * (1 + ([paint.r, paint.g, paint.b][axis] - 1) * mask.getX(i));
          const error = Math.abs(expected - baked.array[i * 3 + axis]);
          maxError = Math.max(maxError, error);
          assert(error < 1e-7, body.type + ' ' + body.paint + ': baked colour differs at vertex ' + i);
        }
        vertices++;
      }
      for (const attr of ['position', 'normal']) {
        const a = before.getAttribute(attr).array, b = after.getAttribute(attr).array;
        assert(a.length === b.length && a.every((v,i) => v === b[i]), 'unchanged ' + attr + ' ' + c.key);
      }
    }
    const seeded = () => { let seed = 123456789, calls = 0; return { next: () => { calls++; seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; }, count: () => calls }; };
    const a = seeded(), b = seeded(), types = Object.keys(old.TYPES), records = [[], []];
    for (let i = 0; i < 1000; i++) {
      const type = types[i % types.length], box = old.TYPES[type].two && i % 2 ? COURIER_BOXES[i % 3] : undefined;
      const before = new old.Car(type, a.next, i * 1.3, -i * .7, i * .01, undefined, box);
      const after = new Car(type, b.next, i * 1.3, -i * .7, i * .01, undefined, box);
      const oldPaint = before.key.split('|')[1];
      assert(after.paint === oldPaint && before.variant?.id === after.variant?.id && a.count() === b.count(), 'seeded paint/variant/RNG ' + i);
      records[0].push([before.type,before.x,before.y,oldPaint,before.variant?.id]);
      records[1].push([after.type,after.x,after.y,after.paint,after.variant?.id]);
    }
    const hash = async (rows) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(rows.sort()))))).map(v => v.toString(16).padStart(2,'0')).join('');
    const hashes = await Promise.all(records.map(hash));
    assert(hashes[0] === hashes[1], 'order-independent seeded hash');
    // Compare a courier wreck too; mask zero must keep it dark with any instance paint.
    for (const type of types) {
      const box = old.TYPES[type].two ? COURIER_BOXES[0] : undefined;
      const colour = type === 'hatch' && ${selected === 'all' || selected === 'capacity'} ? undefined : '#123456';
      const before = new old.Car(type, () => .2, 0, 0, 0, colour, box);
      const after = new Car(type, () => .2, 0, 0, 0, colour, box);
      before.burn(); after.burn(); oldPool.render([before]); pool.render([after]);
      const a = oldPool.meshes.get(before.key)[0].geometry.getAttribute('color');
      const g = page(after.key).geometry, b = g.getAttribute('color');
      assert(a.count === b.count && a.array.every((v,i) => Math.abs(v - b.array[i]) < 1e-7), 'burnt baked colours ' + type);
      assert(g.getAttribute('painted').array.every(v => v === 0), 'wreck paint mask ' + type);
    }
    pool.render([]);
    report.push('baseline: ' + bodies.length + ' body/paint/box combinations, ' + vertices + ' vertices, max colour error ' + maxError + ', 1000 seeded cars hash ' + hashes[0]);
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
