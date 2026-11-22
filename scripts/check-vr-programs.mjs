// Real WebGL program reuse across ground-material retirement, without a headset.
import { spawnSync } from 'node:child_process';
const at=process.argv.indexOf('--url'),url=at<0?'http://localhost:5191/':process.argv[at+1];
const check=`(async()=>{
 const d=__drive,r=d.renderer;
 const assert=(ok,msg)=>{if(!ok)throw Error(msg)};
 assert(!r.backend&&d.tilePrograms,'VR uses the retained WebGL tile-program cache');
 const path=performance.getEntriesByType('resource').find(e=>new URL(e.name).pathname==='/src/surface.ts').name;
 const {Surfaces}=await import(path),programs=[],before=d.tilePrograms.size;
 for(let i=0;i<3;i++){
  const surface=new Surfaces([{order:-999,color:'#666666',pattern:'asphalt',geometry:{position:new Float32Array([0,0,0,1,0,0,0,0,-1]),normal:new Float32Array([0,1,0,0,1,0,0,1,0]),index:new Uint32Array([0,1,2])}}]);
  const material=surface.group.children[0].material;
  material.customProgramCacheKey=()=> 'vr-ground-retention-check';
  d.scene.add(surface.group);r.compile(d.scene,d.camera);
  const props=r.properties.get(material),compiled=[...props.programs.values()];
  assert(compiled.length===1,'one program for the fixture');programs.push(compiled[0]);
  d.scene.remove(surface.group);surface.dispose();
 }
 assert(programs.every(p=>p===programs[0]),'retiring a tile does not force a new shader program');
 assert(d.tilePrograms.size===before+1,'duplicate programs retain only one material owner');
 return 'VR WebGL shader-program reuse and owner count passed';
})()`;
const run=spawnSync(process.execPath,['scripts/bench.mjs','--url',url,'--scenes','stand','--graphics','lowest','--dpr','1','--seconds','1','--settle','3','--extra','&vr','--eval',check],{encoding:'utf8'});
process.stdout.write(run.stdout||'');process.stderr.write(run.stderr||'');
if(run.status!==0||/console:|page error:/.test(run.stderr||''))process.exit(run.status||1);
