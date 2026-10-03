import sys,json,runpy,pickle
from pathlib import Path
import numpy as np
import dtm_heights,structures,layers,build_cache
root=Path('/tmp/plain-support-source-diagnosis'); stages=[]; active={}; labels={}; pads=[]; decks=[]; found={}
points=[('2_0',(2,0),62,7),('3_0',(3,0),0,7),('2_0',(2,0),62,8),('3_0',(3,0),0,8)]
def snapshot(name):
 rows=[]
 for tile,key,x,y in points:
  a=active.get(key)
  if a is not None: rows.append({'tile':tile,'xindex':x,'yindex':y,'asl':float(a[y,x]),'label':int(labels[key][y,x]) if key in labels else None})
 stages.append({'stage':name,'points':rows})
 if name == 'after_pads_before_pull':
  with open(root/'pre-pull.pkl','wb') as f:pickle.dump({'tiles':{k:v.copy() for k,v in active.items()},'labels':{k:v.copy() for k,v in labels.items()},'found':found},f)
old_apply=dtm_heights.apply
def apply(*args,**kwargs):
 active.update(args[3]); snapshot('before_survey')
 got=old_apply(*args,**kwargs);labels.update(got['labels']);snapshot('after_survey')
 with open(root/'survey-grids.pkl','wb') as f:pickle.dump({'tiles':{k:v.copy() for k,v in active.items()},'labels':{k:v.copy() for k,v in labels.items()}},f)
 return got
dtm_heights.apply=apply
old_build=structures.build
def build(*args,**kwargs):
 got=old_build(*args,**kwargs);found.update(got);snapshot('after_structure_build')
 for tile,key,x,y in points:
  for level,kind,h,polys in got.get(key,[]):
   decks.append({'tile':tile,'xindex':x,'yindex':y,'level':level,'kind':kind,'asl':float(h[y,x]) if np.isfinite(h[y,x]) else None})
 return got
structures.build=build
old_pads=structures.pads
def pad_items(*args,**kwargs):
 snapshot('before_pads')
 for pad,h in old_pads(*args,**kwargs):
  pads.append({'bounds':list(pad.bounds),'asl':float(h)})
  yield pad,h
 snapshot('after_pads_before_pull')
structures.pads=pad_items
old_write=layers.write_bin
def write(folder,name,raw,payloads):
 if name.endswith('.height.bin'): snapshot('final_export_'+name)
 return old_write(folder,name,raw,payloads)
layers.write_bin=write
processing=[build_cache.code_key(),build_cache.runtime_key()]
sys.argv=['ipr_terrain.py','ujezd','--jobs','1','--no-assemble']
try:runpy.run_path(str(Path(layers.__file__).parent/'ipr_terrain.py'),run_name='__main__')
finally:(root/'fresh-stages.json').write_text(json.dumps({'processing':processing,'stages':stages,'pads':pads,'decks':decks},indent=2)+'\n')
