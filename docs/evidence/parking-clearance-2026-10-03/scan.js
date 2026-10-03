const d=window.__drive;
t.paused=true;t.time('14:00');t.weather('clear');
await t.go([50.0804111143,14.4181439757]);
t.paused=true;
const old=await import('/src/parkingBaseline.ts');
const net=await import('/src/network.ts');
const geo=await import('/src/map/geo.ts');
const {parkingClearance}=await import('/src/parkingClearance.ts');
const hits=[];let baselineCount=0,currentCount=0;
for(const [key,tile]of d.world.loaded){
 const data=await d.world.fetchJSON(key),edges=d.world.driveBy.get(key)||[];
 const clearanceEdges=await d.world.parkingEdges(data),clear=parkingClearance(clearanceEdges,data.box);
 const [x0,y0,x1,y1]=data.box,inside=(x,y)=>x>=x0&&x<x1&&y>=y0&&y<y1;
 const cars=old.parkCars({data,edges,zones:new old.Zones({sections:(data.sections||[]).map(z=>({...z,inside:z.share}))}),r:geo.rng(Math.floor(geo.hash(`centrum/${key}`)*1e9)),shares:new Map((data.sections||[]).map(s=>[s.code,s.share])),inside,solid:(x,y)=>inside(x,y)?tile.grid.at(x,y)!==0:false}).cars;
 baselineCount+=cars.length;currentCount+=tile.cars.length;
 for(const c of cars){
  if(c.circles().every(([x,y])=>clear(x,y,c.r)))continue;
  hits.push({tile:key,x:c.x,y:c.y,h:c.h,type:c.type,distance:Math.hypot(c.x-d.walker.x,c.y-d.walker.y),ll:d.dev.toLonLat(c.x,c.y)});
 }
}
hits.sort((a,b)=>a.distance-b.distance);
window.__parkingHits=hits;
return{area:d.world.area,built:d.world.index.built,baselineCount,currentCount,hits};
