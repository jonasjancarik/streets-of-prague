import ast,hashlib,json,pickle,zlib
from pathlib import Path
import numpy as np
import shapely
from shapely.geometry import Polygon,LineString,box
from shapely.ops import unary_union
import structures,ipr_terrain,dtm_heights,layers
root=Path('/Users/janca/.codex/worktrees/overnight-city-integration/streets-of-prague');out=Path('/tmp/mrazovka-harmonic-review');layer=root/'pipeline/.cache/layers/centrum';meta=json.load(open(layer/'meta.json'));N,step=ipr_terrain.grid_step(meta['tile']);T=meta['tile'];gx0,gy0=-meta['origin'][0],-meta['origin'][1];crs=meta['crs']
def source_function(p,name):
 s=p.read_text();node=next(n for n in ast.parse(s).body if isinstance(n,ast.FunctionDef) and n.name==name);return ast.get_source_segment(s,node)
assert source_function(Path(ipr_terrain.__file__),'read_sheet')==source_function(root/'pipeline/ipr_terrain.py','read_sheet')
inputs={};data={};ways=[]
for kind in ['ground','streets']:
 for p in sorted((layer/kind).glob('*.json')):
  raw=p.read_bytes();inputs[str(p)]=hashlib.sha256(raw).hexdigest();v=json.loads(raw);ways+=v.get('structures',[])
  for k,t in v['tiles'].items():data.setdefault(tuple(map(int,k.split('_'))),{}).update(t)
index=json.loads((root/'public/data/centrum_now/index.json').read_text())
for row in index['tiles']:data.setdefault((row[0],row[1]),{})
tiles={k:np.full((N+1,N+1),np.nan,np.float32) for k in data};boxes={k:box(*[round(v,2) for v in layers.tile_box(meta,*k)]) for k in data}
for p in sorted((root/'pipeline/.cache/ipr/parsed').glob(f'TER*_{zlib.crc32(crs.encode()):08x}.pkl')):
 raw=p.read_bytes();inputs[str(p)]=hashlib.sha256(raw).hexdigest();v=pickle.loads(raw);assert v['key'][4:]==[crs,gx0,gy0,step]
 gi0,gj0,sub,*_=v['grid'];gi1,gj1=gi0+sub.shape[1]-1,gj0+sub.shape[0]-1
 for (i,j),a in tiles.items():
  ci,cj=i*N,j*N;a0,a1=max(ci,gi0),min(ci+N,gi1);b0,b1=max(cj,gj0),min(cj+N,gj1)
  if a0>a1 or b0>b1:continue
  part=sub[b0-gj0:b1-gj0+1,a0-gi0:a1-gi0+1];view=a[b0-cj:b1-cj+1,a0-ci:a1-ci+1];ok=~np.isnan(part);view[ok]=part[ok]
ipr_terrain.fill_gaps(tiles,N,T,step)
water=[];by_water=[];driven=[]
for t in data.values():
 water.extend(Polygon(p[0],p[1:]).buffer(0) for p in t.get('areas',{}).get('water',[]))
 if t.get('areas',{}).get('water'):
  for kind in ['road','sett','path','dirt']:
   rows=[Polygon(p[0],p[1:]) for p in t.get('roads',{}).get(kind,[])];by_water+=rows
   if kind in ['road','sett']:driven+=rows
survey=dtm_heights.apply('centrum',tuple(meta['bbox_wgs84']),ipr_terrain.krovak_to_local(crs),tiles,N,step,gx0,gy0,unary_union(water) if water else None,boxes,by_water,[(LineString(w['pts']),w['w']) for w in ways if w['kind']=='tunnel' and len(w['pts'])>1],ipr_terrain.kept_places(crs),driven,False,True,False)
merged=structures.merge_ways(ways);net=structures.Net(merged);comp=structures.components(net);target=next(w for w in merged if w['id']==362654528);c=comp[net.key['n',target['nodes'][0]]];selected=[w for w in merged if comp[net.key['n',w['nodes'][0]]]==c]
coords=np.concatenate([w['pts'] for w in selected]);minx,miny=coords.min(axis=0)-15;maxx,maxy=coords.max(axis=0)+15;needed={k for k,b in boxes.items() if b.intersects(box(minx,miny,maxx,maxy))}
p=root/'pipeline/.cache/ipr/parsed'/f'mosty_{zlib.crc32(crs.encode()):08x}.pkl';raw=p.read_bytes();inputs[str(p)]=hashlib.sha256(raw).hexdigest();v=pickle.loads(raw);assert v['key'][1]==crs;decks={k:a for k,a in v['decks'].items() if minx<=k[0]<=maxx and miny<=k[1]<=maxy}
record={'ways':selected,'tiles':{k:tiles[k] for k in needed},'labels':{k:survey['labels'][k] for k in needed},'boxes':{k:tuple(boxes[k].bounds) for k in needed},'decks':decks,'meta':meta,'N':N,'step':step,'gx0':gx0,'gy0':gy0}
with open(out/'clean-region.pkl','wb') as f:pickle.dump(record,f)
(out/'clean-input-provenance.json').write_text(json.dumps({'input_sha256':inputs,'tile_count_reconstructed':len(tiles),'region_tiles':sorted(needed),'ways':[w['id'] for w in selected],'deck_cells':len(decks),'clean':'after full-area survey, before structure solving, pads and final ground pull','no_exports_written':True,'survey':{k:v for k,v in survey.items() if k not in ['labels','terraces']}},indent=2)+'\n')
print('CLEAN INPUTS',len(tiles),'region tiles',len(needed),'ways',len(selected),'deck cells',len(decks),flush=True)
