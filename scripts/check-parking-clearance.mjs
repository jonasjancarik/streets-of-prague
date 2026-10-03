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



// A street centreline outside the tile can offset its traffic lane into it.
const own = graph([raw('own','a','b',[[-50,10],[0,10]],{oneway:true})]).edges;
const foreign = raw('foreign','c','d',[[.5,20],[.5,-20]],{width:4});
const all = graph([...own,foreign]).edges;
assert.equal(parkingClearance(own)(-.5,0,.9),true);
assert.equal(parkingClearance(all)(-.5,0,.9),false);
const outside=graph([raw('outside','u','v',[[4.1,-40],[4.1,40]],{oneway:true})]).edges;
assert.equal(parkingClearance(outside,[-20,-20,0,20])(1.9,0,1.05),false,'owned car overhang outside the index crop');
reports.push('neighbouring lane outside the tile centreline');

// Curved road polylines and negative cell coordinates, including a query near a
// cell edge: the spatial lookup must agree with an exhaustive segment scan.
const bend = graph([raw('bend','a','b',[[-35,-20],[-20,-20],[-10,-10],[10,-10]],{oneway:true})]).edges;
const bendClear=parkingClearance(bend);
for(let x=-45;x<20;x+=.7) for(let y=-30;y<0;y+=.7) {
  const expected=!bend[0].path.pts.slice(1).some((b,i)=>segDist(x,y,bend[0].path.pts[i],b)<2.25);
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
world.jsons=new Map();world.area='fixture';world.cover=null;world.index={graphs:false};
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
 retry:new Map(),pending:new Map(),loaded:new Map(),inFlight:new Set(),workers:{size:0},building:0,around:()=>[]});
let scans=0;const keys=pruned.jsons.keys.bind(pruned.jsons);pruned.jsons.keys=()=>{scans++;return keys();};
pruned.update(5,5,100);assert.equal(pruned.jsons.size,1);assert.equal(scans,1);
pruned.update(6,6,100);assert.equal(scans,1,'stationary frames do not rescan the halo cache');
pruned.update(500,500,100);assert.equal(pruned.jsons.size,0);assert.equal(scans,2);
reports.push('halo cache prunes on movement without per-frame scans');

console.log('Parking clearance checks passed: '+reports.join('; '));
