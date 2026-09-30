"""IPR's photorealistic 3D mesh of Prague: downloading its pieces and reading them.

IPR publishes the mesh (oblique aerial photographs, summer 2023, textures about
5 cm/px at the finest level, CC BY) as an I3S scene layer, a tree of ever finer pieces
("nodes"), each with its own triangles and a JPEG atlas (1024×512). Positions and the
index are in EPSG:3857, heights in metres above sea level (Bpv).

Every file is kept in pipeline/.cache/mesh/ as downloaded, one file per URL path, and
never changes once there, so the cache can be shared between checkouts. Used by
landmarks.py and mesh_colours.py.
"""

import gzip
import io
import json
import struct
import time
import urllib.request
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
from PIL import Image

MESH = "https://tiles.arcgis.com/tiles/SBTXIEUGWbqzUecw/arcgis/rest/services/praha2023_merged_WM/SceneServer/layers/0"
NODES = Path(__file__).parent / ".cache" / "mesh"
WORKERS = 12


def fetch(path: str) -> bytes:
    """A file of the layer (e.g. "nodes/<id>"), from the cache or downloaded into it."""
    f = NODES / path.replace("/", "_")
    if not f.exists():
        NODES.mkdir(parents=True, exist_ok=True)
        for attempt in range(5):
            try:
                data = urllib.request.urlopen(f"{MESH}/{path}", timeout=60).read()
                break
            except OSError:
                if attempt == 4:
                    raise
                time.sleep(2 ** attempt)
        # Written under another name and renamed, so a half-written file is never read,
        # here or by another checkout sharing the cache.
        tmp = f.with_name(f"{f.name}.{uuid.uuid4().hex}.part")
        tmp.write_bytes(data)
        tmp.replace(f)
    b = f.read_bytes()
    return gzip.decompress(b) if b[:2] == b"\x1f\x8b" else b


def fetch_all(paths, workers: int = WORKERS):
    """Downloads the files that aren't in the cache yet, a few at a time."""
    todo = [p for p in paths if not (NODES / p.replace("/", "_")).exists()]
    if todo:
        with ThreadPoolExecutor(workers) as pool:
            list(pool.map(fetch, todo))
    return len(todo)


def node(nid: str) -> dict:
    return json.loads(fetch(f"nodes/{nid}"))


def _reaches(n: dict, bounds) -> bool:
    cx, cy, _, r = n["mbs"]
    x0, y0, x1, y1 = bounds
    dx, dy = max(x0 - cx, 0, cx - x1), max(y0 - cy, 0, cy - y1)
    return dx * dx + dy * dy <= r * r


def nodes_over(bounds, level: int | None, nid="root"):
    """The nodes whose bounding sphere reaches `bounds` (EPSG:3857): at `level`, or the
    finest there are where the tree stops sooner. Walks the tree a level at a time,
    downloading each level's nodes in parallel."""
    found, todo = [], [nid]
    while todo:
        fetch_all([f"nodes/{i}" for i in todo])
        nxt = []
        for n in map(node, todo):
            if not _reaches(n, bounds):
                continue
            children = n.get("children") or []
            if n.get("geometryData") and (not children or n.get("level") == level):
                found.append(n)
            else:
                nxt += [c["id"] for c in children]
        todo = nxt
    return found


def triangles(n):
    """A node's triangles (EPSG:3857 and metres above sea level) and their UVs."""
    b = fetch(f"nodes/{n['id']}/geometries/0")
    count = struct.unpack_from("<I", b, 0)[0]
    pos = np.frombuffer(b, "<f4", count * 3, 8).reshape(-1, 3).astype(np.float64) + n["mbs"][:3]
    uv = np.frombuffer(b, "<f4", count * 2, 8 + count * 12).reshape(-1, 2)
    return pos, uv


def texture_bytes(n) -> bytes:
    return fetch(f"nodes/{n['id']}/textures/0")


def texture(n) -> np.ndarray:
    """A node's atlas as an (h, w, 3) uint8 array."""
    return np.asarray(Image.open(io.BytesIO(texture_bytes(n))).convert("RGB"))


def prefetch(nodes, workers: int = WORKERS):
    """Downloads the geometry and texture of all `nodes`; returns how many files were new."""
    return fetch_all([f"nodes/{n['id']}/{kind}/0" for n in nodes for kind in ("geometries", "textures")], workers)
