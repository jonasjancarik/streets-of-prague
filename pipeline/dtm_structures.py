"""DTM road and structure evidence, kept apart from the ground height survey.

Source: DTM kraje – ZPS, datový podklad © IPR Praha (CC BY 4.0).
Coordinates are S-JTSK metres and original Bpv elevations. A structure polygon
describes an extent. The separately surveyed construction lines supply Z.
"""

import argparse
from contextlib import closing
import json
import pickle
import sqlite3
import tempfile
import zipfile
from pathlib import Path

import numpy as np
import shapely
from pyproj import Transformer
from shapely.geometry import LineString, Point, mapping

import build_cache
from dtm import CACHE, PACKAGES, _wkb
from dtm_heights import LINES, ON_EDGE, _inside


ROAD = "010000000503"
BRIDGE = "010000005803"
TUNNEL = "010000006203"
SUBWAY = "010000006603"
EDGE = "010000030402"
INNER = "010000032302"
SURFACES = {ROAD: "carriageway", BRIDGE: "bridge", TUNNEL: "tunnel", SUBWAY: "pedestrian underpass"}
LINE_TYPES = {EDGE: "transport edge", INNER: "transport subdivision"}
# In the ČÚZK ZPS schema, 1 is a carriageway edge and 6 is a median edge.
ROAD_EDGE_TYPES = {1, 6}
# Both approaches must agree with surveyed road edges. This allows for crossfall
# and the coarse terrain lattice at abutments, but not another storey of a crossing.
APPROACH_Z = 1.25

LEVEL = "UrovenUmisteniObjektuZPS"
ACCURACY_XY = "TridaPresnostiPoloha"
ACCURACY_Z = "TridaPresnostiVyska"
ACQUISITION = "ZpusobPorizeniZPS"
EDGE_TYPE = "TypDopravniStavbyNeboPlochy"
ATTRIBUTES = (
    "ID", LEVEL, ACCURACY_XY, ACCURACY_Z, ACQUISITION, EDGE_TYPE,
    "TypTunelu", "TypPozemniKomunikace", "TypVnitrnihoCleneniDopravniPlochy", "HraniceJinehoObjektu",
    "DatumZmeny", "DatumVkladu", "IDZmeny", "ICS", "ZapisObjektu",
)


def _quote(name):
    return '"' + name.replace('"', '""') + '"'


def _records(package, types, bounds, include_ground):
    with tempfile.TemporaryDirectory() as tmp, zipfile.ZipFile(package) as z:
        name = next(n for n in z.namelist() if n.endswith(".gpkg"))
        with closing(sqlite3.connect(z.extract(name, tmp))) as db:
            for (table,) in db.execute("select table_name from gpkg_contents order by table_name"):
                code = table.split("#")[-1][:12]
                if code not in types:
                    continue
                quoted = _quote(table)
                columns = {r[1].lower(): r[1] for r in db.execute(f"pragma table_info({quoted})")}
                attrs = [a for a in ATTRIBUTES if a.lower() in columns]
                select = ", ".join(["shape", *(_quote(columns[a.lower()]) for a in attrs)])
                where = "shape is not null"
                if not include_ground and code in {ROAD, EDGE, INNER}:
                    if LEVEL not in attrs:
                        continue
                    where += f" and {_quote(columns[LEVEL.lower()])} != 0"
                for blob, *values in db.execute(f"select {select} from {quoted} where {where}"):
                    shape = _inside(blob, bounds)
                    if shape is not None:
                        yield {"package": package.name, "code": code, "attrs": dict(zip(attrs, values)), "shape": shape}


def survey(bounds, *, include_ground=False, cache=True):
    """Original geometries intersecting an S-JTSK bounding box, with source attributes.

    Keep levels as supplied, including unknown values. Bridge, tunnel and pedestrian
    underpass footprints are read at every level. Carriageways and their line classes
    are limited to explicitly non-ground levels unless include_ground is requested.
    """
    packages = [(p, SURFACES) for p in sorted(PACKAGES.glob("*.zip"))]
    packages.extend((p, LINE_TYPES) for p in sorted(LINES.glob("*.zip")))
    identities = [build_cache.identity(p) for p, _ in packages]
    key = [identities, list(bounds), include_ground, SURFACES, LINE_TYPES, ATTRIBUTES,
           [build_cache.function_key(f) for f in (survey, _records, _quote, _inside, _wkb)], build_cache.runtime_key()]
    path = CACHE / "structure_survey" / f"{build_cache.key(key)[:24]}.pkl"
    if cache and (got := build_cache.load_pickle(path, key)):
        return got["records"]
    records = [r for p, types in packages for r in _records(p, types, bounds, include_ground)]
    current = [*sorted(PACKAGES.glob("*.zip")), *sorted(LINES.glob("*.zip"))]
    if [build_cache.identity(p) for p in current] != identities:
        raise RuntimeError("DTM packages changed while reading structure survey")
    if cache and records:
        path.parent.mkdir(parents=True, exist_ok=True)
        build_cache.atomic(path, pickle.dumps({"key": key, "records": records}, protocol=5))
    return records


def for_area(bbox, to_local):
    w, s, e, n = bbox
    tf = Transformer.from_crs(4326, 5514, always_xy=True)
    x, y = tf.transform([w, w, e, e], [s, n, s, n])
    return DeckSurvey(survey((min(x), min(y), max(x), max(y))), to_local)


def _aligned(a, b):
    """The two routes run along the same deck, rather than crossing its span."""
    u = np.subtract(a.coords[-1], a.coords[0])
    v = np.subtract(b.coords[-1], b.coords[0])
    return abs(u @ v) > 0.9 * np.linalg.norm(u) * np.linalg.norm(v)


def _source(record):
    return {"package": record["package"], "code": record["code"], **record["attrs"]}


class DeckSurvey:
    """Associate a missing carriageway with a bridge the terrain build already found."""

    def __init__(self, records, to_local):
        self.records, self.shapes = [], []
        seen = set()
        for r in records:
            a = r["attrs"]
            if a.get(LEVEL) not in (1, 2, 3) or a.get("ID") is None:
                continue
            road_edge = (r["code"] == EDGE and a.get(EDGE_TYPE) in ROAD_EDGE_TYPES
                         and a.get(ACCURACY_Z) in (1, 2, 3, 4, 5) and a.get(ACQUISITION) in (1, 2, 3))
            if r["code"] not in (ROAD, BRIDGE) and not road_edge:
                continue
            shape = r["shape"]
            key = (r["code"], a["ID"], a[LEVEL], shape.wkb)
            if key in seen:
                continue  # a feature repeated in overlapping district packages
            seen.add(key)
            shape = shapely.transform(shape, lambda x, y, *z: (*to_local(x, y), *z),
                                      include_z=None, interleaved=False)
            if r["code"] in (ROAD, BRIDGE):
                shape = shapely.make_valid(shape, method="structure", keep_collapsed=False)
            self.records.append(r)
            self.shapes.append(shape)
        self.tree = shapely.STRtree(self.shapes)

    def _hits(self, shape, code, level=None):
        for i in self.tree.query(shape, predicate="intersects"):
            a = self.records[i]
            if a["code"] == code and (level is None or a["attrs"].get(LEVEL) == level):
                yield int(i)

    def _anchors(self, spans):
        """Unambiguous bridge/road pairs that contain most of a known cutting deck."""
        matches = {}
        for span in spans:
            found = []
            for k in self._hits(span, BRIDGE):
                bridge = self.shapes[k]
                level = self.records[k]["attrs"][LEVEL]
                on_bridge = span.intersection(bridge)
                for r in self._hits(on_bridge, ROAD, level):
                    if on_bridge.intersection(self.shapes[r]).length >= 2 * span.length / 3:
                        found.append((k, r))
            if len(found) == 1:
                k, r = found[0]
                matches.setdefault(k, {})[r] = span
        return matches

    def _road_heights(self, span, road, level, ends):
        """Require measured edge vertices from the same carriageway across the span.

        A footprint or its subtype-16 edge may include sidewalks, fascia or other
        structure. Only original carriageway/median vertices support a road height.
        The approach heights remain the deck's end constraints.
        """
        kerb = road.boundary.buffer(ON_EDGE)
        ids, stations, heights = set(), [], []
        for k in self._hits(kerb, EDGE, level):
            edge = self.shapes[k]
            if edge.intersection(kerb).length <= edge.length / 2:
                continue  # a line merely touches the road at a junction or crossing
            xyz = shapely.get_coordinates(edge, include_z=True)
            xyz = xyz[np.isfinite(xyz).all(axis=1)]
            pts = shapely.points(xyz[:, :2])
            s = shapely.line_locate_point(span, pts)
            inside = shapely.covers(kerb, pts) & (s > 0.01) & (s < span.length - 0.01)
            if inside.any():
                ids.add(k)
                stations.extend(s[inside])
                heights.extend(xyz[inside, 2])
        if len(ids) < 2 or min(stations) > span.length / 4 or max(stations) < 3 * span.length / 4:
            return []
        expected = np.interp(stations, [0, span.length], ends)
        if np.max(np.abs(np.subtract(heights, expected))) > APPROACH_Z:
            return []
        return [_source(self.records[k]) for k in sorted(ids)]

    def companions(self, lower, known, candidates, ground, min_dip, max_grade):
        """Return (street edge, span, sources) for same-footprint companion carriageways.

        `known` are the original cutting spans, and each candidate contains an OSM
        street edge, its line and the connected chain through it. The polygon must
        cover the crossing, and the ground must come up to its measured road height
        at both ends. Otherwise keep the original cutting as found.
        """
        anchors = self._anchors(known)
        for edge, line, chain in candidates:
            at = line.intersection(lower)
            if at.geom_type != "Point" or at.is_empty or at in (Point(lower.coords[0]), Point(lower.coords[-1])):
                continue
            matches = []
            for k, covered in anchors.items():
                bridge = self.shapes[k]
                level = self.records[k]["attrs"][LEVEL]
                if not bridge.contains(at):
                    continue
                for r in self._hits(at, ROAD, level):
                    if r in covered:
                        continue
                    road = self.shapes[r]
                    if not road.contains(at):
                        continue
                    span = chain.intersection(bridge.intersection(road))
                    if (span.geom_type != "LineString" or span.length <= edge["width"]
                            or not any(_aligned(span, anchor) for anchor in covered.values())):
                        continue
                    ends = [span.coords[0], span.coords[-1]]
                    h = ground(*np.asarray([*ends, at.coords[0]]).T)
                    if (not np.isfinite(h).all() or min(h[:2]) - h[2] < min_dip
                            or abs(h[0] - h[1]) > max_grade * span.length):
                        continue
                    lines = self._road_heights(span, road, level, h[:2])
                    if lines:
                        matches.append((edge, span, {"bridge": _source(self.records[k]),
                                                     "road": _source(self.records[r]), "edges": lines}))
            if len(matches) == 1:
                yield matches[0]


def main():
    ap = argparse.ArgumentParser(description="Inspect the DTM's surveyed road and bridge objects near a coordinate")
    ap.add_argument("lat", type=float)
    ap.add_argument("lon", type=float)
    ap.add_argument("--radius", type=float, default=40, help="search radius in metres")
    ap.add_argument("--ground", action="store_true", help="include ground-level carriageways and lines")
    ap.add_argument("--geojson", action="store_true", help="include the source shapes as two-dimensional WGS84 GeoJSON")
    args = ap.parse_args()
    if not (-90 <= args.lat <= 90 and -180 <= args.lon <= 180):
        ap.error("enter latitude and longitude in degrees")
    if not np.isfinite(args.radius) or args.radius <= 0:
        ap.error("radius must be positive and finite")
    tf = Transformer.from_crs("EPSG:4326", "EPSG:5514", always_xy=True)
    back = Transformer.from_crs("EPSG:5514", "EPSG:4326", always_xy=True)
    point = Point(*tf.transform(args.lon, args.lat))
    records = survey(point.buffer(args.radius).bounds, include_ground=args.ground)
    features = []
    for r in sorted(records, key=lambda r: r["shape"].distance(point)):
        shape = r["shape"]
        distance = shape.distance(point)
        if distance > args.radius:
            continue
        z = shapely.get_coordinates(shape, include_z=True)[:, 2]
        z = z[np.isfinite(z)]
        props = {"code": r["code"], "kind": (SURFACES | LINE_TYPES)[r["code"]], "package": r["package"],
                 "distance_m": round(distance, 2), "z_m": [float(z.min()), float(z.max())] if len(z) else None,
                 **r["attrs"]}
        if args.geojson:
            geom = shapely.transform(shape, back.transform, include_z=False, interleaved=False)
            features.append({"type": "Feature", "properties": props, "geometry": mapping(geom)})
        else:
            features.append(props)
    print(json.dumps({"type": "FeatureCollection", "features": features} if args.geojson else features,
                     ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
