import ast,copy,json,pickle
from pathlib import Path
import numpy as np
from shapely.geometry import LineString,Point
import structures,ipr_terrain
out=Path('/tmp/mrazovka-harmonic-review');c=pickle.load(open(out/'clean-region.pkl','rb'));ground=ipr_terrain.sampler(c['tiles'],c['N'],c['meta']['tile'],c['step'],c['gx0'],c['gy0'],c['labels']);current=structures.Net.spread
methods=[]
for name,file in [('legacy','before-structures.py'),('unconstrained','unconstrained-harmonic.py')]:
 source=ast.parse((out/file).read_text());cls=next(n for n in source.body if isinstance(n,ast.ClassDef) and n.name=='Net');fn=next(n for n in cls.body if isinstance(n,ast.FunctionDef) and n.name=='spread');env=dict(structures.__dict__);exec(compile(ast.Module(body=[fn],type_ignores=[]),file,'exec'),env);methods.append((name,env['spread']))
methods.append(('corrected',current));results=[];heights={};cases=json.load(open('/Users/janca/.codex/worktrees/overnight-city-integration/streets-of-prague/docs/evidence/overnight-harmonic-combined/mrazovka-final.json'))['samples']
for name,method in methods:
 structures.Net.spread=method;ways=copy.deepcopy(c['ways']);net,profiles=structures.solve(ways,ground,c['decks']);kept,kp=structures.drop_shallow(ways,net,profiles,ground);heights[name]=net.h.copy();depth=ground(net.xy[:,0],net.xy[:,1])-net.h
 target=next(i for i,w in enumerate(ways) if w['id']==362654528);ls=LineString(ways[target]['pts']);d,h=profiles[target];samples=[{'fraction':p['fraction'],'on_source_way':ls.distance(Point(p['x'],p['y']))<1,'profile_asl':float(np.interp(ls.project(Point(p['x'],p['y'])),d,h)) if np.isfinite(np.interp(ls.project(Point(p['x'],p['y'])),d,h)) else None}for p in cases]
 pieces,groups=structures.pieces(kept,kp,[],ground,c['decks'],None);structures.assign_levels(groups);rasters=structures.rasterise(pieces,c['tiles'],c['N'],c['meta']['tile'],c['step'],c['gx0'],c['gy0']);polys=structures.outlines_per_tile(pieces,{k:__import__('shapely').geometry.box(*b) for k,b in c['boxes'].items()})
 probes=[]
 for p in cases:
  x,y=p['x'],p['y'];i=int(np.floor((x-c['gx0'])/c['meta']['tile']));j=int(np.floor((y-c['gy0'])/c['meta']['tile']));level=[]
  for lv,ps in polys.get((i,j),{}).items():
   if any(__import__('shapely').geometry.Polygon(q[0],q[1:]).covers(Point(x,y)) for q in ps):
    a=rasters[i,j][lv];encoded=np.clip(np.round((np.nan_to_num(a,nan=100)-100)*100),0,65535).astype('<u2');a=np.where(encoded>0,encoded/100+100,np.nan);u=(x-c['gx0']-i*c['meta']['tile'])/c['step'];v=(y-c['gy0']-j*c['meta']['tile'])/c['step'];ia=min(c['N']-1,int(u));ja=min(c['N']-1,int(v));fu=u-ia;fv=v-ja;value=(a[ja,ia]*(1-fu)+a[ja,ia+1]*fu)*(1-fv)+(a[ja+1,ia]*(1-fu)+a[ja+1,ia+1]*fu)*fv;level.append({'level':lv,'height_asl':float(value) if np.isfinite(value) else None})
  probes.append({'fraction':p['fraction'],'levels':level,'ground_asl':float(ground(np.array([x]),np.array([y]))[0])})
 results.append({'mode':name,'finite_heights':int(np.isfinite(net.h).sum()),'max_depth':float(np.nanmax(depth)) if np.isfinite(depth).any() else None,'kept':[w['id'] for w in kept],'profile_probes':samples,'decoded_probes':probes})
structures.Net.spread=current
np.testing.assert_array_equal(heights['legacy'],heights['corrected']);report={'source_kind':'clean full-area survey before bridge pads and pull; six-way region with actual IPR faces','all_node_heights_match_legacy':True,'results':results};(out/'clean-comparison.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report,indent=2))
