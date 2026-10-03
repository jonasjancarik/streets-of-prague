import{readFileSync,writeFileSync,readdirSync}from'node:fs';import{join}from'node:path';import{createHash}from'node:crypto';import{execFileSync}from'node:child_process';
const root=process.cwd(),out='/tmp/tow-fixture-wrapup-evidence',port=5317;
const hash=paths=>{const h=createHash('sha256');for(const p of paths){h.update(p+'\0');h.update(readFileSync(join(root,p)));h.update('\0')}return h.digest('hex')};
const sourcePaths=execFileSync('git',['ls-files','src','scenarios','scripts/scene.mjs'],{encoding:'utf8'}).trim().split('\n').sort();
const walk=p=>readdirSync(join(root,p),{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(p+'/'+e.name):e.isFile()?[p+'/'+e.name]:[]);
const mapPaths=walk('public/data/centrum_now').sort(),sourceHash=hash(sourcePaths),mapHash=hash(mapPaths);
const expectedMapHash='d57d814798fe4cd7c99a79d34c4cc6daac9b6c08f581b9780cf64ece53c4df52';
if(mapHash!==expectedMapHash)throw Error('Private map differs from immutable final suite');
const call=async body=>{const response=await fetch(`http://127.0.0.1:${port}/`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(180000)});const r=await response.json();if(r.error||r.errors?.length)throw Error(JSON.stringify(r));return r;};
const report={base:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),sourceHash,mapHash,mapFiles:mapPaths.length,started:new Date().toISOString(),cases:[]};
for(const context of ['standalone-1','standalone-2','after-wall-crash']){
 if(hash(sourcePaths)!==sourceHash)throw Error('Source changed mid-batch');
 await call({cmd:'eval',code:"setTimeout(()=>location.reload(),0);return 'reload';"});await new Promise(r=>setTimeout(r,350));
 const initial=(await call({cmd:'eval',code:`t.paused=true;const d=window.__drive;const i=await fetch('data/centrum_now/index.json').then(r=>r.json());return {backend:d.renderer.backend?.isWebGPUBackend?'WebGPU':'WebGL',built:i.built,pipeline:i.pipeline,url:location.href};`})).value;
 if(initial.backend!=='WebGPU'||initial.built!=='2026-10-03T05:44:19Z')throw Error('Wrong map or renderer');
 let preceding;
 if(context==='after-wall-crash')preceding=await call({cmd:'run',name:'wall-crash'});
 await call({cmd:'eval',code:`window.__towSpawns=[];const original=t.car.bind(t);t.car=(type,opt)=>{const c=original(type,opt);window.__towSpawns.push({car:c,opt,initial:{x:c.x,y:c.y,h:c.h,view:t.carView(c)}});return c;};return true;`});
 const response=await call({cmd:'run',name:'wreck-tow'});
 const observations=(await call({cmd:'eval',code:`const d=window.__drive;return {where:t.where(),camera:{position:d.camera.position.toArray(),fov:d.camera.fov,aspect:d.camera.aspect,free:t.cam},spawns:window.__towSpawns.map(s=>({opt:s.opt,initial:s.initial,final:{x:s.car.x,y:s.car.y,speed:s.car.speed,standing:t.standing(s.car),view:t.carView(s.car)}}))};`})).value;
 report.cases.push({context,initial,preceding,response,observations});writeFileSync(out+'/results.json',JSON.stringify(report,null,2)+'\n');
 console.log(context+': '+(response.value?.pass?'PASS':'FAIL')+' '+JSON.stringify(response.value?.checks));
 if(!response.value?.pass)throw Error('Focused tow failed in '+context);
}
report.finished=new Date().toISOString();report.immutable=hash(sourcePaths)===sourceHash&&hash(mapPaths)===mapHash;
if(!report.immutable)throw Error('Source/map changed');
writeFileSync(out+'/results.json',JSON.stringify(report,null,2)+'\n');
