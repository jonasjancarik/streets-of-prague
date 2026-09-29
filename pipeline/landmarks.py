"""Landmarks cut out of IPR's photorealistic 3D mesh of Prague, in place of their
buildings from the city model.

IPR publishes the mesh (oblique aerial photographs, summer 2023, textures about
5 cm/px, CC BY) as an I3S scene layer, a tree of ever finer pieces ("nodes"), each
with its own triangles and a JPEG atlas. For each landmark, this takes the nodes
over the OSM footprints of its buildings (from the area's tiles), keeps the
triangles inside them, and bakes their colours in Blender (landmark_bake.py) onto the
landmark's clean model from IPR's city model (LOD3, from the area's tiles), for
straight walls and roof edges without the mesh's trees and lumps. The result is a GLB
in the game's coordinates (x east, y up above iprRef, z south), listed with the
footprint the game hides IPR's and OSM's buildings in.

    uv run landmarks.py centrum                 all landmarks in the area
    uv run landmarks.py centrum manes --raw     the mesh's triangles as they are

Needs the area's tiles with IPR's buildings (build_tiles.py, ipr_buildings.py) and
Blender (on the PATH, in /Applications, or $BLENDER). Writes
public/data/<area>_now/landmarks/<name>.glb and landmarks.json. The mesh's nodes are
kept in pipeline/.cache/mesh/.
"""

import argparse
import gzip
import json
import os
import shutil
import struct
import subprocess
import tempfile
import urllib.request
from pathlib import Path

import numpy as np
from pyproj import Transformer
from shapely import contains_xy
from shapely.geometry import Polygon, mapping
from shapely.ops import unary_union

from layers import CACHE as LAYERS
from osm_area import OUT

MESH = "https://tiles.arcgis.com/tiles/SBTXIEUGWbqzUecw/arcgis/rest/services/praha2023_merged_WM/SceneServer/layers/0"
NODES = Path(__file__).parent / ".cache" / "mesh"

# Each landmark: the OSM buildings it replaces. Its footprint is theirs, a little wider
# (PAD) so the walls and the eaves stay whole.
LANDMARKS = {
    "manes": ["way/7649964", "way/30169179"],  # Mánes and Šítkovská vodárenská věž
}
PAD = 1.5
BLENDER = os.environ.get("BLENDER") or shutil.which("blender") or "/Applications/Blender.app/Contents/MacOS/Blender"


def fetch(path: str) -> bytes:
    f = NODES / path.replace("/", "_")
    if not f.exists():
        NODES.mkdir(parents=True, exist_ok=True)
        f.write_bytes(urllib.request.urlopen(f"{MESH}/{path}", timeout=60).read())
    b = f.read_bytes()
    return gzip.decompress(b) if b[:2] == b"\x1f\x8b" else b


def nodes_over(bounds, level: int | None, nid="root"):
    """The nodes whose bounding sphere reaches `bounds` (EPSG:3857): at `level`, or the
    finest there are where the tree stops sooner."""
    n = json.loads(fetch(f"nodes/{nid}"))
    cx, cy, _, r = n["mbs"]
    x0, y0, x1, y1 = bounds
    dx, dy = max(x0 - cx, 0, cx - x1), max(y0 - cy, 0, cy - y1)
    if dx * dx + dy * dy > r * r:
        return []
    children = n.get("children") or []
    if n.get("geometryData") and (not children or n.get("level") == level):
        return [n]
    return [m for c in children for m in nodes_over(bounds, level, c["id"])]


def triangles(n):
    """A node's triangles (EPSG:3857 and metres above sea level) and their UVs."""
    b = fetch(f"nodes/{n['id']}/geometries/0")
    count = struct.unpack_from("<I", b, 0)[0]
    pos = np.frombuffer(b, "<f4", count * 3, 8).reshape(-1, 3).astype(np.float64) + n["mbs"][:3]
    uv = np.frombuffer(b, "<f4", count * 2, 8 + count * 12).reshape(-1, 2)
    return pos, uv


def footprints(area: str, ids: list[str]):
    """The OSM buildings' outlines in the area's coordinates, from its tiles."""
    polys = {}
    for f in (OUT / f"{area}_now" / "tiles").glob("*.json"):
        for b in json.loads(f.read_text())["buildings"]:
            if b["id"] in ids and b["id"] not in polys:
                rings = b["rings"]
                polys[b["id"]] = Polygon(rings[0], rings[1:])
    missing = set(ids) - set(polys)
    if missing:
        raise SystemExit(f"Not in {area}'s tiles: {', '.join(sorted(missing))}")
    return list(polys.values())


def lod3(area: str, tiles: list[str], foot) -> np.ndarray:
    """IPR's city-model triangles in the footprint, from the tiles' .ipr.bin (see
    ipr_buildings.py), in the game's axes."""
    out = []
    for k in tiles:
        base = OUT / f"{area}_now" / "tiles" / k
        f = next((g for g in (base.with_name(f"{k}.ipr.bin.gz"), base.with_name(f"{k}.ipr.bin")) if g.exists()), None)
        if not f:
            continue
        b = f.read_bytes()
        b = gzip.decompress(b) if f.suffix == ".gz" else b
        x0, y0 = json.loads(base.with_name(f"{k}.json").read_text())["box"][:2]
        n = struct.unpack_from("<I", b, 0)[0]
        p = np.frombuffer(b, "<i2", n * 9, 8).reshape(-1, 3, 3).astype(np.float64) / 100
        x, h, y = p[..., 0] + x0, p[..., 1], p[..., 2] + y0
        keep = contains_xy(foot, x.mean(1), y.mean(1))
        out.append(np.stack([x[keep], h[keep], -y[keep]], -1))
    return np.concatenate(out) if out else np.empty((0, 3, 3))


def bake(name: str, parts, clean: np.ndarray, out: Path):
    """The mesh's colours on the clean model, by Blender."""
    with tempfile.TemporaryDirectory() as d:
        high, low = Path(d) / "high.glb", Path(d) / "low.obj"
        write_glb(high, parts)
        v = clean.reshape(-1, 3)
        low.write_text("".join(f"v {a:.3f} {b:.3f} {c:.3f}\n" for a, b, c in v)
                       + "".join(f"f {i} {i + 1} {i + 2}\n" for i in range(1, len(v), 3)))
        r = subprocess.run([BLENDER, "-b", "--factory-startup", "-P", str(Path(__file__).with_name("landmark_bake.py")),
                            "--", str(low), str(high), str(out)], capture_output=True, text=True)
        said = [l for l in r.stdout.splitlines() if l.startswith("clean model:") or "Error" in l]
        if r.returncode or not out.exists():
            raise SystemExit(f"{name}: Blender failed\n{r.stdout[-2000:]}\n{r.stderr[-2000:]}")
        print(f"{name}: " + "; ".join(said))


def cut(area: str, name: str, ids: list[str], level: int | None, crs: str, ref: float, tile: float, origin, raw: bool):
    foot = unary_union(footprints(area, ids)).buffer(PAD, join_style="mitre")
    to3857 = Transformer.from_crs(crs, "EPSG:3857", always_xy=True)
    back = Transformer.from_crs("EPSG:3857", crs, always_xy=True)
    x0, y0, x1, y1 = foot.bounds
    xs, ys = to3857.transform([x0, x1, x0, x1], [y0, y0, y1, y1])
    nodes = nodes_over((min(xs), min(ys), max(xs), max(ys)), level)
    parts = []
    for n in nodes:
        pos, uv = triangles(n)
        x, y = back.transform(pos[:, 0], pos[:, 1])
        p = np.column_stack((x, y, pos[:, 2] - ref)).reshape(-1, 3, 3)
        c = p.mean(1)
        keep = contains_xy(foot, c[:, 0], c[:, 1])
        if keep.any():
            parts.append((p[keep].reshape(-1, 3), uv.reshape(-1, 3, 2)[keep].reshape(-1, 2), fetch(f"nodes/{n['id']}/textures/0")))
    if not parts:
        raise SystemExit(f"{name}: the mesh has nothing there")
    ox, oy = origin
    tiles = sorted({f"{i}_{j}" for i in range(int((x0 + ox) // tile), int((x1 + ox) // tile) + 1)
                    for j in range(int((y0 + oy) // tile), int((y1 + oy) // tile) + 1)})
    print(f"{name}: {sum(len(p) // 3 for p, _, _ in parts)} triangles of the mesh from {len(nodes)} nodes "
          f"(levels {sorted({n['level'] for n in nodes})})")
    out = OUT / f"{area}_now" / "landmarks"
    out.mkdir(parents=True, exist_ok=True)
    glb = out / f"{name}.glb"
    clean = np.empty((0, 3, 3)) if raw else lod3(area, tiles, foot)
    if len(clean):
        bake(name, parts, clean, glb)
    else:
        if not raw:
            print(f"{name}: no IPR buildings there, so the mesh's triangles as they are")
        write_glb(glb, parts)
    print(f"{name}: {glb.stat().st_size / 1e6:.1f} MB")
    cx, cy = foot.centroid.x, foot.centroid.y
    polys = list(foot.geoms) if foot.geom_type == "MultiPolygon" else [foot]
    return {"name": name, "file": f"landmarks/{name}.glb", "polygons": [mapping(q)["coordinates"] for q in polys],
            "home": f"{int((cx + ox) // tile)}_{int((cy + oy) // tile)}", "tiles": tiles}


def write_glb(path: Path, parts) -> int:
    """One mesh, a primitive per node with its own texture, in the game's axes."""
    blob, views, accessors, prims, materials, textures, images = bytearray(), [], [], [], [], [], []

    def view(data: bytes, target=None):
        blob.extend(b"\0" * (-len(blob) % 4))
        views.append({"buffer": 0, "byteOffset": len(blob), "byteLength": len(data), **({"target": target} if target else {})})
        blob.extend(data)
        return len(views) - 1

    for i, (p, uv, jpeg) in enumerate(parts):
        g = np.column_stack((p[:, 0], p[:, 2], -p[:, 1])).astype("<f4")
        a = len(accessors)
        accessors.append({"bufferView": view(g.tobytes(), 34962), "componentType": 5126, "count": len(g), "type": "VEC3",
                          "min": g.min(0).tolist(), "max": g.max(0).tolist()})
        accessors.append({"bufferView": view(uv.astype("<f4").tobytes(), 34962), "componentType": 5126, "count": len(uv), "type": "VEC2"})
        images.append({"bufferView": view(jpeg), "mimeType": "image/jpeg"})
        textures.append({"source": i})
        materials.append({"pbrMetallicRoughness": {"baseColorTexture": {"index": i}, "metallicFactor": 0, "roughnessFactor": 1}, "doubleSided": True})
        prims.append({"attributes": {"POSITION": a, "TEXCOORD_0": a + 1}, "material": i})
    blob.extend(b"\0" * (-len(blob) % 4))
    doc = {"asset": {"version": "2.0", "copyright": "IPR Praha, CC BY"}, "scene": 0, "scenes": [{"nodes": [0]}],
           "nodes": [{"mesh": 0}], "meshes": [{"primitives": prims}], "accessors": accessors, "bufferViews": views,
           "buffers": [{"byteLength": len(blob)}], "materials": materials, "textures": textures, "images": images}
    js = json.dumps(doc).encode()
    js += b" " * (-len(js) % 4)
    glb = (struct.pack("<III", 0x46546C67, 2, 28 + len(js) + len(blob)) + struct.pack("<II", len(js), 0x4E4F534A) + js
           + struct.pack("<II", len(blob), 0x004E4942) + bytes(blob))
    path.write_bytes(glb)
    return len(glb)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("area")
    ap.add_argument("names", nargs="*", help="landmarks to cut (default: all)")
    ap.add_argument("--level", type=int, default=None, help="mesh level to take (default: the finest, 16)")
    ap.add_argument("--raw", action="store_true", help="the mesh's triangles as they are, not baked onto IPR's city model")
    a = ap.parse_args()
    meta = json.loads((LAYERS / a.area / "meta.json").read_text())
    index = json.loads((OUT / f"{a.area}_now" / "index.json").read_text())
    listing = OUT / f"{a.area}_now" / "landmarks.json"
    done = {l["name"]: l for l in json.loads(listing.read_text())} if listing.exists() else {}
    for name in a.names or LANDMARKS:
        done[name] = cut(a.area, name, LANDMARKS[name], a.level, meta["crs"], index.get("iprRef", 180.0), index["tile"], index["origin"], a.raw)
    listing.write_text(json.dumps(list(done.values())))


if __name__ == "__main__":
    main()
