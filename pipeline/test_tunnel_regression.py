"""Frozen Mrázovka clean inputs: an unknown portal must not erase the interior."""
import base64
import copy
import gzip
import json
from pathlib import Path
import unittest
import sys
from unittest.mock import patch

import numpy as np
from shapely.geometry import box, Point, LineString
import structures
import ipr_terrain


def fixture():
    c = json.loads((Path(__file__).parent / 'fixtures/mrazovka-clean-inputs.json').read_text())
    unpack = lambda s: gzip.decompress(base64.b64decode(s))
    n = c['N'] + 1
    tiles, labels, boxes = {}, {}, {}
    for t in c['tiles']:
        key = tuple(t['key'])
        tiles[key] = np.frombuffer(unpack(t['heights_f32_gzip_base64']), '<f4').reshape(n,n).copy()
        labels[key] = np.frombuffer(unpack(t['labels_u8_gzip_base64']), np.uint8).reshape(n,n)
        boxes[key] = box(*t['box'])
    decks = {(x,y):np.array(h,dtype=np.float32) for x,y,h in json.loads(unpack(c['decks_gzip_base64']))}
    ground = ipr_terrain.sampler(tiles,c['N'],c['meta']['tile'],c['step'],c['gx0'],c['gy0'],labels)
    return c, tiles, boxes, decks, ground


class TunnelRegressionTests(unittest.TestCase):
    def test_real_mixed_component_retains_tunnel_depth_with_unknown_portal(self):
        c,_,_,decks,ground = fixture(); ways=copy.deepcopy(c['ways'])
        self.assertTrue(np.isnan(ground(np.array([-1364.87]),np.array([-1792.61]))[0]))
        net,profiles=structures.solve(ways,ground,decks)
        kept,_=structures.drop_shallow(ways,net,profiles,ground)
        self.assertEqual({w['id'] for w in kept},{w['id'] for w in ways})
        self.assertEqual(np.isfinite(net.h).sum(),107)
        self.assertGreater(np.nanmax(ground(net.xy[:,0],net.xy[:,1])-net.h),36.8)
        i=next(i for i,w in enumerate(ways) if w['id']==362654528);line=LineString(ways[i]['pts'])
        p=next(p for p in c['probes'] if p['fraction']==.8);d,h=profiles[i]
        self.assertAlmostEqual(float(np.interp(line.project(Point(p['x'],p['y'])),d,h)),199.39969577434655,6)

    def test_exported_tunnel_and_bridge_grids_preserve_runtime_support(self):
        c,tiles,boxes,decks,ground=fixture()
        with patch.object(structures,'ipr_decks',return_value=decks):
            result=structures.build(copy.deepcopy(c['ways']),[],[],ground,c['meta']['crs'],tiles,c['N'],
                                    c['meta']['tile'],c['step'],c['gx0'],c['gy0'],boxes)
        for fraction,kind,want in [(.8,'tunnel',199.4),(.95,'bridge',204.06058465)]:
            p=next(p for p in c['probes'] if p['fraction']==fraction);x,y=p['x'],p['y']
            i=int(np.floor((x-c['gx0'])/c['meta']['tile']));j=int(np.floor((y-c['gy0'])/c['meta']['tile']))
            rows=[r for r in result[i,j] if r[1]==kind and any(__import__('shapely').geometry.Polygon(a[0],a[1:]).covers(Point(x,y)) for a in r[3])]
            self.assertEqual(len(rows),1)
            grid=rows[0][2];encoded=np.clip(np.round((np.nan_to_num(grid,nan=100)-100)*100),0,65535).astype('<u2')
            decoded=np.where(encoded>0,encoded/100+100,np.nan)
            u=(x-c['gx0']-i*c['meta']['tile'])/c['step'];v=(y-c['gy0']-j*c['meta']['tile'])/c['step']
            ix=int(u);iy=int(v);fu=u-ix;fv=v-iy
            h=(decoded[iy,ix]*(1-fu)+decoded[iy,ix+1]*fu)*(1-fv)+(decoded[iy+1,ix]*(1-fu)+decoded[iy+1,ix+1]*fu)*fv
            self.assertTrue(np.isfinite(h));self.assertAlmostEqual(h,want,5)


if __name__=='__main__':
    if len(sys.argv)>1 and sys.argv[1]=='--runtime-payload':
        c,tiles,boxes,decks,ground=fixture()
        with patch.object(structures,'ipr_decks',return_value=decks):
            result=structures.build(copy.deepcopy(c['ways']),[],[],ground,c['meta']['crs'],tiles,c['N'],
                                    c['meta']['tile'],c['step'],c['gx0'],c['gy0'],boxes)
        rows=[]
        for key,levels in result.items():
            raw=b''.join(np.clip(np.round((np.nan_to_num(h,nan=100)-100)*100),0,65535).astype('<u2').tobytes()
                         for _,_,h,_ in levels)
            rows.append({'key':list(key),'box':list(boxes[key].bounds),'structures':[{'level':lv,'kind':kind,'polys':polys}for lv,kind,_,polys in levels],
                         'encoded_levels_base64':base64.b64encode(raw).decode()})
        Path(sys.argv[2]).write_text(json.dumps({'n':c['N']+1,'step':c['step'],'ref':180,'probes':c['probes'],'tiles':rows}))
    else:
        unittest.main()
