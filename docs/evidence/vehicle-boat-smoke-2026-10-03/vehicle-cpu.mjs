import assert from 'node:assert/strict';
import { createServer } from '/Users/janca/.codex/worktrees/overnight-city-integration/streets-of-prague/node_modules/vite/dist/node/index.js';
import * as THREE from '/Users/janca/.codex/worktrees/overnight-city-integration/streets-of-prague/node_modules/three/build/three.module.js';
globalThis.location={search:''};
let created=0;
globalThis.document={createElement(name){assert.equal(name,'canvas');created++;const calls=[];const context={fillRect(){},fillText(...args){calls.push({args,font:this.font,align:this.textAlign});}};return {calls,width:0,height:0,getContext(){return context;}};}};
const server=await createServer({root:'/Users/janca/.codex/worktrees/overnight-city-integration/streets-of-prague',cacheDir:'/tmp/streets-combined-smoke-20261003/vite-cache',configFile:false,server:{middlewareMode:true,hmr:false,ws:false}});
try {
 const {Car,CarPool,TYPES}=await server.ssrLoadModule('/src/car.ts');
 const {Police}=await server.ssrLoadModule('/src/police.ts');
 const {Beacons}=await server.ssrLoadModule('/src/beacons.ts');
 const pool=Object.create(CarPool.prototype);
 Object.assign(pool,{scene:new THREE.Scene(),meshes:new Map(),groups:new Map(),prepared:new Set(),overflowPages:0,latePages:0,dummy:new THREE.Object3D(),riders:{capacity:64,commit(){}},scale:new THREE.Matrix4(),m:new THREE.Matrix4(),boards:[],colours:new Map()});
 for(const type of ['bus','minibus']) {
  const c=new Car(type,()=>.5);c.line={ref:' 148 ',to:'Pražského povstání'};
  pool.render([c]);const nodes=pool.boards.slice(),mats=nodes.map(n=>n.material),maps=mats.map(m=>m.map);
  assert.equal(nodes.filter(n=>n.visible).length,3);
  assert.equal(maps[0].image.calls[0].args[0],'148');assert.equal(maps[1].image.calls[1].args[0],c.line.to);
  assert.notEqual(mats[0],mats[1]);
  const creations=created;
  for(let i=0;i<200;i++){c.x=i;pool.render([c]);}
  assert.equal(created,creations);assert.ok(nodes.every((n,i)=>pool.boards[i]===n&&n.material===mats[i]&&n.material.map===maps[i]));
  pool.render([]);assert.ok(nodes.every(n=>!n.visible));
  pool.render([c]);assert.ok(nodes.every(n=>n.visible));
  c.line.to='Újezd';pool.render([c]);const alternate=pool.boards[1].material;
  assert.notEqual(alternate,mats[1]);assert.equal(pool.boards[0].material,mats[0]);assert.equal(pool.boards[2].material,mats[2]);
  c.line.to='Pražského povstání';pool.render([c]);assert.equal(pool.boards[1].material,mats[1]);
  c.line.to='';pool.render([c]);assert.equal(pool.boards[0].material,pool.boards[1].material);
  c.line=undefined;pool.render([c]);assert.ok(nodes.every(n=>!n.visible));
  c.line={ref:' ',to:'Újezd'};pool.render([c]);assert.ok(nodes.every(n=>!n.visible));
  c.line={ref:'148',to:'Újezd'};c.burn();pool.render([c]);assert.ok(nodes.every(n=>!n.visible));
 }
 const ordinary=new Car('bus',()=>.5);ordinary.type='hatch';ordinary.line={ref:'148',to:'Újezd'};pool.render([ordinary]);assert.ok(pool.boards.every(n=>!n.visible));
 console.log('Bus CPU checks passed: bus/minibus, trimmed ref, actual destination, empty/missing/burnt/non-bus states, direction changes, 400 stable renders and hide/reuse.');
 const police=Object.create(Police.prototype);police.cars=[];police.stolen=new WeakSet();let crimes=0;police.crime=()=>crimes++;
 const car=new Car('bus',()=>.5);car.type='police';car.spec=TYPES.police;car.mode='police';police.cars.push({car,calm:false,wrecked:false});
 assert.ok(police.lit().includes(car));police.take(car);car.mode='player';assert.equal(police.chasing.length,0);assert.equal(crimes,1);
 const scene=new THREE.Scene();const beacons=new Beacons(scene);const lamps=scene.children[0];
 for(const speed of [0,20,-10]){car.vx=speed;car.vy=0;assert.deepEqual(police.lit(car),[car]);beacons.draw(police.lit(car),()=>0,0);assert.equal(lamps.count,2);}
 const first=Array.from(lamps.instanceColor.array.slice(0,6));let changed=false;
 for(let i=1;i<40;i++){beacons.draw(police.lit(car),()=>0,i/30);if(first.some((v,j)=>v!==lamps.instanceColor.array[j]))changed=true;}
 assert.ok(changed,'stopped/reverse lamps animate');
 car.mode='loose';beacons.draw(police.lit(null),()=>0,1);assert.equal(lamps.count,0);
 police.take(car);car.mode='player';assert.equal(crimes,1);beacons.draw(police.lit(car),()=>0,1);assert.equal(lamps.count,2);
 const chasing=new Car('bus',()=>.5);chasing.type='police';chasing.spec=TYPES.police;police.cars.push({car:chasing,calm:false,wrecked:false});assert.deepEqual(police.chasing.map(p=>p.car),[chasing]);assert.deepEqual(police.lit(car),[chasing,car]);
 police.cars.push({car,calm:false,wrecked:false});assert.equal(police.lit(car).filter(c=>c===car).length,1);
 police.cars=[];car.burnt=true;beacons.draw(police.lit(car),()=>0,1);assert.equal(lamps.count,0);
 car.burnt=false;beacons.draw(police.lit(car),()=>0,1);assert.equal(lamps.count,2);
 car.mode='loose';beacons.draw(police.lit(null),()=>0,1);assert.equal(lamps.count,0);
 police.cars=[{car:chasing,calm:true,wrecked:false}];assert.equal(police.lit().length,0);
 police.cars[0].calm=false;police.cars[0].wrecked=true;assert.equal(police.lit().length,0);
 police.cars=[];assert.deepEqual(police.lit(car),[]);
 console.log('Police CPU checks passed: theft once, stopped/forward/reverse, animated instance colors, exit/re-entry, duplicate guard, burnout, chase separation and despawn cleanup.');
 const {setupTestkit}=await server.ssrLoadModule('/src/testkit.ts');
 globalThis.requestAnimationFrame=fn=>{fn(0);return 0;};
 let driven=null, interactions=0;const walker={x:0,y:0,h:0,vx:0,vy:0};
 const game={canvas:{addEventListener(){}},traffic:{busLines:[{ref:'194',to:'Malostranské náměstí'}],agents:[]},police,
  mode:()=>driven?'car':'foot',car:()=>driven,me:()=>driven||walker,
  enterOrExit:()=>{interactions++;driven=driven?null:car;}};
 const t=setupTestkit(game);await t.enter(car);assert.equal(driven,car);assert.equal(interactions,1);
 await t.enter(car);assert.equal(interactions,1,'already entered car does not exit');
 t.exit();assert.equal(driven,null);await t.enter(car);assert.equal(driven,car);
 assert.equal(t.policeCar(),null,'fixture has no nearby police car in traffic or chase list');
 const bus=new Car('bus',()=>.5);t.busLine(bus,'194');assert.deepEqual(bus.line,{ref:'194',to:'Malostranské náměstí'});
 assert.throws(()=>t.busLine(bus,'999'),/No loaded bus line/);
 assert.throws(()=>t.busLine(car,'194'),/Not a bus/);
 const snapshot=t.busLines();snapshot[0].to='changed';assert.equal(game.traffic.busLines[0].to,'Malostranské náměstí');
 console.log('Testkit CPU checks passed: normal enter/re-entry/exit calls, already-entered guard, loaded route metadata, rejected invented/non-bus routes, detached line snapshots.');

} finally {await server.close();}
