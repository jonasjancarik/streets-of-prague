const d=window.__drive,tileWorld=d.world;
const {Route}=await import('/src/network.ts');
const {Traffic}=await import('/src/traffic.ts');
const {Car}=await import('/src/car.ts');
const {rng}=await import('/src/map/geo.ts');
const Scene=d.scene.constructor;
const candidates=window.__parkingHits;
for(const hit of candidates){
 const parked=new Car(hit.type,rng(9),hit.x,hit.y,hit.h),pc=parked.circles();
 for(const e of d.drive.edges){
  if(e.bridge||e.tunnel||e.path.length<16)continue;
  const end=e.path.at(e.path.length);
  if(Math.hypot(end.x-hit.x,end.y-hit.y)>25)continue;
  const all=d.drive.out.get(e.v)||[],opts=all.filter(f=>f!==e.twin&&!f.bridge&&!f.tunnel);
  for(const f of opts)for(const type of ['pickup','bus']){
   const trim=Math.min(type==='bus'?11:7,e.path.length/3,f.path.length/3);
   const start=Math.max(0,e.path.length-trim-8),route=new Route(d.drive,e,start,()=>0,type==='bus');route.follow([f]);
   const p=route.leg.path.at(route.s),car=new Car(type,rng(12),p.x,p.y,p.ang),traffic=new Traffic(d.drive,new Scene(),rng(12),0);
   car.mode='traffic';traffic.agents.push({car,route,speed:4.5,stuck:0,jam:0,ignore:0,cruise:1,off:0});
   let gap=Infinity,closest=null,steps=0;
   while(steps++<1500&&!route.ended&&!(route.leg.edge===f&&route.s>Math.min(f.path.length-1,trim+8))){
    traffic.update(1/60,()=>[]);
    for(const[a,b]of car.circles())for(const[x,y]of pc){const value=Math.hypot(a-x,b-y)-car.r-parked.r;if(value<gap){gap=value;closest={x:car.x,y:car.y,h:car.h,s:route.s,step:steps};}}
   }
   if(gap<-.05){window.__parkingCase={hit,e,f,type,start,trim,gap,closest};return{hit,route:{in:e.id,out:f.id,names:[e.name,f.name],type,start,trim},gap,closest};}
  }
 }
}
return{found:false,candidates:candidates.length};
