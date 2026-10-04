"""Prague's streets surveyed kerb to kerb, from the digital technical map (DTM kraje,
"základní prostorová situace", set 2: the surfaces as polygons).

    uv run dtm.py            # download what's new and read it (build_tiles.py does this too)

IPR publishes the map every month as one GeoPackage per city district (57 of them,
about 130 MB zipped), downloaded into pipeline/.cache/dtm/ZPS_OPL/. Each is read
once: carriageways, lay-bys, parking, courtyards and selected greenery, with the level each is on (0 the ground,
1, 2, … bridges and decks, -1, … under the ground), go into dtm/surfaces.pkl in
WGS84, the same for every area. The map covers the city only; past its limits
streets() finds nothing and the pipeline sizes streets from OSM as before. land()
returns the surveyed ground polygons without rounding their corners.

Source: DTM kraje – ZPS, datový podklad © IPR Praha (CC BY 4.0).
"""

import json
import pickle
import sqlite3
import tempfile
import urllib.request
import zipfile
from pathlib import Path

import numpy as np
import shapely
from pyproj import Transformer
from pyproj.aoi import AreaOfInterest
from shapely import STRtree
from shapely.geometry import Polygon, box
import build_cache

CACHE = Path(__file__).parent / ".cache" / "dtm"
PACKAGES = CACHE / "ZPS_OPL"
PARSED = CACHE / "surfaces.pkl"
LIST = "https://geoportalpraha.cz/api/get-dtm-download-metadata?code=02"
FILE = "https://isdtmk.dtm-praha-sck.cz/api/istem/vydej/download/path/"

# The DTM's object types the pipeline uses, by their code (the start of each table's
# last name part, e.g. "010000000503_Provozní_plocha_pozemní_komunikace"). Pavements,
# traffic islands and medians are what's left between them and the buildings.
KINDS = {
    "010000000503": "road",       # provozní plocha pozemní komunikace: the carriageway
    "010000032003": "roadside",   # přidružená plocha pozemní komunikace: lay-bys, bus bays
    "010000001103": "parking",    # parkoviště, odstavná plocha: parking bays and car parks
    "010000018903": "yard",       # dvůr, nádvoří
    "010000021503": "green",      # udržovaná plocha zeleně
    "010000020903": "garden",     # zahrada
    "010000015203": "pitch",      # hřiště
    "010000021103": "wood",       # les
}
VERSION = 3  # bump when what surfaces() keeps changes
STREET_KINDS = ("road", "roadside", "parking")
LAND_KINDS = ("yard", "green", "garden", "pitch", "wood")
# The survey draws a street corner's curve as a few straight pieces, and where two
# surfaces meet their edges often miss by a hand's width. Gaps and spikes narrower
# than twice SLIVER go, then each corner is cut ROUNDS times, at most CUT metres
# along each side and never more than a quarter of the shorter side: a corner between
# long kerbs comes out round, while a parking bay's short sides stay nearly square.
SLIVER = 0.3
CUT, ROUNDS = 1.5, 3
MARGIN = 0.0005  # degrees (~40 m) past the box, so neighbouring boxes round alike

_index = None  # per process: (STRtree, polygons on the ground in WGS84)
_land_index = None  # per process: (STRtree, polygons, kind labels)
_parking_index = None  # per process: (STRtree, parking polygons on the ground in WGS84)


def download():
    """Fetch the districts' packages that aren't here yet (a new month's have new names),
    removing the ones they replace."""
    global _index, _land_index, _parking_index
    listing = json.loads(_get(LIST))
    _index = _land_index = _parking_index = None
    PACKAGES.mkdir(parents=True, exist_ok=True)
    keep = set()
    for district in listing:
        for f in district["formats"]:
            if f["format"] != "GPKG" or f["kraj"] != "CZ010":
                continue
            path = PACKAGES / f["soubor_nazev"]
            keep.add(path)
            if path.exists() and path.stat().st_size == int(f["velikost"]):
                continue
            print(f"dtm: downloading {district['obec']} ({int(f['velikost']) / 1e6:.1f} MB)", flush=True)
            tmp = path.with_suffix(".part")
            tmp.write_bytes(_get(FILE + f["kod_stazeni"]))
            with zipfile.ZipFile(tmp) as z:
                if z.testzip() is not None:
                    raise RuntimeError(f"{path.name} came broken")
            tmp.replace(path)
    if keep:
        for old in set(PACKAGES.glob("*.zip")) - keep:
            old.unlink()


def surfaces():
    """{kind: (levels, polygons in WGS84)} for all of Prague, read from the packages once
    and kept in surfaces.pkl until they change."""
    packages = sorted(PACKAGES.glob("*.zip"))
    key = [VERSION, [build_cache.identity(p) for p in packages], KINDS,
           [build_cache.function_key(f) for f in (surfaces, _read, _wkb)], build_cache.runtime_key()]
    got = build_cache.load_pickle(PARSED, key)
    if got:
        print("dtm: parsed cache hit", flush=True)
        return got["kinds"]
    to_wgs = Transformer.from_crs("EPSG:5514", "EPSG:4326", always_xy=True,
                                  area_of_interest=AreaOfInterest(14.2, 49.9, 14.8, 50.2))
    found = {k: ([], []) for k in KINDS.values()}
    print(f"dtm: reading the {len(packages)} districts' maps", flush=True)
    for p in packages:
        for kind, level, geom in _read(p):
            found[kind][0].append(level)
            found[kind][1].append(geom)
    kinds = {}
    for kind, (levels, geoms) in found.items():
        geoms = shapely.transform(np.array(geoms, dtype=object),
                                  lambda c: np.column_stack(to_wgs.transform(c[:, 0], c[:, 1])))
        kinds[kind] = (np.array(levels, dtype=np.int8), geoms)
    CACHE.mkdir(parents=True, exist_ok=True)
    if [build_cache.identity(p) for p in sorted(PACKAGES.glob("*.zip"))] != key[1]:
        raise RuntimeError("DTM packages changed while parsing")
    build_cache.atomic(PARSED, pickle.dumps({"key": key, "kinds": kinds}, protocol=5))
    return kinds


def _indexes():
    """Both worker indexes from one unpickle; don't retain the unused upper levels."""
    global _index, _land_index, _parking_index
    if _index is not None and _land_index is not None and _parking_index is not None:
        return
    kinds = surfaces() if any(PACKAGES.glob("*.zip")) else {}
    street = [kinds[k][1][kinds[k][0] == 0] for k in STREET_KINDS if k in kinds]
    geoms = np.concatenate(street) if street else np.array([], dtype=object)
    _index = (STRtree(geoms), geoms)
    groups = [(k, kinds[k][1][kinds[k][0] == 0]) for k in LAND_KINDS if k in kinds]
    geoms = np.concatenate([g for _, g in groups]) if groups else np.array([], dtype=object)
    labels = np.concatenate([np.full(len(g), k, dtype=object) for k, g in groups]) if groups else np.array([], dtype=object)
    _land_index = (STRtree(geoms), geoms, labels)
    parking = kinds["parking"][1][kinds["parking"][0] == 0] if "parking" in kinds else np.array([], dtype=object)
    _parking_index = (STRtree(parking), parking)


def streets(bbox, transform):
    """The street surfaces on the ground (carriageways, lay-bys and parking) that reach
    into a WGS84 box, joined into one geometry in the local metres that `transform`
    (lon, lat arrays → x, y arrays) gives. Empty where the map has nothing (past the
    city limits, or before the map has been downloaded)."""
    _indexes()
    tree, geoms = _index
    w, s, e, n = bbox
    hits = geoms[tree.query(box(w - MARGIN, s - MARGIN, e + MARGIN, n + MARGIN))]
    if not len(hits):
        return Polygon()
    local = shapely.transform(hits, lambda c: np.column_stack(transform(c[:, 0], c[:, 1])))
    return _smooth(shapely.union_all(shapely.make_valid(local), grid_size=0.01))


def land(bbox, transform):
    """Ground-level DTM yards and greenery in local metres, without kerb rounding."""
    _indexes()
    tree, geoms, labels = _land_index
    w, s, e, n = bbox
    hits = tree.query(box(w - MARGIN, s - MARGIN, e + MARGIN, n + MARGIN), predicate="intersects")
    out = {}
    for kind in LAND_KINDS:
        chosen = geoms[hits[labels[hits] == kind]]
        if not len(chosen):
            continue
        local = shapely.transform(chosen, lambda c: np.column_stack(transform(c[:, 0], c[:, 1])))
        out[kind] = shapely.union_all(shapely.make_valid(local), grid_size=0.01)
    return out


def parking(bbox, transform):
    """The surveyed parking bays and car parks on the ground that reach into a WGS84
    box, in local metres like land(), without the kerb rounding streets() does."""
    _indexes()
    tree, geoms = _parking_index
    w, s, e, n = bbox
    hits = geoms[tree.query(box(w - MARGIN, s - MARGIN, e + MARGIN, n + MARGIN), predicate="intersects")]
    if not len(hits):
        return Polygon()
    local = shapely.transform(hits, lambda c: np.column_stack(transform(c[:, 0], c[:, 1])))
    return shapely.union_all(shapely.make_valid(local), grid_size=0.01)


def _smooth(g):
    """The surfaces with slivers closed, spikes gone and corners rounded (see CUT)."""
    g = g.buffer(SLIVER, join_style="round").buffer(-2 * SLIVER, join_style="round").buffer(SLIVER, join_style="round")
    polys = [Polygon(_round(p.exterior), [_round(r) for r in p.interiors])
             for p in shapely.get_parts(g) if p.geom_type == "Polygon"]
    return shapely.union_all(shapely.make_valid(np.array(polys, dtype=object)), grid_size=0.01) if polys else Polygon()


def _round(ring):
    """A ring with its corners cut, Chaikin's way but limited to CUT."""
    p = shapely.get_coordinates(ring)[:-1]
    for _ in range(ROUNDS):
        d = np.roll(p, -1, axis=0) - p
        length = np.linalg.norm(d, axis=1, keepdims=True)
        u = d / np.maximum(length, 1e-9)
        c = np.minimum(np.minimum(length, np.roll(length, 1, axis=0)) / 4, CUT)
        p = np.stack([p - np.roll(u, 1, axis=0) * c, p + u * c], axis=1).reshape(-1, 2)
    return p


def _read(package):
    """(kind, level, polygon in S-JTSK) of every surface of the kinds wanted in a package."""
    with tempfile.TemporaryDirectory() as tmp, zipfile.ZipFile(package) as z:
        name = next(n for n in z.namelist() if n.endswith(".gpkg"))
        db = sqlite3.connect(z.extract(name, tmp))
        for (table,) in db.execute("select table_name from gpkg_contents").fetchall():
            kind = KINDS.get(table.split("#")[-1][:12])
            if not kind:
                continue
            cols = {r[1] for r in db.execute(f'pragma table_info("{table}")')}
            level = "UrovenUmisteniObjektuZPS" if "UrovenUmisteniObjektuZPS" in cols else "0"
            for blob, lv in db.execute(f'select shape, {level} from "{table}" where shape is not null'):
                g = shapely.from_wkb(_wkb(blob))
                if g is not None and not g.is_empty:
                    yield kind, int(lv or 0), g
        db.close()


def _wkb(blob):
    """The WKB inside a GeoPackage geometry: a header, an optional envelope, then WKB."""
    envelope = (0, 32, 48, 48, 64)[(blob[3] >> 1) & 7]
    return blob[8 + envelope:]


def _get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "streets-of-prague pipeline"})
    with urllib.request.urlopen(req, timeout=300) as r:
        return r.read()


if __name__ == "__main__":
    download()
    for kind, (levels, geoms) in surfaces().items():
        counts = dict(zip(*(v.tolist() for v in np.unique(levels, return_counts=True))))
        print(f"{kind:9s} {len(geoms):6d} polygons, by level {counts}")
