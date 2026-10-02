// Node 22.18+ can run the TypeScript geometry helper directly; no browser or map needed.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TerrainStepIndex, cutTerrainSteps } from '../src/terrain-cut.ts';
import { onPolygons } from '../src/map/geo.ts';

const rect = (x0, y0, x1, y1) => [[x0,y0],[x1,y0],[x1,y1],[x0,y1]];
const square = (x0=0, y0=0, x1=8, y1=8) => ({
  pos: [x0,0,-y0,x1,0,-y0,x0,0,-y1,x1,0,-y1], idx: [0,1,2,1,3,2],
});
function cut(polys, at, input=square(), extra=null) {
  return cutTerrainSteps(input.pos, input.idx, extra, at, new TerrainStepIndex(polys));
}
function onOutline(x,y,polys) {
  for (const rings of polys) for (const ring of rings) for (let i=0;i<ring.length;i++) {
    const a=ring[i],b=ring[(i+1)%ring.length],dx=b[0]-a[0],dy=b[1]-a[1],len2=dx*dx+dy*dy;
    const t=((x-a[0])*dx+(y-a[1])*dy)/len2;
    if (t>=0&&t<=1&&Math.abs(dx*(y-a[1])-dy*(x-a[0]))<1e-6*Math.sqrt(len2)) return true;
  }
  return false;
}
function validate(out,at,polys,expected=64,sign=1) {
  const areas=new Map(); let total=0;
  assert.ok(out.pos.every(Number.isFinite));
  for (let k=0;k<out.idx.length;k+=3) {
    const ids=out.idx.slice(k,k+3), q=ids.map(i=>[out.pos[i*3],-out.pos[i*3+2]]);
    const area=((q[1][0]-q[0][0])*(q[2][1]-q[0][1])-(q[1][1]-q[0][1])*(q[2][0]-q[0][0]))/2;
    assert.ok(area*sign>1e-14,'winding or degenerate triangle');
    const label=out.side[ids[0]];
    assert.ok(ids.every(i=>out.side[i]===label),'triangle spans height labels');
    areas.set(label,(areas.get(label)??0)+Math.abs(area)); total+=Math.abs(area);
    for (let a=1;a<9;a++) for(let b=1;b<9-a;b++) {
      const x=(q[0][0]*a+q[1][0]*b+q[2][0]*(9-a-b))/9,y=(q[0][1]*a+q[1][1]*b+q[2][1]*(9-a-b))/9;
      if (!onOutline(x,y,polys)) assert.equal(at(x,y),label,'triangle crosses actual outline');
    }
  }
  assert.ok(Math.abs(total-expected)<1e-5,`area changed: ${total} vs ${expected}`);
  return areas;
}
function edge(out,x,height) {
  const edges=[];
  for(let k=0;k<out.idx.length;k+=3)for(let e=0;e<3;e++) {
    const a=out.idx[k+e], b=out.idx[k+(e+1)%3];
    if(Math.abs(out.pos[a*3]-x)>1e-6||Math.abs(out.pos[b*3]-x)>1e-6)continue;
    const ay=-out.pos[a*3+2],by=-out.pos[b*3+2];
    const label=out.side[a];
    edges.push([Math.min(ay,by),Math.max(ay,by),height(x,Math.min(ay,by),label),height(x,Math.max(ay,by),label),label]);
  }
  return edges;
}
function edgeHeight(edges,y) {
  const e=edges.find(e=>y>=e[0]-1e-8&&y<=e[1]+1e-8);
  assert.ok(e,`missing edge at ${y}`);
  // End heights are ordered by y in all generated triangles for the test below.
  return e[2]+(e[3]-e[2])*(y-e[0])/(e[1]-e[0]);
}

test('narrow enclosed terrace is cut even with every original corner on plain ground',()=>{
  const polys=[[rect(1.1,1.1,1.4,6)]],on=onPolygons(polys),at=(x,y)=>on(x,y)?2:0;
  const areas=validate(cut(polys,at),at,polys);
  assert.ok(Math.abs(areas.get(2)-1.47)<1e-6);
});
test('island and hole preserve both their areas and sides',()=>{
  const polys=[[rect(1,1,7,7),rect(2,2,6,6)]],on=onPolygons(polys),at=(x,y)=>on(x,y)?1:0;
  const areas=validate(cut(polys,at),at,polys);
  assert.ok(Math.abs(areas.get(1)-20)<1e-6);
});
test('three levels and overlapping outlines retain priority',()=>{
  const polys=[[rect(-1,-1,3,9)],[rect(-1,4,9,9)]];
  const at=(x,y)=>y>4?1:x<3?2:0;
  const areas=validate(cut(polys,at),at,polys);
  for(const [label,area] of [[1,32],[2,12],[0,20]]) assert.ok(Math.abs(areas.get(label)-area)<1e-6);
});
test('internal shared edge loses artificial extension vertices',()=>{
  const polys=[[rect(1.1,1.1,1.4,6)]],on=onPolygons(polys),at=(x,y)=>on(x,y)?2:0;
  const out=cut(polys,at); validate(out,at,polys);
  const diagonal=[];
  for(let i=0;i<out.pos.length/3;i++)if(Math.abs(out.pos[i*3]-out.pos[i*3+2]-8)<1e-6)diagonal.push([out.pos[i*3],-out.pos[i*3+2]]);
  assert.deepEqual(diagonal.sort((a,b)=>a[0]-b[0]),[[0,8],[8,0]]);
});
test('independently cut adjacent tiles agree on a nonlinear edge height field',()=>{
  // A tiny terrace wholly inside the left tile used to extend lines to x=8.
  const leftPolys=[[rect(1.1,1.1,1.4,6)]],on=onPolygons(leftPolys),at=(x,y)=>on(x,y)?2:0;
  const left=cut(leftPolys,at), right=cut([],at,square(8,0,16,8));
  validate(left,at,leftPolys); validate(right,at,[]);
  const height=(x,y,label)=>0.1*y*y+3*label;
  const a=edge(left,8,height), b=edge(right,8,height);
  // Compare endpoint sets and actual piecewise-linear rendered edge, not only sampler values.
  assert.deepEqual(a.map(e=>e.slice(0,2)),b.map(e=>e.slice(0,2)));
  for(let y=.1;y<8;y+=.37)assert.ok(Math.abs(edgeHeight(a,y)-edgeHeight(b,y))<1e-8);
});
test('separate clipped shoreline outlines meet at the same tile-edge position',()=>{
  const leftPolys=[[[[3,0],[8,0],[8,3.1],[4,6],[3,6]]]],rightPolys=[[[[8,0],[16,0],[16,4],[10,4],[8,3.1]]]];
  const leftOn=onPolygons(leftPolys),rightOn=onPolygons(rightPolys);
  const left=cut(leftPolys,(x,y)=>leftOn(x,y)?1:0),right=cut(rightPolys,(x,y)=>rightOn(x,y)?1:0,square(8,0,16,8));
  validate(left,(x,y)=>leftOn(x,y)?1:0,leftPolys);validate(right,(x,y)=>rightOn(x,y)?1:0,rightPolys);
  const endpoints=o=>[...new Set(edge(o,8,()=>0).flatMap(e=>e.slice(0,2).map(y=>+y.toFixed(7))))].sort((a,b)=>a-b);
  assert.deepEqual(endpoints(left),endpoints(right));
  assert.deepEqual(endpoints(left),[0,3.1,8]);
});
test('winding, duplicate endpoints, degenerate input and alpha interpolation',()=>{
  const polys=[[rect(1,1,2,2),rect(1,1,2,2).reverse()]],on=onPolygons([[rect(1,1,2,2)]]),at=(x,y)=>on(x,y)?2:0;
  const input=square(); input.idx=[0,2,1,1,2,3,0,0,0];
  const alpha=input.pos.filter((_,i)=>i%3===0).map((x,i)=>x-input.pos[i*3+2]);
  const out=cut(polys,at,input,alpha);validate(out,at,polys,64,-1);
  out.extra.forEach((a,i)=>assert.ok(Math.abs(a-(out.pos[i*3]-out.pos[i*3+2]))<1e-7));
});
test('unaffected triangles keep their density',()=>{
  const out=cut([],()=>0);validate(out,()=>0,[]);
  assert.equal(out.idx.length,6);assert.equal(out.pos.length,12);
});
test('curved dense shore produces only actual outline geometry',()=>{
  const ring=[[4,0],[8,0],[8,8],[4,8]];
  for(let i=95;i>0;i--)ring.push([4+Math.sin(i*1.5)*.45,8*i/96]);
  const polys=[[ring]],on=onPolygons(polys),at=(x,y)=>on(x,y)?1:0;
  const start=performance.now();const out=cut(polys,at);const ms=performance.now()-start;
  validate(out,at,polys);
  assert.ok(out.idx.length/3<500,'supporting-line arrangement leaked into output density');
  console.log(`dense shore: ${ring.length} outline vertices, ${out.idx.length/3} output triangles, ${ms.toFixed(1)} ms`);
});
test('tiny cut at large map coordinates keeps a stable area sign',()=>{
  const q=[[-512.8696875,458.7121875],[-514.436875,458.146875],[-513.69625,458.375625]];
  const ring=[q[0],[-512.869693010555,458.7121855122445],[-512.869692927834,458.71218528987634]];
  const polys=[[ring]],on=onPolygons(polys),at=(x,y)=>on(x,y)?3:0;
  const input={pos:q.flatMap(([x,y])=>[x,0,-y]),idx:[0,1,2]};
  const expected=((q[1][0]-q[0][0])*(q[2][1]-q[0][1])-(q[1][1]-q[0][1])*(q[2][0]-q[0][0]))/2;
  validate(cut(polys,at,input),at,polys,expected);
});
test('disconnected pieces touching only at a point remain valid',()=>{
  const polys=[[rect(1,1,3,3)],[rect(3,3,5,5)]],on=onPolygons(polys),at=(x,y)=>on(x,y)?2:0;
  const areas=validate(cut(polys,at),at,polys);
  assert.ok(Math.abs(areas.get(2)-8)<1e-6);
});
test('coincident cut vertices from overlapping meshes retain distinct alpha',()=>{
  const polys=[[rect(1,1,2,2)]],on=onPolygons(polys),at=(x,y)=>on(x,y)?2:0;
  const base=square(), input={pos:[...base.pos,...base.pos],idx:[...base.idx,...base.idx.map(i=>i+4)]};
  const out=cut(polys,at,input,[0,0,0,0,1,1,1,1]);
  validate(out,at,polys,128);
  for(let k=0;k<out.idx.length;k+=3) {
    const values=out.idx.slice(k,k+3).map(i=>out.extra[i]);
    assert.ok(values.every(a=>a===values[0]),'one triangle borrowed another mesh\'s alpha');
  }
});
