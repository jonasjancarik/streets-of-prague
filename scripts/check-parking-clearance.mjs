#!/usr/bin/env node
// CPU regressions against the actual TS modules; no browser/GPU or map rebuild.
// node scripts/check-parking-clearance.mjs
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
registerHooks({ load(url, context, next) {
  if (!url.endsWith('.ts')) return next(url, context);
  const source = readFileSync(new URL(url), 'utf8').replaceAll('import.meta.env', '({})');
  return { format: 'module', shortCircuit: true, source: ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText };
}});
globalThis.location = { search: '' };
globalThis.self = globalThis;
Object.defineProperty(globalThis,'localStorage',{value:{getItem:()=>null,setItem:()=>{}},configurable:true});
const { DriveGraph, junctionCurve, junctionTrim, Route, segDist } = await import('../src/network.ts');
const { parkingClearance } = await import('../src/parkingClearance.ts');
const { parkCars, Zones } = await import('../src/parking.ts');
const { TileWorld } = await import('../src/tiles.ts');
const { rng } = await import('../src/map/geo.ts');
// Load the shipped geometry in memory, without a renderer or HTTP server.
globalThis.ProgressEvent = class extends Event { constructor(type, init) { super(type); Object.assign(this,init); } };
const {loadCars,useKit}=await import('../src/car.ts');
const {loadKit}=await import('../src/figures.ts');
const model=(file)=>'data:model/gltf-binary;base64,'+readFileSync(new URL('../public/'+file,import.meta.url)).toString('base64');
await loadCars(model('cars.glb'));useKit(await loadKit(model('figures.glb')));

const raw = (id, u, v, pts, extra = {}) => ({ id, u, v, pts, hw: 'residential', width: 8, ...extra });
const graph = (raws) => { const g = new DriveGraph(); g.add(raws); return g; };
const rectangle = (x0, y0, x1, y1) => [[[x0,y0],[x1,y0],[x1,y1],[x0,y1],[x0,y0]]];
const data = (lots) => ({ lots: lots.map((rings) => ({ o:'parallel', rings })), areas: {}, rails: [] });
const park = (edges, clearanceEdges, lots, seed = 10, extra = {}) => parkCars({
  data: data(lots), edges, clearanceEdges, zones: new Zones(null), solid: () => false, r: rng(seed), ...extra,
});
const positions = (cars) => cars.map((c) => [c.x,c.y,c.h,c.type,c.paint]).sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
const reports = [];

const hillLot = [rectangle(0, 0, 70, 10)];
const ordinaryLot = park([], [], hillLot).cars;
assert.ok(ordinaryLot.length > 0, 'parking fixture places cars without a height sampler');
assert.deepEqual(positions(park([], [], hillLot, 10, { height: (x, y) => .08 * (x + y) }).cars),
  positions(ordinaryLot), 'a plausible slope keeps the same parked cars');
assert.equal(park([], [], hillLot, 10, { height: (x, y) => x + y }).cars.length, 0,
  'the lot outline does not make a steep hillside suitable for parking');
reports.push('parking remains available on ordinary slopes and rejects steep ground');

// The curve cuts across clear ground between the straight lanes; a safe corner
// farther from it must remain available. Both trim distances match actual Route.
const corner = graph([raw('in','a','j',[[-40,0],[0,0]]), raw('out','j','b',[[0,0],[0,-40]])]);
const [incoming, outgoing] = corner.edges;
const clear = parkingClearance(corner.edges);
const clippedClear = parkingClearance(corner.edges,[-10,-10,0,0]);
for(let x=-12;x<=2;x+=.5) for(let y=-12;y<=2;y+=.5) assert.equal(clippedClear(x,y,1.05),clear(x,y,1.05),'cropped index preserves overhang clearance');
assert.equal(clear(-5,-5,.9), false, 'turn intrudes into a formerly clear corner');
assert.equal(clear(-12,-8,.9), true, 'parking beyond the swept corridor remains possible');
for (const main of [false,true]) {
  const route = new Route(corner,incoming,0,() => 0,main);
  const trim = junctionTrim(incoming,outgoing,main);
  const expected = junctionCurve(incoming.path.at(incoming.path.length-trim),outgoing.path.at(trim));
  assert.deepEqual(route.legs[1].path.pts,expected.pts);
  for (let s=0;s<=expected.length;s+=.25) {
    const p=expected.at(s); assert.equal(clear(p.x,p.y,.9),false,'curve segment protected');
  }
}
reports.push('ordinary/bus curves and legitimate corner setback');
// Check the real Traffic.update pose, including its heading smoothing and the
// bus axle/lookahead placement. Every disk accepted near the turn must be clear
// of the moving body's collision circles throughout entry, turn and exit.
const {Traffic}=await import('../src/traffic.ts');
const {Car}=await import('../src/car.ts');
const {Scene}=await import('three');
assert.equal(clear(-8.1,.2,.9),false,'rear overhang missed by a centreline-only rule');
for(const fixture of [corner, graph([raw('in','a','j',[[-40,0],[0,0]]),raw('out','j','b',[[0,0],[0,40]])]), graph([raw('in','a','j',[[-16,0],[-8,1],[0,0]]),raw('out','j','b',[[0,0],[12,-12]])])]) {
 const [incoming,outgoing]=fixture.edges, clear=parkingClearance(fixture.edges);
 const accepted=[];
 for(let x=-15;x<=5;x+=.5) for(let y=-15;y<=15;y+=.5) if(clear(x,y,.9)) accepted.push([x,y]);
 for(const type of ['pickup','bus']) {
 const route=new Route(fixture,incoming,Math.max(0,incoming.path.length-14),()=>0,type==='bus');
 const p=route.leg.path.at(route.s), car=new Car(type,rng(4),p.x,p.y,p.ang);
 car.mode='traffic';
 const traffic=new Traffic(fixture,new Scene(),rng(4),0);
 traffic.agents.push({car,route,speed:4.5,stuck:0,jam:0,ignore:0,cruise:1,off:0});
 let frames=0;
 while(frames++<1200 && !(route.leg.edge===outgoing && route.s>Math.min(17,outgoing.path.length*.7))) {
  traffic.update(1/60,()=>[]);
  for(const [x,y] of accepted) for(const [cx,cy] of car.circles()) {
   assert.ok(Math.hypot(x-cx,y-cy)>=.9+car.r,`accepted parking disk touches ${type} at ${x},${y}; edge ${JSON.stringify(outgoing.pts)} route ${route.s} centre ${car.x},${car.y} heading ${car.h} circle ${cx},${cy}`);
  }
 }
 assert.ok(route.leg.edge===outgoing && route.s>Math.min(17,outgoing.path.length*.7),'vehicle completed the turn');
}
}
reports.push('actual pickup/bus bodies through right, left and curved short-edge turns');
// Ostrovni -> Opatovicka, centrum build 2026-10-02T20:16:12Z. The old
// placement accepted this hatchback; the real scene measured 0.377 m of bus
// overlap. Keep the small road snapshot so the regression needs no map download.
const real=graph([
 raw('25656653>25656648>0','25656653','25656648',[[-114.34,-76.15],[-142.45,-88]],{oneway:true,lanes:1,width:3.75}),
 raw('25656648>25656646>0','25656648','25656646',[[-142.45,-88],[-138.91,-95.27],[-128.45,-125.76],[-127.59,-130.05]],{oneway:true,width:8}),
]);
const oldHatch=new Car('hatch',rng(9),-136.81308152859725,-82.9820618619707,3.553146452691224);
for(const [x,y] of oldHatch.circles()) for(const e of real.edges) for(let i=1;i<e.path.pts.length;i++) {
 assert.ok(segDist(x,y,e.path.pts[i-1],e.path.pts[i])>=oldHatch.r+1.25,'old straight-lane test accepted the real hatch');
}
assert.ok(oldHatch.circles().some(([x,y])=>!parkingClearance(real.edges)(x,y,oldHatch.r)),'real corner car is rejected by the swept turn');
reports.push('real Ostrovni-Opatovicka corner snapshot');

// Pobrezni, centrum build 2026-10-15T10:41:33Z: this sedan was accepted
// beside a sharp bend INSIDE one edge. Actual Traffic.update drove a pickup's
// front circle 0.70-0.81 m into it, including with the sedan in the obstacle index.
const interior = graph([
 raw('260122825>370457941>0','260122825','370457941',[[1409.1,1207.92],[1405.84,1234.77],[1367.77,1229.31],[1359.89,1228.36]],{width:7,lanes:2,surface:'asphalt'}),
 raw('370457941>1825997270>0','370457941','1825997270',[[1359.89,1228.36],[1344.27,1234.69],[1338.31,1237.5],[1335.42,1240.09],[1333.9,1241.67],[1332.06,1244.72],[1324.78,1265.95]],{hw:'secondary_link',width:3.75,lanes:1,oneway:true}),
]);
const unsafeSedan = new Car('sedan',rng(1),1406.48,1240.72,1.4590192852605206), interiorClear = parkingClearance(interior.edges);
assert.ok(unsafeSedan.circles().some(([x,y])=>!interiorClear(x,y,unsafeSedan.r)),'the captured sedan is rejected');
const acceptedInterior=[];
for(let x=1398;x<=1416;x+=.25)for(let y=1229;y<=1249;y+=.25)if(interiorClear(x,y,unsafeSedan.r))acceptedInterior.push([x,y]);
assert.ok(acceptedInterior.length>3000,'setback parking remains available');
const interiorCrop=parkingClearance(interior.edges,[1400,1230,1410,1245]);
for(let x=1400;x<1410;x+=.5)for(let y=1230;y<1245;y+=.5)
 assert.equal(interiorCrop(x,y,unsafeSedan.r),interiorClear(x,y,unsafeSedan.r),'interior sweep survives an index crop');
for(const dt of[1/60,.05])for(const speed of[0,8,13]) {
 const[e,f]=interior.edges,route=new Route(interior,e,0,()=>0,false,from=>from===e?f:null),p=route.leg.path.at(route.s);
 const car=new Car('pickup',rng(1),p.x,p.y,p.ang);car.mode='traffic';
 const traffic=new Traffic(interior,new Scene(),rng(1),0),a={car,route,speed,stuck:0,jam:0,ignore:0,cruise:1,off:0};traffic.agents.push(a);
 let done=false;
 for(let n=0;n<Math.ceil(60/dt);n++) {
  traffic.update(dt,()=>[]);
  for(const[cx,cy]of car.circles())for(const[x,y]of acceptedInterior)
   assert.ok(Math.hypot(x-cx,y-cy)>=unsafeSedan.r+car.r,'accepted disks clear the actual smoothed pickup body');
  if(route.leg.edge===f&&route.s>Math.min(f.path.length-.5,route.leg.s0+14)){done=true;break;}
 }
 assert.ok(done,'the pickup completes the captured bend');
}
// Duplicate vertices must neither invent a turn on a straight street nor hide
// a genuine turn. Derive tangents without changing the route's own geometry.
for(const pts of[[[0,-30],[0,0],[0,30]],[[0,-30],[0,0],[-30,0]]]) {
 const repeated=[pts[0],pts[1],pts[1],pts[2]],a=parkingClearance(graph([raw('a','a','b',pts,{oneway:true})]).edges),b=parkingClearance(graph([raw('a','a','b',repeated,{oneway:true})]).edges);
 for(let x=-8;x<=8;x+=.2)for(let y=-8;y<=8;y+=.2)assert.equal(a(x,y,.93),b(x,y,.93),'duplicate point preserves clearance');
}
reports.push('captured interior bend: actual pickup bodies, dt/speed variants, setback/crop and duplicate-point controls');



// A street centreline outside the tile can offset its traffic lane into it.
const own = graph([raw('own','a','b',[[-50,10],[0,10]],{oneway:true})]).edges;
const foreign = raw('foreign','c','d',[[.5,20],[.5,-20]],{width:4});
const all = graph([...own,foreign]).edges;
assert.equal(parkingClearance(own)(-.5,0,.9),true);
assert.equal(parkingClearance(all)(-.5,0,.9),false);
const outside=graph([raw('outside','u','v',[[4.1,-40],[4.1,40]],{oneway:true})]).edges;
assert.equal(parkingClearance(outside,[-20,-20,0,20])(1.9,0,1.05),false,'owned car overhang outside the index crop');
reports.push('neighbouring lane outside the tile centreline');

// Emergency routes use the mapped street's middle, even when ordinary traffic is
// offset into the right lane of a wide one-way road. Bays on that middle are unsafe.
const oneWay = graph([raw('centre','a','b',[[0,0],[80,0]],{oneway:true,lanes:2,width:12})]).edges;
const centreClear = parkingClearance(oneWay);
assert.ok(Math.abs(oneWay[0].laneOffset) > 2.25, 'fixture separates the traffic lane from the emergency route');
assert.equal(centreClear(30,0,.9), false, 'parking cannot occupy the emergency route between ordinary lanes');
assert.equal(centreClear(30,3.5,.9), true, 'setback parking outside both routes remains available');
for (const kind of ['bridge','tunnel']) {
  const raised = graph([raw(kind,'a','b',[[0,0],[80,0]],{oneway:true,lanes:2,width:12,[kind]:true})]).edges;
  assert.equal(parkingClearance(raised)(30,0,.9), true, 'a different level does not reserve a ground-level corridor');
}
reports.push('emergency centreline on wide one-way roads and separate levels');

// A gentle polyline stays within the ordinary lane corridor (sharp bends have
// their body envelope checked above). Across negative cells, the spatial lookup
// must agree with an exhaustive segment scan, including near a cell edge.
const bend = graph([raw('bend','a','b',[[-35,-20],[-20,-20],[-10,-19.5],[10,-19.5]],{oneway:true})]).edges;
const bendClear=parkingClearance(bend);
const fireRadius=new Car('fire',rng(1)).r;
for(let x=-45;x<20;x+=.7) for(let y=-30;y<0;y+=.7) {
  const expected=![[bend[0].path.pts,1.25],[bend[0].pts,fireRadius]].some(([pts,r])=>pts.slice(1).some((b,i)=>segDist(x,y,pts[i],b)<1+r));
  assert.equal(bendClear(x,y,1),expected);
}
reports.push('curved road and spatial cell seams');

const narrow=graph([raw('n','a','b',[[0,0],[50,0]],{width:4})]).edges;
assert.equal(park(narrow,narrow,[rectangle(5,-3,45,-1)],10).cars.length,0,'narrow street has no room');
assert.ok(park(narrow,narrow,[rectangle(5,-7,45,-5)],10).cars.length>0,'setback bays remain');
const wide=graph([raw('w','a','b',[[0,0],[50,0]])]).edges;
const zone={code:'paid',category:'blue',spaces:10,inside:1,occDay:80,occNight:100,polys:[rectangle(0,-8,50,-3)]};
for(const night of [false,true]) {
  const got=park(wide,wide,[rectangle(5,-6,45,-4)],10,{zones:new Zones({sections:[zone]}),shares:new Map([['paid',.5]]),night});
  assert.equal(got.wanted,night?5:4); assert.equal(got.zoned,1); assert.equal(got.cars.length,night?5:4);
}
reports.push('narrow streets and paid day/night shares');

// Kerbside cars by road class (no car parks here): none on a motorway or a slip road
// however wide its shoulder, none in the lanes of a divided main road, some where
// that road's kerb leaves room, and an explicit tag still decides.
const kerbside=(extra)=>{const e=graph([raw('k','a','b',[[0,0],[200,0]],extra)]).edges;let n=0;for(let seed=0;seed<6;seed++) n+=park(e,e,[],seed).cars.length;return n;};
assert.ok(kerbside({kerb:[5.5,5.5]})>0,'an ordinary street has cars at the kerb');
for(const hw of ['motorway','motorway_link','trunk','trunk_link','primary_link'])
  assert.equal(kerbside({hw,oneway:true,lanes:2,width:7.5,kerb:[6.6,4.2]}),0,hw+' has no cars at the kerb');
assert.ok(kerbside({hw:'trunk',oneway:true,lanes:2,width:7.5,kerb:[6.6,4.2],park:['parallel',null]})>0,'a tagged parking lane on an expressway is kept');
assert.equal(kerbside({hw:'primary',oneway:true,lanes:3,width:10.75,kerb:[5.95,5.88]}),0,'no cars in the lanes of a divided main road');
assert.ok(kerbside({hw:'primary',oneway:true,lanes:2,width:7.5,kerb:[8.14,3.92]})>0,'cars where its kerb leaves room beside the lanes');
reports.push('no kerbside cars on motorways, slip roads or in the lanes of divided main roads');
// Outside the zones the buildings decide how full the kerb is (src/parkingDemand.ts).
const road=graph([raw('long','a','b',[[0,0],[600,0]])]).edges;
const lotsAlong=[rectangle(10,-6.5,590,-4.5)];
const houseRow=(kind,h)=>Array.from({length:12},(_,i)=>({kind,h,rings:rectangle(20+i*45,-40,20+i*45+12,-28)}));
const parked=(buildings,night=false)=>{let n=0;for(let seed=0;seed<6;seed++) n+=park(road,road,lotsAlong,seed,{buildings,night}).cars.length;return n/6;};
const [flats,houses,nobody]=[parked(houseRow('apartments',24)),parked(houseRow('house',6)),parked([])];
assert.ok(flats>1.8*houses,`flats ${flats} vs houses ${houses}`);
assert.ok(houses>nobody,`houses ${houses} vs no buildings ${nobody}`);
assert.ok(nobody<=0.15*flats,`a lot with nothing round it stays nearly empty: ${nobody}`);
const office=houseRow('office',12);
assert.ok(parked(office,false)>1.8*parked(office,true),'offices fill by day and empty at night');
reports.push('parking occupancy follows the buildings round it');
assert.equal(parkingClearance(graph([{...foreign,bridge:true}]).edges)(-.5,0,1),true);
assert.equal(parkingClearance(graph([{...foreign,tunnel:true}]).edges)(-.5,0,1),true);
const kerb=raw('kerb','a','b',[[0,0],[50,0]],{width:4,kerb:[3.5,null]});
let pavementCars=0;
for(let seed=0;seed<40;seed++) {
 const base=graph([kerb]).edges;
 const elevated=graph([kerb,raw('above','c','d',[[25,-50],[25,50]],{width:100,bridge:true})]).edges;
 const a=park(base,base,[],seed),b=park(base,elevated,[],seed);
 assert.deepEqual(positions(a.cars),positions(b.cars),'overhead road does not erase pavement parking');
 pavementCars+=a.cars.length;
}
assert.ok(pavementCars>0,'pavement fixture has legitimate cars');
reports.push('separate bridge/tunnel levels');

// Call the actual halo loader with opposite completion and invocation order.
const tiles=new Map([
 ['0_0',{i:0,j:0,drive:own,box:[-50,-20,0,20],lots:[rectangle(-15,-6,-1,-4)]}],['1_0',{i:1,j:0,drive:[foreign],box:[0,-20,50,20],lots:[rectangle(1,-6,15,-4)]}],
]);
const halo=async (reverse) => {
 const world=Object.create(TileWorld.prototype);
 world.available=new Set(tiles.keys()); world.index={graphs:true};
 world.fetchJSON=async (key) => { await new Promise(r=>setTimeout(r, (key==='0_0')===reverse?5:0)); return tiles.get(key); };
 const order=reverse?['1_0','0_0']:['0_0','1_0'];
 const result={};
 for(const key of order) result[key]=await world.parkingEdges(tiles.get(key));
 return result;
};
const [ab,ba]=await Promise.all([halo(false),halo(true)]);
const combined=[];
for(const key of tiles.keys()) {
 assert.deepEqual(ab[key].map(e=>e.id),ba[key].map(e=>e.id));
 const tile=tiles.get(key),[x0,y0,x1,y1]=tile.box;
 const inside=(x,y)=>x>=x0&&x<x1&&y>=y0&&y<y1;
 const edges=graph(tile.drive).edges;
 const a=park(edges,ab[key],tile.lots,10,{inside}),b=park(edges,ba[key],tile.lots,10,{inside});
 assert.deepEqual(positions(a.cars),positions(b.cars),'arrival/reload parking hash');
 assert.ok(a.cars.every(c=>inside(c.x,c.y)),'centres stay with their owning tile');
 combined.push(...a.cars);
}
assert.ok(combined.length>0,'legitimate neighbouring parking remains');
assert.equal(new Set(combined.map(c=>`${c.x}/${c.y}`)).size,combined.length,'no duplicate centres across tiles');
const failedHalo=Object.create(TileWorld.prototype);
failedHalo.available=new Set(tiles.keys());failedHalo.index={graphs:true};
failedHalo.fetchJSON=async key=>{if(key==='1_0')throw Error('neighbour missing');return tiles.get(key);};
await assert.rejects(failedHalo.parkingEdges(tiles.get('0_0')),/neighbour missing/);
reports.push('two-tile invocation/completion order and repeated deterministic placement');

// JSON failure retries instead of poisoning the halo cache; simultaneous users
// share one fetch, so no extra height/IPR transfer is required by parking.
const world=Object.create(TileWorld.prototype);
world.jsons=new Map();world.available=new Set(['0_0']);world.country=null;world.area='fixture';world.cover=null;world.index={graphs:false};
const oldFetch=globalThis.fetch;let requests=0;
const fixture={i:0,j:0,box:[0,0,50,50],areas:{},roads:{},buildings:[],walls:[],trees:[],rails:[],drive:[],walk:[]};
try {
 globalThis.fetch=async()=>{requests++;return requests===1?{ok:false,status:503}:{ok:true,json:async()=>fixture};};
 await assert.rejects(world.fetchJSON('0_0'),/503/);assert.equal(world.jsons.size,0);
 const a=world.fetchJSON('0_0'),b=world.fetchJSON('0_0');assert.equal(a,b);assert.equal(await a,fixture);assert.equal(requests,2);
} finally {globalThis.fetch=oldFetch;}
reports.push('failed JSON retry and concurrent fetch deduplication');
// Graph-enabled JSON cannot silently turn a missing neighbour graph into empty
// road evidence. Explicit empty arrays are valid; old maps may omit both fields.
try {
 const graphWorld=Object.create(TileWorld.prototype);
 Object.assign(graphWorld,{jsons:new Map(),area:'fixture',cover:null,index:{graphs:true},available:new Set(['0_0','1_0'])});
 const ownTile={...fixture,drive:own,walk:[]},neighbour={...fixture,i:1,drive:[foreign],walk:[]};
 for(const missing of [['drive'],['walk'],['drive','walk']]) {
  const bad={...neighbour};for(const name of missing)delete bad[name];
  globalThis.fetch=async url=>Response.json(String(url).includes('1_0')?bad:ownTile);
  await assert.rejects(graphWorld.parkingEdges(ownTile),/Tile 1_0 has invalid map data/);
  assert.equal(graphWorld.jsons.has('1_0'),false,'invalid neighbour JSON is evicted');
 }
 globalThis.fetch=async url=>Response.json(String(url).includes('1_0')?neighbour:ownTile);
 const recovered=await graphWorld.parkingEdges(ownTile);
 assert.equal(parkingClearance(recovered)(-.5,0,.9),false,'retry recovers the neighbouring lane');
 graphWorld.jsons.clear();globalThis.fetch=async()=>Response.json(fixture);
 assert.deepEqual((await graphWorld.fetchJSON('0_0')).drive,[],'explicit empty graphs are valid');
 graphWorld.index.graphs=false;graphWorld.jsons.clear();
 const legacy={...fixture};delete legacy.drive;delete legacy.walk;
 globalThis.fetch=async()=>Response.json(legacy);
 assert.equal((await graphWorld.fetchJSON('0_0')).drive,undefined,'legacy graph omissions remain valid');
} finally {globalThis.fetch=oldFetch;}
reports.push('required neighbour graph fields, empty arrays, legacy omissions and retry');
const pruned=Object.create(TileWorld.prototype);
Object.assign(pruned,{T:50,ox:0,oy:0,jsonRange:null,jsons:new Map([['0_0',Promise.resolve(fixture)],['99_99',Promise.resolve(fixture)]]),
 retry:new Map(),pending:new Map(),loaded:new Map(),photos:new Map(),inFlight:new Set(),dressing:new Set(),workers:{size:0},building:0,around:()=>[],jobs:[],turns:[],reveal:[]});
let scans=0;const keys=pruned.jsons.keys.bind(pruned.jsons);pruned.jsons.keys=()=>{scans++;return keys();};
pruned.update(5,5,100);assert.equal(pruned.jsons.size,1);assert.equal(scans,1);
pruned.update(6,6,100);assert.equal(scans,1,'stationary frames do not rescan the halo cache');
pruned.update(500,500,100);assert.equal(pruned.jsons.size,0);assert.equal(scans,2);
reports.push('halo cache prunes on movement without per-frame scans');

console.log('Parking clearance checks passed: '+reports.join('; '));
