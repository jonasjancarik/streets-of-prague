// Exercise the complete subdivision/cutting/draping path, not only the cut helper.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { groundLayers } from '../src/ground.ts';
import { edgeHeightSampler, conformTerrainEdges } from '../src/terrain-edges.ts';

const leftPolys=[[[[3,0],[8,0],[8,3.1],[4,6],[3,6]]]],rightPolys=[[[[8,0],[16,0],[16,4],[10,4],[8,3.1]]]];
const H=(x,y,label)=>.1*y*y+(label?3:0);
function build(box,polys,label=1) {
  const d={areas:label===1?{water:polys}:{},roads:{},rails:[]};
  return groundLayers(d,{box,height:H,steps:[{label,polys}]}).layers.find(l=>l.base).geometry;
}
function edges(geometry,x=8,vertical=true) {
  const out=[],p=geometry.position,idx=geometry.index;
  for(let k=0;k<idx.length;k+=3)for(let e=0;e<3;e++) {
    let a=idx[k+e],b=idx[k+(e+1)%3];
    const normal=i=>vertical?p[i*3]:-p[i*3+2],along=i=>vertical?-p[i*3+2]:p[i*3];
    if(Math.abs(normal(a)-Math.fround(x))>1e-6||Math.abs(normal(b)-Math.fround(x))>1e-6)continue;
    if(along(a)>along(b))[a,b]=[b,a];
    const y0=along(a),y1=along(b);
    if(y1-y0>1e-7)out.push({y0,y1,h0:p[a*3+1],h1:p[b*3+1]});
  }
  return out.sort((a,b)=>a.y0-b.y0||a.h0-b.h0);
}
function height(edges,y) {
  const e=edges.find(e=>e.y0<y&&e.y1>y);
  assert.ok(e,`no rendered edge at y=${y}`);
  return e.h0+(e.h1-e.h0)*(y-e.y0)/(e.y1-e.y0);
}
function check(left,right) {
  const a=edges(left),b=edges(right);
  const positions=es=>[...new Set(es.flatMap(e=>[e.y0,e.y1]))].sort((a,b)=>a-b);
  assert.deepEqual(positions(a),positions(b),'pre-cut subdivision disagrees across the tile edge');
  for(let y=.173;y<8;y+=.193) {
    if(Math.abs(y-3.1)<1e-4)continue;
    assert.ok(Math.abs(height(a,y)-height(b,y))<1e-6,`rendered seam at y=${y}`);
  }
  return {positions:positions(a),gapAt5:Math.abs(height(a,5)-height(b,5))};
}
test('groundLayers keeps independently clipped shoreline meshes joined over curved terrain',()=>{
  const result=check(build([0,0,8,8],leftPolys),build([8,0,16,8],rightPolys));
  assert.equal(result.gapAt5,0);
  console.log('integrated shoreline seam:',JSON.stringify(result));
});
test('groundLayers edge refinement agrees with reversed rings and different local terrace labels',()=>{
  const reversed=rightPolys.map(rings=>rings.map(ring=>ring.slice().reverse()));
  check(build([0,0,8,8],leftPolys,2),build([8,0,16,8],reversed,3));
});
test('a one-sided outline touching the edge does not create a curved-terrain gap',()=>{
  const tangent=[[[[8,3.1],[11,1.1],[11,5.1]]]];
  const a=edges(build([0,0,8,8],[])),b=edges(build([8,0,16,8],tangent));
  for(let y=.173;y<8;y+=.193) assert.ok(Math.abs(height(a,y)-height(b,y))<1e-6,`one-sided contact gap at ${y}`);
});
test('world-aligned perimeter stations join meshes with shifted tile endpoints',()=>{
  const shift=polys=>polys.map(rings=>rings.map(ring=>ring.map(([x,y])=>[x,y+.5])));
  const a=edges(build([0,.5,8,8.5],shift(leftPolys))),b=edges(build([8,.5,16,8.5],shift(rightPolys)));
  for(let y=.673;y<8.5;y+=.193) assert.ok(Math.abs(height(a,y)-height(b,y))<1e-6,`shifted seam at ${y}`);
});
test('Float32 uploads at large map coordinates retain a shared edge profile',()=>{
  const offset=10000, water=[[[[8,3.1+offset],[11,1.1+offset],[11,5.1+offset]]]];
  const h=(x,y,side)=>.1*(y-offset)**2+(side?3:0);
  const make=(box,water)=>groundLayers({areas:{water},roads:{},rails:[]},{box,height:h,steps:[{label:1,polys:water}]}).layers.find(l=>l.base).geometry;
  const a=edges(make([0,offset,8,offset+8],[])),b=edges(make([8,offset,16,offset+8],water));
  for(let y=offset+.173;y<offset+8;y+=.193)assert.ok(Math.abs(height(a,y)-height(b,y))<1e-6,`uploaded seam at ${y}`);
});
test('perimeter refinement preserves winding, sides, alpha, and interior density',()=>{
  const pos=[0,0,0,8,0,0,0,0,-8,8,0,-8],idx=[0,1,2,1,3,2],alpha=[0,8,8,16],side=[2,2,2,2];
  const out=conformTerrainEdges(pos,idx,alpha,side,[0,0,8,8],2);
  let area=0;
  for(let k=0;k<out.idx.length;k+=3){
    const [a,b,c]=out.idx.slice(k,k+3).map(i=>[out.pos[i*3],-out.pos[i*3+2]]);
    const signed=((b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]))/2;
    assert.ok(signed>0);area+=signed;
  }
  assert.ok(Math.abs(area-64)<1e-10);
  out.extra.forEach((v,i)=>assert.ok(Math.abs(v-(out.pos[i*3]-out.pos[i*3+2]))<1e-7));
  assert.ok(out.side.every(v=>v===2));
  const inside=conformTerrainEdges([1,0,-1,3,0,-1,1,0,-3],[0,1,2],null,null,[0,0,8,8],2);
  assert.equal(inside.pos.length,9);assert.deepEqual(inside.idx,[0,1,2]);
});
test('edge height profile preserves flat steps and raw interior samples',()=>{
  const raw=(x,y,side)=>side?7:.1*y*y;
  const h=edgeHeightSampler(raw,[0,0,8,8],2);
  assert.equal(h(8,3.1,2),7);
  assert.equal(h(7,3.1,0),raw(7,3.1,0));
  assert.equal(h(8,0,0),Math.fround(raw(8,0,0)));assert.equal(h(8,8,0),Math.fround(raw(8,8,0)));
});
test('Float32 rounding near fractional tile ends never samples beyond the tile',()=>{
  const lo=10000.37,hi=10007.999999;
  const raw=(x,y)=>{assert.ok(y>=lo&&y<=hi,`sample outside tile: ${y}`);return .1*(y-lo)**2;};
  const h=edgeHeightSampler(raw,[0,lo,8,hi],2);
  assert.ok(Number.isFinite(h(8,hi-.00001,0)));
});

test('horizontal neighbouring tiles use the same curved edge profile',()=>{
  const swap=polys=>polys.map(rings=>rings.map(ring=>ring.map(([x,y])=>[y,x])));
  const h=(x,y,side)=>.1*x*x+(side?3:0);
  const make=(box,water)=>groundLayers({areas:{water},roads:{},rails:[]},{box,height:h,steps:[{label:1,polys:water}]}).layers.find(l=>l.base).geometry;
  const a=edges(make([0,0,8,8],swap(leftPolys)),8,false),b=edges(make([0,8,8,16],swap(rightPolys)),8,false);
  for(let x=.173;x<8;x+=.193)assert.ok(Math.abs(height(a,x)-height(b,x))<1e-6,`horizontal seam at ${x}`);
});
