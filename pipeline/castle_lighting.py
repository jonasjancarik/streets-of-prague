"""Bake Prague Castle's evening floodlights onto its photographed masonry."""
import json
import subprocess
from pathlib import Path
from tempfile import TemporaryDirectory

import numpy as np
import shapely
from PIL import Image
from pyproj import Transformer
from shapely.geometry import shape
from shapely.ops import transform, unary_union


def footprints(projection, pbf):
    # OpenStreetMap area IDs from osmium export. The unnamed multipolygon is the
    # long New Royal Palace wing with the two courtyard holes.
    groups = {"cathedral": {"a30635799"}, "basilica": {"a6744265"},
              "palace": {"a6735115", "a12623291", "a57299", "a6735763", "a6744267"}}
    convert = Transformer.from_crs("EPSG:4326", projection, always_xy=True).transform
    with TemporaryDirectory() as directory:
        crop = Path(directory) / "castle.osm.pbf"
        subprocess.run(["osmium", "extract", "-b", "14.3938,50.0878,14.4076,50.0935", "-s", "complete_ways",
                        str(pbf), "-o", str(crop)], check=True)
        data = subprocess.check_output(["osmium", "export", str(crop), "--geometry-types=polygon",
                                        "--add-unique-id=type_id", "-f", "geojson"])
    areas = {f["id"]: f["geometry"] for f in json.loads(data)["features"]}
    return {group: unary_union([transform(convert, shape(areas[key])) for key in ids]).buffer(2)
            for group, ids in groups.items()}


def night_tile(areas, world, eye, rgba, box):
    # Work only inside the same tight crop as the day atlas. Sloped roofs and
    # vegetation retain the ordinary night sky exposure.
    x0, y0, x1, y1 = box
    points = world[y0:y1,x0:x1]
    east, north, height = points.transpose(2,0,1)
    dy, dx = np.gradient(points, axis=(0,1))
    normal = np.cross(dx,dy)
    normal /= np.maximum(1e-7, np.linalg.norm(normal,axis=2,keepdims=True))
    normal *= np.where(np.sum(normal*(eye-points),axis=-1,keepdims=True)<0,-1,1)
    upright = 1-np.abs(normal[:,:,2])
    wall = np.clip((upright-.21)/.62,0,1)
    source = rgba[y0:y1,x0:x1]
    red, green, blue = source[:,:,:3].astype(float).transpose(2,0,1)
    stone = 1 - np.clip((red-green-12)/40,0,1)
    foliage = 1 - np.clip((green-red)/18,0,1)
    luminance = (.26*red+.56*green+.18*blue)/255
    # The cathedral's spires, pale towers of St George and south palace front
    # have distinct light levels. On the north face only the churches are lit.
    masks = {k: shapely.contains_xy(area,east,north) for k,area in areas.items()}
    cathedral = masks["cathedral"] * np.clip((height-72)/13,0,1) * (.18+.82*wall)
    basilica = masks["basilica"] * np.clip((height-89)/15,0,1) * (.12+.88*wall)
    # On the long south face the 16 lamp pools overlap. Use its diagonal axis
    # for the spacing so the pools meet the stone in each of the eight views.
    along = east*.93+north*.37
    pool = .78+.22*np.cos(along*2*np.pi/29)
    south = np.clip((.49*normal[:,:,0]-.87*normal[:,:,1]+.16)/.85,0,1)
    palace = masks["palace"] * south * pool * wall * np.clip((height-57)/14,0,1)
    weights = np.stack((cathedral,basilica,palace),axis=-1)
    colours = np.array([[1,.83,.62],[1,.96,.82],[1,.77,.49]])
    rgb = weights @ colours
    intensity = np.max(weights,axis=-1)
    rgb /= np.maximum(1e-5,intensity[:,:,None])
    # Retain photographed window recesses and the cathedral's tracery.
    rgb *= np.clip((.05+1.05*luminance)**.84,0,1)[:,:,None]
    light = np.zeros_like(source)
    light[:,:,:3] = np.uint8(255*np.clip(rgb,0,1))
    light[:,:,3] = np.uint8(source[:,:,3]*np.clip(intensity*stone*foliage,0,1))
    return Image.fromarray(light).resize((509,125),Image.Resampling.LANCZOS)
