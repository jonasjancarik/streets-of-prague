const d=window.__drive,c=window.__parkingCase;
if(!c)throw Error('No reproduced corner');
t.paused=true;
const {Car}=await import('/src/car.ts');const {Route}=await import('/src/network.ts');const {rng}=await import('/src/map/geo.ts');
const ll=d.dev.toLonLat(c.hit.x+80,c.hit.y+80);await t.go([ll[1],ll[0]]);t.paused=true;
await t.camera({at:[c.hit.ll[1],c.hit.ll[0]],height:48,tilt:0,heading:0});
const saved={agents:d.traffic.agents,spawn:d.traffic.spawn,buses:d.traffic.buses,signals:d.traffic.signals,people:d.crowd.people};
d.traffic.agents=[];d.traffic.spawn=()=>null;d.traffic.buses=()=>{};d.traffic.signals=null;d.crowd.people=[];
let oldCar;
const results=[];let matchTime=0;
try{
 for(const baseline of [true,false]){
  d.traffic.agents=[];
  if(baseline){oldCar=t.car(c.hit.type,{at:[c.hit.ll[1],c.hit.ll[0]],ahead:0,heading:90-c.hit.h*180/Math.PI});if(Math.hypot(oldCar.x-c.hit.x,oldCar.y-c.hit.y)>.05)throw Error('Baseline car was relocated');}
  else{const i=d.loose.indexOf(oldCar);if(i>=0)d.loose.splice(i,1);}
  const route=new Route(d.drive,c.e,c.start,()=>0,c.type==='bus');route.follow([c.f]);
  const p=route.leg.path.at(route.s),car=new Car(c.type,rng(12),p.x,p.y,p.ang);car.mode='traffic';car.grounded=true;
  const agent={car,route,speed:4.5,stuck:0,jam:0,ignore:0,cruise:1,off:0,hired:true};d.traffic.agents.push(agent);
  let gap=Infinity,oldGap=Infinity,elapsed=0,maxIgnore=0,shot=false,parkedChecked=0;
  const parked=d.loose.filter(q=>q.mode==='loose'&&Math.hypot(q.vx,q.vy)<.3&&Math.hypot(q.x-c.hit.x,q.y-c.hit.y)<55);
  if(baseline)await t.shot('parking-corner-before');
  while(elapsed<45&&!route.ended&&!(route.leg.edge===c.f&&route.s>Math.min(c.f.path.length-1,c.trim+8))){
   await t.wait(.1);elapsed+=.1;maxIgnore=Math.max(maxIgnore,agent.ignore);
   const moving=car.circles();
   for(const q of parked){if(q.mode!=='loose')continue;parkedChecked++;for(const[x,y]of q.circles())for(const[a,b]of moving){const v=Math.hypot(x-a,y-b)-q.r-car.r;gap=Math.min(gap,v);if(q===oldCar)oldGap=Math.min(oldGap,v);}}
   if(baseline&&!shot&&oldGap<-.2){matchTime=elapsed;await t.shot('parking-corner-overlap-before');shot=true;}
   if(!baseline&&!shot&&elapsed>=matchTime){await t.shot('parking-corner-overlap-after');shot=true;}
  }
  results.push({baseline,gap,oldGap,elapsed,maxIgnore,completed:route.leg.edge===c.f,parkedChecked,position:{x:car.x,y:car.y},actorDamage:car.damage,matchTime});
  d.traffic.agents=[];
 }
}finally{
 if(oldCar){const i=d.loose.indexOf(oldCar);if(i>=0)d.loose.splice(i,1);}
 Object.assign(d.traffic,{agents:saved.agents,spawn:saved.spawn,buses:saved.buses,signals:saved.signals});d.crowd.people=saved.people;
}
return {map:{area:d.world.area,built:d.world.index.built},corner:c.hit,route:{in:c.e.id,out:c.f.id,names:[c.e.name,c.f.name],type:c.type},camera:{at:[c.hit.ll[1],c.hit.ll[0]],height:48,tilt:0,heading:0},results};
