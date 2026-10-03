const d=window.__drive,w=d.world;t.paused=true;
const keys=['8_5','7_5'],oldUpdate=w.update;w.update=()=>{};
const signature=()=>Object.fromEntries(keys.map(key=>[key,w.loaded.get(key).cars.map(c=>[c.x,c.y,c.h,c.type,c.paint]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))]));
let ab,ba;
try {
 for(const key of keys)w.drop(key);
 for(const key of keys)await w.build(key,await w.fetchTile(key));ab=signature();
 for(const key of keys)w.drop(key);
 for(const key of [...keys].reverse())await w.build(key,await w.fetchTile(key));ba=signature();
}finally{w.update=oldUpdate;}
const same=keys.every(k=>JSON.stringify(ab[k])===JSON.stringify(ba[k]));
const positions=keys.flatMap(k=>ba[k].map(c=>`${c[0]}/${c[1]}`));
const duplicates=positions.length-new Set(positions).size;
const current=keys.map(k=>({tile:k,cars:w.loaded.get(k).cars.length,parkingMs:w.loaded.get(k).ms.parking}));
return{same,duplicates,current,backend:d.renderer.backend?.isWebGPUBackend?'webgpu':'webgl',built:w.index.built};
