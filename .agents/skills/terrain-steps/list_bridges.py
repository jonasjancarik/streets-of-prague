"""Writes bridges.json beside this file: the bridges over the Vltava and the Berounka
(and Nuselský most) as the pipeline has them, each with its longest way's ends and
points, for bridges.mjs to measure and photograph.

    uv run --project pipeline python .agents/skills/terrain-steps/list_bridges.py

Needs praha's layers (pipeline/.cache/layers/praha). Run it again when the map's bridges
change; names come from NAMES below, by where a bridge's middle is.
"""
import json
import re
import sys
import unicodedata
from pathlib import Path

import shapely
from pyproj import Transformer
from shapely.geometry import LineString, Polygon

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "pipeline"))
import layers  # noqa: E402
from osm_area import AREAS  # noqa: E402

AREA = "praha"
NAMES = {  # by the middle's latitude and longitude, to three places
    (49.959, 14.325): "Radotín (Berounka)", (49.972, 14.398): "most Závodu míru", (49.981, 14.363): "Radotín lávka (Berounka)",
    (49.984, 14.399): "Lahovice (Berounka)", (49.991, 14.381): "Radotínský most", (49.994, 14.398): "Lahovický most (Berounka)",
    (50.027, 14.400): "Branický most", (50.038, 14.407): "Barrandovský most", (50.050, 14.412): "Dvorecký most",
    (50.052, 14.415): "Podolí (přístav)", (50.066, 14.430): "Nuselský most", (50.067, 14.413): "Železniční most",
    (50.073, 14.412): "Palackého most", (50.076, 14.411): "Jiráskův most", (50.081, 14.410): "most Legií",
    (50.086, 14.411): "Karlův most", (50.090, 14.413): "Mánesův most", (50.093, 14.417): "Čechův most",
    (50.094, 14.427): "Štefánikův most", (50.095, 14.437): "Hlávkův most (jih)", (50.097, 14.437): "Hlávkův most (sever)",
    (50.097, 14.446): "Negrelliho viadukt", (50.099, 14.455): "Libeňský most (jih)", (50.103, 14.460): "Libeňský most",
    (50.112, 14.436): "Trojský most", (50.114, 14.446): "most Barikádníků", (50.114, 14.417): "Trojská lávka",
}
NUSLE = (14.4305, 50.0655)  # not over water: found by where it is


def main():
    meta = layers.read_meta(AREA)
    w, s, e, n = AREAS[AREA]
    local = f"+proj=tmerc +lat_0={(s + n) / 2} +lon_0={(w + e) / 2} +k=1 +x_0=0 +y_0=0 +ellps=WGS84 +units=m"
    to_wgs = Transformer.from_crs(local, "EPSG:4326", always_xy=True)
    to_local = Transformer.from_crs("EPSG:4326", local, always_xy=True)
    ways = []
    for ci, cj in layers.chunks(meta):
        ways += [x for x in layers.read_chunk(AREA, "streets", ci, cj).get("structures", []) if x["kind"] == "bridge"]
    water = []
    for _, _, t in layers.tiles(AREA, meta):
        water += [Polygon(r[0], r[1:]).buffer(0) for r in t["areas"].get("water", [])]
    river = shapely.union_all([g for g in shapely.get_parts(shapely.union_all(water)) if g.area > 150000])
    shapely.prepare(river)
    lines = [LineString(x["pts"]) for x in ways]
    over = [k for k, line in enumerate(lines) if line.length > 60 and river.intersects(line) and line.intersection(river).length > 40]
    nusle = shapely.Point(*to_local.transform(*NUSLE))
    over += [k for k, line in enumerate(lines) if line.length > 150 and line.distance(nusle) < 60 and k not in over]
    out = []
    for blob in shapely.get_parts(shapely.union_all([lines[k].buffer(25) for k in over])):
        k = max((k for k in over if lines[k].intersects(blob)), key=lambda k: lines[k].length)
        c = lines[k].interpolate(0.5, normalized=True)
        (a, z) = lines[k].coords[0], lines[k].coords[-1]
        lon, lat = to_wgs.transform([a[0], z[0], c.x], [a[1], z[1], c.y])
        name = NAMES.get((round(lat[2], 3), round(lon[2], 3)), f"? {lat[2]:.4f}, {lon[2]:.4f}")
        slug = re.sub(r"[^a-z0-9]+", "-", unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode().lower()).strip("-")
        out.append({"name": name, "slug": slug, "a": [round(lat[0], 5), round(lon[0], 5)], "b": [round(lat[1], 5), round(lon[1], 5)],
                    "mid": [round(lat[2], 5), round(lon[2], 5)], "pts": [[round(x, 1), round(y, 1)] for x, y in lines[k].coords]})
    out.sort(key=lambda r: r["mid"][0])
    path = Path(__file__).with_name("bridges.json")
    path.write_text("[\n" + ",\n".join(" " + json.dumps(r, ensure_ascii=False) for r in out) + "\n]\n")
    print(f"{len(out)} bridges → {path}")
    for r in out:
        print(" ", r["name"], r["mid"])


if __name__ == "__main__":
    main()
