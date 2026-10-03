import gzip,hashlib,json
from pathlib import Path
import numpy as np
ROOT=Path(__file__).resolve().parents[3];BEFORE=ROOT/'public/data/centrum_before_harmonic_now';AFTER=ROOT/'public/data/centrum_now'
a=json.loads((BEFORE/'index.json').read_text());b=json.loads((AFTER/'index.json').read_text());n=a['terrain']['n'];assert n==b['terrain']['n']
fields=['drive','walk','sections','lots','passages','crossings','areas','roads','buildings','trees','walls','fences'];changes={f:[] for f in fields};heights=[];labels=[];levels=[];ipr=[];lost=[]
for path in sorted((AFTER/'tiles').glob('*.json')):
 k=path.stem;old=json.loads((BEFORE/'tiles'/path.name).read_text());new=json.loads(path.read_text())
 for f in fields:
  if old.get(f)!=new.get(f):changes[f].append(k)
 raw0=gzip.decompress((BEFORE/'tiles'/f'{k}.height.bin.gz').read_bytes());raw1=gzip.decompress((AFTER/'tiles'/f'{k}.height.bin.gz').read_bytes());h0=np.frombuffer(raw0,dtype='<u2',count=n*n);h1=np.frombuffer(raw1,dtype='<u2',count=n*n);delta=np.abs(h1.astype(float)-h0)/10
 if np.any(delta):heights.append({'tile':k,'samples':int(np.count_nonzero(delta)),'max_m':float(delta.max())})
 l0=np.frombuffer(raw0,dtype='u1',offset=n*n*2) if len(raw0)>=n*n*3 else np.zeros(n*n,dtype='u1');l1=np.frombuffer(raw1,dtype='u1',offset=n*n*2) if len(raw1)>=n*n*3 else np.zeros(n*n,dtype='u1')
 if not np.array_equal(l0,l1):labels.append(k)
 cover=[]
 for folder,tile in [(BEFORE,old),(AFTER,new)]:
  p=folder/'tiles'/f'{k}.levels.bin.gz';count=len(tile.get('structures',[]));data=gzip.decompress(p.read_bytes()) if p.exists() and count else b'';hs=np.frombuffer(data,dtype='<u2').reshape(count,n*n) if count else np.zeros((0,n*n),dtype='u2');ids=[i for i,s in enumerate(tile.get('structures',[])) if s['kind']=='bridge'];cover.append(np.any(hs[ids]>0,axis=0) if ids else np.zeros(n*n,dtype=bool))
 p0=BEFORE/'tiles'/f'{k}.levels.bin.gz';p1=AFTER/'tiles'/f'{k}.levels.bin.gz'
 if new.get('structures')!=old.get('structures') or (p0.read_bytes() if p0.exists() else None)!=(p1.read_bytes() if p1.exists() else None):levels.append(k)
 if np.any(cover[0]&~cover[1]):lost.append({'tile':k,'lost_padded_bridge_grid_samples':int(np.count_nonzero(cover[0]&~cover[1]))})
 p0=BEFORE/'tiles'/f'{k}.ipr.bin.gz';p1=AFTER/'tiles'/f'{k}.ipr.bin.gz'
 if (p0.read_bytes() if p0.exists() else None)!=(p1.read_bytes() if p1.exists() else None):ipr.append(k)
result={'before_built':a['built'],'after_built':b['built'],'after_pipeline':b.get('pipeline'),'after_index_sha256':hashlib.sha256((AFTER/'index.json').read_bytes()).hexdigest(),'protected_field_changes':{k:len(v) for k,v in changes.items()},'changed_height_tiles':heights,'changed_label_tiles':labels,'changed_level_tiles':levels,'changed_ipr_tiles':ipr,'lost_padded_bridge_coverage':lost}
(ROOT/'docs/evidence/overnight-harmonic-combined/data-comparison.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result,indent=2))
