import {readFileSync,writeFileSync,readdirSync,existsSync} from 'node:fs';
import {join} from 'node:path';import {createHash} from 'node:crypto';import {execFileSync} from 'node:child_process';
const root=process.cwd(),out=join(root,'docs/evidence/wrapup-final-confirmation');
const expectedHead='edbf011ca44ef2dab1a8cb8747422a83ab586716',expectedBuilt='2026-10-03T05:44:19Z';
const head=()=>execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
const sourcePaths=execFileSync('git',['ls-files','src','scenarios','scripts/scene.mjs','package.json','package-lock.json','vite.config.js'],{encoding:'utf8'}).trim().split('\n').sort();
const digest=paths=>{const h=createHash('sha256');for(const p of paths){h.update(p+'\0');h.update(readFileSync(join(root,p)));h.update('\0')}return h.digest('hex')};
const mapDir=join(root,'public/data/centrum_now');
const walk=p=>readdirSync(p,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(join(p,e.name)):e.isFile()?[join(p,e.name).slice(root.length+1)]:[]);
const mapPaths=walk(mapDir).sort(),sourceHash=digest(sourcePaths),mapHash=digest(mapPaths);
const call=async body=>{const res=await fetch('http://127.0.0.1:5315/',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(180000)});return res.json()};
const snapshot=await call({cmd:'eval',code:`
window.__suiteSpawns=[];window.__suiteShots=[];
const car=t.car.bind(t),shot=t.shot.bind(t);
t.car=(type,opt)=>{const c=car(type,opt);window.__suiteSpawns.push({car:c,opt});return c};
t.shot=async name=>{window.__suiteShots.push({name,where:t.where(),snapshot:t.snapshot(),camera:t.cam?{...t.cam}:null});return shot(name)};
return {backend:window.__drive.renderer.backend?.isWebGPUBackend?'WebGPU':'WebGL',built:(await fetch('data/centrum_now/index.json').then(r=>r.json())).built,where:t.where(),url:location.href};`});
if(head()!==expectedHead||snapshot.value?.built!==expectedBuilt||snapshot.value?.backend!=='WebGPU')throw new Error('Unexpected source, map or renderer');
const report={started:new Date().toISOString(),head:expectedHead,sourceCommit:'edbf011ca44ef2dab1a8cb8747422a83ab586716',sourceHash,mapHash,mapFiles:mapPaths.length,sourceFiles:sourcePaths.length,initial:snapshot,cases:[]};
const save=()=>writeFileSync(join(out,'results.json'),JSON.stringify(report,null,2)+'\n');save();
const batchDeadline=Date.now()+10*60*1000;
const names=readdirSync(join(root,'scenarios')).filter(f=>f.endsWith('.ts')).map(f=>f.slice(0,-3)).sort();
for(const name of names){
 if(existsSync('/tmp/streets-overnight-quota-stop')){report.stopReason='shared quota stop';break;}
 if(Date.now()>batchDeadline){report.stopReason='finite batch cutoff';break;}
 if(head()!==expectedHead||digest(sourcePaths)!==sourceHash){report.stopReason='source changed';break;}
 await call({cmd:'eval',code:'window.__suiteSpawns=[];window.__suiteShots=[];return true;'});
 let response;
 try{response=await call({cmd:'run',name});}catch(e){report.stopReason='request failure: '+e.message;save();break;}
 const observations=await call({cmd:'eval',code:`const d=window.__drive,m=d.car||d.heli||d.walker;
 return {where:t.where(),camera:{position:d.camera.position,fov:d.camera.fov,aspect:d.camera.aspect,free:t.cam},shots:window.__suiteShots,
 spawns:window.__suiteSpawns.map(({car:c,opt})=>({type:c.type,x:c.x,y:c.y,h:c.h,speed:c.speed,damage:c.damage,standing:t.standing(c),opt,distance:Math.hypot(c.x-m.x,c.y-m.y)}))};`});
 report.cases.push({name,response,observations});save();
 const s=response.value;
 console.log((s?.pass&&!response.error&&!response.errors?.length?'PASS ':'FAIL ')+name+' '+JSON.stringify({error:s?.error||response.error,failed:s?.checks?.filter(c=>!c.pass),pageErrors:response.errors}));
}
report.finished=new Date().toISOString();report.expectedCases=names.length;
report.finalHead=head();report.finalSourceHash=digest(sourcePaths);report.finalMapHash=digest(mapPaths);
report.immutable=report.finalHead===expectedHead&&report.finalSourceHash===sourceHash&&report.finalMapHash===mapHash;
report.passed=report.cases.filter(c=>c.response.value?.pass&&!c.response.error&&!c.response.errors?.length).length;
report.failed=report.cases.length-report.passed;save();
console.log(JSON.stringify({passed:report.passed,failed:report.failed,run:report.cases.length,expected:names.length,immutable:report.immutable,stop:report.stopReason}));
