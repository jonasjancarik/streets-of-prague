import {readFileSync,writeFileSync} from 'node:fs';
const out='docs/evidence/lamp-wrap/';
const call=async body=>{const r=await fetch('http://127.0.0.1:5315/',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});return r.json()};
const before=[];
for(const name of ['ambulance','boat-boarding','bridge-exit','bus-displays','fire-brigade','fire-driver','heli-bridge']){
 const r=await call({cmd:'run',name});before.push({name,response:r});writeFileSync(out+'predecessors.json',JSON.stringify(before,null,2)+'\n');console.log(name,r.value?.pass,r.value?.error||'');
}
const install=await call({cmd:'eval',code:readFileSync(out+'observe-lamp.js','utf8')});writeFileSync(out+'provenance.json',JSON.stringify(install,null,2)+'\n');
const result=await call({cmd:'run',name:'lamp-knock'});
const trace=await call({cmd:'eval',code:'return window.__lampTrace'});
writeFileSync(out+'first-lamp.json',JSON.stringify({result,trace},null,2)+'\n');console.log('lamp',JSON.stringify(result.value));
await call({cmd:'eval',code:'window.__restoreLampTrace();return true;'});
