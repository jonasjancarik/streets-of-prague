"""Charles Bridge's piers and statues, from OSM, for src/statues.ts.

OSM's outline of the bridge (man_made=bridge, way 119016167) takes in the piers'
cutwaters: a triangle sticking out from the parapet on each side of every pier, which
the game would otherwise raise to the deck's height with a parapet round it. The deck
is a straight band; the cutwaters are some 4–5 m below it, and each pier carries a
statue on the parapet above it. This finds the triangles (the runs of the outline's
corners well out from the walkway's centre line), with the parapet line across each
one's base, and the statues (memorial=statue) on each.

    uv run charles_bridge.py

Reads .cache/osm/praha.osm.pbf (osmium on the PATH) and writes src/charlesBridge.json:
`statues` (OSM's name, [lon, lat]) and `piers`, each with the parapet line across it
(`base`, two [lon, lat]), its outline from one end of that line round to the other,
the statues on it, and `cut`: whether the game takes it off the deck. A pier joined to
a wider piece of the outline (the stairs down to Kampa) or without statues (the
widening at the Old Town tower) isn't cut.
"""

import json
import subprocess
import tempfile
import xml.etree.ElementTree as ET
from pathlib import Path

import numpy as np
from pyproj import Transformer
from shapely.geometry import MultiLineString, Point, Polygon

PBF = Path(__file__).parent / ".cache" / "osm" / "praha.osm.pbf"
OUT = Path(__file__).resolve().parent.parent / "src" / "charlesBridge.json"
BOX = (14.4055, 50.0850, 14.4155, 50.0880)  # west, south, east, north
OUTLINE = "119016167"
# Corners of the outline further than this (m) from the walkway's centre line stick out
# of the parapet (it's some 5 m away; the cutwaters' tips are 10–14 m).
OUT_FROM_WALK = 5.9
# A piece with a statue that's bigger than this (m²) is something else than a cutwater.
CUTWATER = 60
NEAR = 3.0  # m: a statue this close to a pier stands on it


def read():
    with tempfile.TemporaryDirectory() as tmp:
        osm = Path(tmp) / "bridge.osm"
        subprocess.run(["osmium", "extract", "-b", ",".join(map(str, BOX)), "-s", "complete_ways", str(PBF), "-o", str(osm)],
                       check=True, capture_output=True)
        root = ET.parse(osm).getroot()
    nodes, outline, walk, statues = {}, None, [], []
    for n in root.iter("node"):
        nodes[n.get("id")] = (float(n.get("lon")), float(n.get("lat")))
        tags = {t.get("k"): t.get("v") for t in n.findall("tag")}
        if tags.get("memorial") == "statue" or tags.get("artwork_type") == "statue":
            statues.append((tags.get("name", ""), nodes[n.get("id")]))
    for w in root.iter("way"):
        tags = {t.get("k"): t.get("v") for t in w.findall("tag")}
        refs = [r.get("ref") for r in w.findall("nd")]
        if w.get("id") == OUTLINE:
            outline = refs
        elif tags.get("highway") and tags.get("bridge") and tags.get("name") == "Karlův most":
            walk.append(refs)
    if not outline or not walk:
        raise SystemExit("Charles Bridge's outline or walkway isn't in the extract")
    return nodes, outline, walk, statues


def main():
    nodes, outline, walk, statues = read()
    lon0, lat0 = (BOX[0] + BOX[2]) / 2, (BOX[1] + BOX[3]) / 2
    local = f"+proj=tmerc +lat_0={lat0} +lon_0={lon0} +k=1 +x_0=0 +y_0=0 +ellps=WGS84 +units=m"
    to = Transformer.from_crs("EPSG:4326", local, always_xy=True)
    ring = [to.transform(*nodes[r]) for r in outline[:-1]]
    centre = MultiLineString([[to.transform(*nodes[r]) for r in w if r in nodes] for w in walk])
    deck = Polygon(ring)
    # The statues on the bridge: on its outline or just off it (Bruncvík, on his column).
    on = [(name, at) for name, at in statues if deck.distance(Point(to.transform(*at))) < 8]
    out = np.array([centre.distance(Point(p)) > OUT_FROM_WALK for p in ring])
    n = len(ring)
    start = int(np.argmin(out))
    runs, run = [], []
    for k in range(n):
        i = (start + k) % n
        if out[i]:
            run.append(i)
        elif run:
            runs.append(run)
            run = []
    if run:
        runs.append(run)
    piers = []
    for run in runs:
        a, b = (run[0] - 1) % n, (run[-1] + 1) % n
        idx = [a, *run, b]
        shape = Polygon([ring[i] for i in idx])
        here = [name for name, at in on if Point(to.transform(*at)).distance(shape) < NEAR]
        piers.append({
            "statues": here,
            "base": [list(nodes[outline[a]]), list(nodes[outline[b]])],
            "outline": [list(nodes[outline[i]]) for i in idx],
            "cut": bool(here) and shape.area < CUTWATER,
        })
    placed = {s for p in piers for s in p["statues"]}
    missing = [name for name, _ in on if name not in placed]
    if missing:
        raise SystemExit(f"Statues on no pier: {', '.join(missing)}")
    doc = {"source": "OpenStreetMap contributors (ODbL), way 119016167 and the memorial=statue nodes on it",
           "statues": [{"name": name, "at": list(at)} for name, at in on], "piers": piers}
    OUT.write_text(json.dumps(doc, ensure_ascii=False, indent=1) + "\n")
    print(f"{len(on)} statues, {len(piers)} piers ({sum(p['cut'] for p in piers)} cut) -> {OUT}")


if __name__ == "__main__":
    main()
