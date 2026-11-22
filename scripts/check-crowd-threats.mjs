import assert from 'node:assert/strict';
import './offline-city.mjs';
const { Crowd } = await import('../src/people.ts');
const fast = { x:0,y:0,vx:10,vy:0 }, slow = {x:0,y:0,vx:1,vy:0};
const person=(x,y)=>({x,y,vx:0,vy:0,h:0,state:'walk',t:1,pause:0,s:10,speed:1.2,fwd:true,i:0,e:{path:{length:1000}},anim:{play(name){this.played=name;}}});
function step(people,threats) {
  const c=Object.assign(Object.create(Crowd.prototype),{people,threatScan:[],tick:0,r:()=>.9,blocked:()=>false,follow:()=>{}});
  c.update(0,threats,undefined,()=>false);
  return c;
}
const left=person(5,1),right=person(5,-1);
step([left,right],(function*(){yield slow;yield fast;})());
assert.equal(left.state,'flee');assert.equal(right.state,'flee','every walker sees a one-shot threat iterable');
assert.equal(left.vy,5.5);assert.equal(right.vy,-5.5);assert.equal(left.anim.played,'jump');
for(const [x,y,expected] of [[20,0,'flee'],[20.01,0,'walk'],[-1,0,'walk'],[-.99,0,'flee'],[5,4,'walk'],[5,3.9,'flee']]) {
 const p=person(x,y);step([p],[fast]);assert.equal(p.state,expected,`${x},${y}: reach, direction and side limits`);
}
const distant=Array.from({length:600},(_,i)=>person(1000+i,1000));
const hypot=Math.hypot;let calls=0;
Math.hypot=(...a)=>{calls++;return hypot(...a);};
try {step(distant,[fast,slow,{...fast,vy:4}]);}finally{Math.hypot=hypot;}
assert.equal(calls,3,'car speed is prepared once per threat, independent of crowd size');
assert(distant.every(p=>p.state==='walk'),'distant people keep walking');
console.log('Crowd threats: left/right escape, jump, reach/side limits, iterable reuse and 600-walker work count passed.');
