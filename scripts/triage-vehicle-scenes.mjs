// Compare only the five failures from the vehicle full-suite run. This uses a
// separately launched, exclusively owned scene browser; it never launches one.
// node scripts/triage-vehicle-scenes.mjs --port 5305 --revision b3c22d5 --out report.json
import { readFileSync, writeFileSync } from 'node:fs';
import ts from 'typescript';
const option = (name, fallback) => { const i = process.argv.indexOf(name); return i < 0 ? fallback : process.argv[i + 1]; };
const port = Number(option('--port', '5305'));
const revision = option('--revision', 'unknown');
const out = option('--out', '/tmp/vehicle-scenes.json');
const call = async (body) => {
  const response = await fetch(`http://127.0.0.1:${port}/`, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(body) });
  return response.json();
};
const evalCode = async (code) => {
  const result = await call({cmd:'eval',code});
  if (result.error || result.errors?.length) throw new Error(JSON.stringify(result));
  return result.value;
};
// b3c22d5 predates the new police scenario/test helpers. Supply only those helpers
// as browser-side test instrumentation, keeping every baseline source file intact.
const adapters = `
const d=window.__drive;
if (!t.policeLights) t.policeLights=c=>d.police.lit(d.car).includes(c);
if (!t.policeCar) t.policeCar=()=>{
  const m=d.car||d.heli||d.walker;
  return [...d.police.cars.map(p=>p.car),...d.traffic.agents.map(a=>a.car)].filter(c=>c.type==='police'&&!c.burnt)
    .sort((a,b)=>Math.hypot(a.x-m.x,a.y-m.y)-Math.hypot(b.x-m.x,b.y-m.y))[0]||null;
};
if (!t.enter) t.enter=async c=>{
  if(d.car===c)return;
  if(t.where().mode!=='foot')d.enterOrExit();
  const m=d.car||d.heli||d.walker;
  m.x=c.x-Math.sin(c.h)*(c.spec.W/2+.6);m.y=c.y+Math.cos(c.h)*(c.spec.W/2+.6);
  d.enterOrExit();if(d.car!==c)throw new Error('Could not get into the car');
  await new Promise(requestAnimationFrame);return c;
};
`;
const policeSource = ts.transpileModule(readFileSync(new URL('../scenarios/police-stolen-lights.ts',import.meta.url),'utf8'),
  {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText.replace('export default', 'return');
const airborne = `
await t.go('karlak');
if(!d.addChopper())throw new Error('No helicopter fixture');
const h=d.choppers.at(-1);d.walker.x=h.x+2;d.walker.y=h.y;d.enterOrExit();
if(d.heli!==h)throw new Error('Could not enter helicopter fixture');
h.z=h.height(h.x,h.y)+10;h.vx=h.vy=h.vz=0;
if(h.landed)throw new Error('Helicopter fixture must be airborne');
`;
let cases=[...['ambulance','lamp-knock','police-stolen-lights','wall-crash','wreck-tow'].map(name=>({name,fixture:'fresh'})),
  ...['lamp-knock','police-stolen-lights','wall-crash'].map(name=>({name,fixture:'airborne-helicopter'}))];
const selected=option('--cases','').split(',').filter(Boolean), fixture=option('--fixture','');
if(selected.length) cases=fixture?selected.map(name=>({name,fixture})):cases.filter(c=>selected.includes(c.name));
const report={revision,started:new Date().toISOString(),cases:[]};
for (const c of cases) {
  await evalCode(`setTimeout(()=>location.reload(),0);return 'reload';`);
  await new Promise(r=>setTimeout(r,300));
  const warm=/^warm-session-(\d+)$/.exec(c.fixture);
  const prepare=warm?`for(let i=0;i<${Number(warm[1])};i++){const c=t.car('hatch',{ahead:8});d.loose.splice(d.loose.indexOf(c),1);}`:c.fixture==='airborne-helicopter'?airborne:'';
  const initial=await evalCode(`t.paused=true;${adapters}${prepare}
    window.__triageShots=[];const shot=t.shot;t.shot=async name=>{
      window.__triageShots.push({name,situation:t.snapshot(),where:t.where(),camera:t.cam?{...t.cam}:null});await shot(name);
    };
    return {where:t.where(),helicopter:d.heli?{air:d.heli.air,landed:d.heli.landed}:null,
      backend:d.renderer.backend?.isWebGPUBackend?'WebGPU':'WebGL',built:(await fetch('data/centrum_now/index.json').then(r=>r.json())).built};`);
  if(initial.backend!=='WebGPU')throw new Error('Comparison requires WebGPU on both revisions');
  if(initial.built!=='2026-10-02T20:16:12Z')throw new Error('Unexpected comparison map build');
  let result;
  if(c.name==='police-stolen-lights') {
    result=await evalCode(`t.checks=[];const s=(new Function(${JSON.stringify(policeSource)}))();let error;
      try{await s.run(t);}catch(e){error=e.message;}
      return {name:${JSON.stringify(c.name)},checks:t.checks,error,pass:!error&&t.checks.length>0&&t.checks.every(c=>c.pass)};`);
  } else {
    const response=await call({cmd:'run',name:c.name});
    result=response.value||{error:response.error,pass:false};
    if(response.errors?.length)result.pageErrors=response.errors;
  }
  const shots=await evalCode('return window.__triageShots');
  report.cases.push({...c,initial,result,shots});
  writeFileSync(out,JSON.stringify(report,null,2)+'\n');
  console.log(`${revision} ${c.fixture} ${c.name}: ${result.pass?'PASS':'FAIL'} ${result.error||result.checks?.filter(c=>!c.pass).map(c=>c.name+' '+(c.detail||'')).join('; ')||''}`);
}
report.finished=new Date().toISOString();
writeFileSync(out,JSON.stringify(report,null,2)+'\n');
