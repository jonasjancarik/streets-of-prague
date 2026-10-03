"""Offline scoped regeneration plus read-only source/member profile capture."""
import copy
import importlib
import importlib.util
import json
from pathlib import Path
import runpy
import sys
from unittest.mock import patch
import numpy as np
from pyproj import Transformer
from shapely.geometry import LineString, Point

ROOT = Path('/Users/janca/.codex/worktrees/overnight-city-integration/streets-of-prague')
runpy.run_path(str(ROOT/'docs/evidence/overnight-combined/offline-build.py'),run_name='offline_setup')
OUT = ROOT/'docs/evidence/overnight-bridges'


def capture(module, tag, args, kwargs):
    frame = {'tag':tag, 'groups':[], 'bridges':[]}
    old_pieces, old_assign = module.pieces, module.assign_levels
    state={}
    def pieces(*values,**options):
        out,groups=old_pieces(*values,**options)
        state.update(ways=values[0],profiles=values[1],pieces=out,ground=values[3])
        return out,groups
    def assign(groups):
        result=old_assign(groups)
        for group in groups:
            frame['groups'].append({'level':group[0].level,'kind':group[0].kind,'members':sorted({m for p in group for m in p.members}), 'mapped_layers':sorted({getattr(p,'mapped_layer',None) for p in group if getattr(p,'mapped_layer',None) is not None}), 'bounds':list(group[0].shape.bounds)})
        spec=json.loads((ROOT/'.agents/skills/terrain-steps/bridges.json').read_text())
        tf=Transformer.from_crs('EPSG:4326','+proj=tmerc +lat_0=50.0815 +lon_0=14.42 +ellps=WGS84 +units=m',always_xy=True)
        inverse=Transformer.from_crs(tf.target_crs,'EPSG:4326',always_xy=True)
        for bridge in spec:
            if bridge['name'] not in ('most Legií','Karlův most','Čechův most'):continue
            coords=[tf.transform(ll[1],ll[0]) for ll in [bridge['a'],bridge['b']]]
            line=LineString(coords);mid=Point(*tf.transform(bridge['mid'][1],bridge['mid'][0]));corridor=line.buffer(25)
            hits=[]
            for way in state['ways']:
                if way['kind']!='bridge':continue
                ls=LineString(way['pts'])
                if ls.length<60 or ls.distance(mid)>25:continue
                share=ls.intersection(corridor).length/ls.length
                if share<.7:continue
                car=way['hw'] not in ('footway','path','steps','pedestrian','cycleway')
                hits.append((car if bridge['name']!='Karlův most' else not car,ls.length*share,way,ls))
            if not hits:
                frame['bridges'].append({'name':bridge['name'],'error':'No source way matching catalogue location'});continue
            _,_,way,ls=max(hits,key=lambda hit:(hit[0],hit[1],-hit[2]['id']))
            piece=next(p for p in state['pieces'] if way['id'] in p.members)
            distances=np.r_[np.arange(0,ls.length,2),ls.length]
            pts=np.array([[ls.interpolate(float(s)).x,ls.interpolate(float(s)).y] for s in distances])
            heights=piece.height(pts[:,0],pts[:,1]);ground=state['ground'](pts[:,0],pts[:,1])
            finite=lambda values:[float(x) if np.isfinite(x) else None for x in values]
            ll=[inverse.transform(*p) for p in way['pts']]
            record={'name':bridge['name'],'way_id':way['id'],'kind':way['kind'],'hw':way['hw'],'mapped_layer':way.get('mapped_layer'),'layer':way['layer'],'runtime_level':piece.level,'nodes':way['nodes'],'grade':way['grade'],'on_ground':way.get('on_ground'),'pts':way['pts'],'latlon_pts':[[lat,lon] for lon,lat in ll],'distances':finite(distances),'heights':finite(heights),'clean_ground':finite(ground),'length':ls.length,'max_delta_2m':float(np.nanmax(np.abs(np.diff(heights)))),'max_grade':float(np.nanmax(np.abs(np.diff(heights)/np.diff(distances)))),'scrap':bool(way.get('scrap'))}
            frame['bridges'].append(record)
        return result
    with patch.object(module,'pieces',pieces),patch.object(module,'assign_levels',assign):
        result=module.build(*args,**kwargs)
    return result,frame


if __name__=='__main__':
    stage=sys.argv[1];sys.argv=[stage,*sys.argv[2:]]
    if stage=='layers':
        import layers
        layers.assemble('centrum',strict=True)
    elif stage=='ipr_terrain':
        import structures
        legacy_spec=importlib.util.spec_from_file_location('bridge_before','/tmp/bridge-before-structures.py')
        legacy=importlib.util.module_from_spec(legacy_spec);legacy_spec.loader.exec_module(legacy)
        old_ways=[w for p in sorted((ROOT/'pipeline/.cache/bridge-before/layers/streets').glob('*.json')) for w in json.loads(p.read_text()).get('structures',[])]
        original=structures.build
        def traced(*args,**kwargs):
            baseline_args=(copy.deepcopy(old_ways),*args[1:]);baseline_kwargs={**kwargs,'source_manifest':{}}
            _,before=capture(legacy,'before-legacy-contact',baseline_args,baseline_kwargs)
            # capture calls module.build, so temporarily restore the unwrapped entry.
            with patch.object(structures,'build',original):
                result,after=capture(structures,'after-current-contact',args,kwargs)
            (OUT/'source-profiles.json').write_text(json.dumps({'before':before,'after':after},indent=2,allow_nan=False)+'\n')
            return result
        structures.build=traced
        importlib.import_module(stage).main()
    else:
        importlib.import_module(stage).main()
