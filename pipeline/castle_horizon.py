"""Rebuild the small Hradčany skyline seen from distant street viewpoints.

    uv run castle_horizon.py

Cut IPR Praha's CC BY summer 2023 survey around the castle. Blender photographs
the ridge from eight directions with its depth. Reprojecting those images keeps
the skyline and parallax with roughly 3,000–4,000 triangles per visible view.
"""
import io
import json
import struct
import subprocess
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
from PIL import Image
from pyproj import CRS, Transformer
from scipy.ndimage import distance_transform_edt, gaussian_filter, label
from scipy.spatial import Delaunay
from skimage.measure import find_contours

from castle_lighting import footprints, night_tile
from landmarks import BLENDER, write_glb
from photomesh import fetch, nodes_over, triangles

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / "pipeline/.cache/hradcany-horizon"
ORIGIN = (14.40052, 50.09077)
DATUM = 180
LOCAL = CRS.from_proj4(f"+proj=tmerc +lon_0={ORIGIN[0]} +lat_0={ORIGIN[1]} +ellps=WGS84 +units=m")


def survey():
    mercator = Transformer.from_crs(LOCAL, "EPSG:3857", always_xy=True)
    back = Transformer.from_crs("EPSG:3857", LOCAL, always_xy=True)
    corners = np.array([mercator.transform(x, y) for x in (-700,640) for y in (-410,300)])
    cx, cy = mercator.transform(0, 0)
    hill = nodes_over((*corners.min(0), *corners.max(0)), 13)
    palace = nodes_over((cx-660, cy-270, cx+570, cy+205), 15)

    def cut(job):
        node, fine = job
        xyz, uv = triangles(node)
        x, y = back.transform(xyz[:, 0], xyz[:, 1])
        p = np.column_stack((x, y, xyz[:, 2]-DATUM)).reshape(-1, 3, 3)
        centre = p.mean(1)
        x, y = centre[:, 0], centre[:, 1]
        core = ((x+24)/390)**2 + ((y+10)/158)**2 < 1
        keep = (((x+30)/675)**2 + ((y+25)/360)**2 < 1) & (core if fine else ~core)
        if not keep.any():
            return None
        return p[keep].reshape(-1,3), uv.reshape(-1,3,2)[keep].reshape(-1,2), fetch(f"nodes/{node['id']}/textures/0")

    with ThreadPoolExecutor(max_workers=6) as pool:
        jobs = [(n, False) for n in hill] + [(n, True) for n in palace]
        parts = [part for part in pool.map(cut, jobs) if part is not None]
    write_glb(CACHE / "palace.glb", parts)


def smooth(low, high, x):
    t = np.clip((x-low)/(high-low), 0, 1)
    return t*t*(3-2*t)


def depth_view(i, camera, atlas, night, areas):
    image = np.asarray(Image.open(CACHE / f"colour-{i}.png").convert("RGBA"))
    depth = np.asarray(Image.open(CACHE / f"depth-{i}.png"), dtype=float)*4096/65535
    height, width = depth.shape
    y, x = np.mgrid[:height, :width]
    mask = (image[:, :, 3] > 24) & (depth > 1)
    near_y, near_x = distance_transform_edt(~mask, return_distances=False, return_indices=True)
    filled = depth[near_y, near_x]
    eye = np.array(camera["eye"])
    forward = np.array(camera["aim"])-eye
    forward /= np.linalg.norm(forward)
    screen = np.stack(((x+.5)*2/width-1, 1-(y+.5)*2/height, np.ones_like(x), np.ones_like(x)), axis=-1)
    points = screen @ np.linalg.inv(camera["matrix"]).T
    rays = points[:, :, :3]/points[:, :, 3:] - eye
    rays /= np.maximum(1e-7, (rays@forward)[:, :, None])
    world = eye+rays*filled[:, :, None]
    radius = np.sqrt(((world[:, :, 0]+30)/675)**2 + ((world[:, :, 1]+25)/360)**2)
    lower_edge = np.max(np.where(mask,y,0),axis=0)
    opacity = smooth(0,.16,1-radius)*smooth(28,66,world[:, :, 2])*smooth(-315,-135,world[:, :, 1])*smooth(0,38,lower_edge[None, :]-y)
    alpha = image[:, :, 3]*opacity
    solid = alpha > 3
    components, _ = label(solid)
    counts = np.bincount(components.ravel())
    solid &= counts[components] >= 8
    alpha[~solid] = 0
    ys, xs = np.where(solid)
    x0, x1 = max(0,xs.min()-3), min(width,xs.max()+4)
    y0, y1 = max(0,ys.min()-3), min(height,ys.max()+4)

    # Spend most of the boundary vertices on the spires and pitched roofs.
    grid = solid & (x%10 == 0) & (y%9 == 0)
    samples = [np.column_stack((x[grid], y[grid]))]
    for contour in find_contours(solid, .5):
        if len(contour) >= 8:
            samples.append(contour[::3, ::-1])
    pixels = np.unique(np.round(np.concatenate(samples)*2)/2, axis=0)
    faces = Delaunay(pixels).simplices
    centre = pixels[faces].mean(1)
    cx = np.clip(np.rint(centre[:, 0]).astype(int), 0, width-1)
    cy = np.clip(np.rint(centre[:, 1]).astype(int), 0, height-1)
    longest = np.linalg.norm(pixels[faces]-pixels[np.roll(faces,1,axis=1)], axis=2).max(1)
    faces = faces[solid[cy,cx] & (longest < 27)]
    iy = np.clip(np.rint(pixels[:, 1]).astype(int), 0, height-1)
    ix = np.clip(np.rint(pixels[:, 0]).astype(int), 0, width-1)
    # Soften single-pixel depth jumps where a spire crosses a distant roof.
    distance = .82*gaussian_filter(filled,3.2)[iy,ix] + .18*filled[iy,ix]
    coords = eye + rays[iy,ix]*distance[:, None]
    coords = np.column_stack((coords[:,0], coords[:,2], -coords[:,1]))

    rgba = image.copy()
    rgba[:, :, 3] = np.uint8(np.clip(alpha,0,255))
    rgb = rgba[:, :, :3].astype(float)
    luminance = rgb @ np.array([.25,.57,.18])
    rgba[:, :, :3] = np.uint8(np.clip((rgb*.90+luminance[:, :, None]*.10)*.95+3,0,255))
    tile = Image.fromarray(rgba[y0:y1,x0:x1]).resize((1018,250),Image.Resampling.LANCZOS)
    ax, ay = i%2*1024+3, i//2*256+3
    atlas.paste(tile,(ax,ay))
    # Half-resolution evening texture shares the day geometry and UVs.
    light = night_tile(areas,world,eye,rgba,(x0,y0,x1,y1))
    night.paste(light,(i%2*512+1,i//2*128+1))
    uv = np.column_stack(((ax+.5+(pixels[:,0]+.5-x0)/(x1-x0)*1017)/2048,
                          (ay+.5+(pixels[:,1]+.5-y0)/(y1-y0)*249)/1024))
    used, indices = np.unique(faces.ravel(), return_inverse=True)
    return coords[used], uv[used], indices


def write_horizon(path, cameras, meshes, atlas):
    blob = bytearray()
    views, accessors, primitives, nodes = [], [], [], []

    def append(data, target=None, stride=None):
        blob.extend(bytes(-len(blob)%4))
        view = {"buffer": 0, "byteOffset": len(blob), "byteLength": len(data)}
        if target: view["target"] = target
        if stride: view["byteStride"] = stride
        views.append(view)
        blob.extend(data)
        return len(views)-1

    def attribute(array, tag, component, *, normalized=False, target=34962, stride=None, bounds=None):
        acc = {"bufferView": append(array.tobytes(),target,stride), "type": tag, "componentType": component, "count": len(array)}
        if normalized: acc["normalized"] = True
        if bounds is not None: acc.update(min=bounds.min(0).tolist(), max=bounds.max(0).tolist())
        accessors.append(acc)
        return len(accessors)-1

    for i, (p, uv, indices) in enumerate(meshes):
        # Five-centimetre vertices are finer than a screen pixel from the next district.
        positions = np.int16(np.rint(p/.05))
        aligned = np.column_stack((positions, np.zeros(len(p), dtype=np.int16))).astype("<i2")
        pos = attribute(aligned,"VEC3",5122,stride=8,bounds=positions)
        tex = attribute((np.clip(uv,0,1)*65535).astype("<u2"),"VEC2",5123,normalized=True)
        idx = attribute(indices.astype("<u2"),"SCALAR",5123,target=34963)
        primitives.append({"primitives":[{"attributes":{"POSITION":pos,"TEXCOORD_0":tex},"indices":idx,"material":0}]})
        nodes.append({"mesh":i, "name":f"Ridge view {i}", "extras":{"bearing":cameras[i]["az"]}, "scale":[.05]*3})
    encoded = io.BytesIO()
    atlas.save(encoded,"WEBP",quality=91,method=6,exact=True)
    image = append(encoded.getvalue())
    blob.extend(bytes(-len(blob)%4))
    extensions = ["KHR_mesh_quantization","EXT_texture_webp"]
    gltf = {"asset":{"version":"2.0","generator":"Streets of Prague – IPR Praha, 2023, CC BY"},
            "extensionsUsed":extensions,"extensionsRequired":extensions,"scene":0,"scenes":[{"nodes":list(range(len(nodes)))}],
            "nodes":nodes,"meshes":primitives,"materials":[{"alphaMode":"BLEND","doubleSided":True,
            "pbrMetallicRoughness":{"baseColorTexture":{"index":0},"metallicFactor":0,"roughnessFactor":1}}],
            "textures":[{"extensions":{"EXT_texture_webp":{"source":0}}}],"images":[{"mimeType":"image/webp","bufferView":image}],
            "buffers":[{"byteLength":len(blob)}],"bufferViews":views,"accessors":accessors}
    header = json.dumps(gltf,separators=(",",":")).encode()
    header += b" "*(-len(header)%4)
    path.write_bytes(struct.pack("<III",0x46546C67,2,28+len(header)+len(blob)) + struct.pack("<II",len(header),0x4E4F534A)
                     + header + struct.pack("<II",len(blob),0x004E4942) + blob)


def pack():
    cameras = json.loads((CACHE / "views.json").read_text())
    atlas = Image.new("RGBA",(2048,1024),(130,133,129,0))
    night = Image.new("RGBA",(1024,512))
    areas = footprints(LOCAL,ROOT / "pipeline/.cache/osm/praha.osm.pbf")
    meshes = [depth_view(i,camera,atlas,night,areas) for i,camera in enumerate(cameras)]
    write_horizon(ROOT / "public/hradcany-horizon.glb", cameras, meshes, atlas)
    night.save(ROOT / "public/hradcany-lights.webp","WEBP",quality=90,method=6)
    print("Triangles per view:", [len(indices)//3 for _,_,indices in meshes])


if __name__ == "__main__":
    CACHE.mkdir(parents=True, exist_ok=True)
    survey()
    subprocess.run([BLENDER,"-b","--factory-startup","-P",str(Path(__file__).with_name("castle_horizon_bake.py")),"--",str(CACHE)],check=True)
    pack()
