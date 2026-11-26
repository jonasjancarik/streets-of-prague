"""Rebuild the street-to-shop sightlines on Mostecká from the local Prague OSM extract."""
import json
import subprocess
import tempfile
from pathlib import Path
from xml.etree import ElementTree as ET

from pyproj import Transformer
from shapely.geometry import LineString, MultiLineString, Point
from shapely.ops import nearest_points

ROOT = Path(__file__).resolve().parents[1]
# Stock already in the street display atlas: books, bakery, flowers, ceramics.
TRADE = {"bakery": 1, "books": 0, "florist": 2, "gift": 3, "art": 0, "craft": 3}


def build():
    with tempfile.TemporaryDirectory() as tmp:
        osm = Path(tmp) / "street.osm"
        subprocess.run(["osmium", "extract", "-b", "14.4036,50.0866,14.4076,50.0881", "-s", "complete_ways",
                        str(ROOT / "pipeline/.cache/osm/praha.osm.pbf"), "-o", str(osm)], check=True)
        root = ET.parse(osm).getroot()
    to = Transformer.from_crs(4326, 32633, always_xy=True)
    back = Transformer.from_crs(32633, 4326, always_xy=True)
    nodes = {n.get("id"): (float(n.get("lon")), float(n.get("lat"))) for n in root.iter("node")}
    def tags(element):
        return {t.get("k"): t.get("v") for t in element.findall("tag")}
    street = MultiLineString([LineString([to.transform(*nodes[n.get("ref")]) for n in way.findall("nd")])
                              for way in root.iter("way") if tags(way).get("name") == "Mostecká" and "highway" in tags(way)])
    rows = []
    for node in root.iter("node"):
        tag = tags(node)
        trade = 1 if tag.get("amenity") == "cafe" else TRADE.get(tag.get("shop"))
        if trade is None or tag.get("addr:street", "Mostecká") != "Mostecká":
            continue
        coords = nodes[node.get("id")]
        point = Point(to.transform(*coords))
        foot = nearest_points(street, point)[0]
        if 2 < foot.distance(point) < 16:
            rows.append([*[round(v,7) for v in back.transform(foot.x,foot.y)], *coords, trade])
    if not rows:
        raise ValueError("No mapped frontages on Mostecká")
    (ROOT / "src/map/mosteckaFrontages.json").write_text(json.dumps(sorted(rows),separators=(",",":"))+"\n", encoding="utf-8")


if __name__ == "__main__":
    build()
