"""Prague's streets surveyed kerb to kerb, from the digital technical map (DTM kraje,
"základní prostorová situace", set 2: the surfaces as polygons).

    uv run dtm.py            # download what's new and read it (build_tiles.py does this too)

IPR publishes the map every month as one GeoPackage per city district (57 of them,
about 130 MB zipped), downloaded into pipeline/.cache/dtm/ZPS_OPL/. Each is read
once: the carriageways, lay-bys and parking, with the level each is on (0 the ground,
1, 2, … bridges and decks, -1, … under the ground), go into dtm/surfaces.pkl in
WGS84, the same for every area. The map covers the city only; past its limits
streets() finds nothing and the pipeline sizes streets from OSM as before.

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
}
VERSION = 2  # bump when what surfaces() keeps changes

_index = None  # per process: (STRtree, polygons on the ground in WGS84)


def download():
    """Fetch the districts' packages that aren't here yet (a new month's have new names),
    removing the ones they replace."""
    listing = json.loads(_get(LIST))
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
    key = [VERSION, [(p.name, p.stat().st_size) for p in packages]]
    if PARSED.exists():
        with open(PARSED, "rb") as f:
            got = pickle.load(f)
        if got["key"] == key:
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
    tmp = PARSED.with_suffix(".tmp")
    with open(tmp, "wb") as f:
        pickle.dump({"key": key, "kinds": kinds}, f, protocol=5)
    tmp.replace(PARSED)
    return kinds


def streets(bbox, transform):
    """The street surfaces on the ground (carriageways, lay-bys and parking) that reach
    into a WGS84 box, joined into one geometry in the local metres that `transform`
    (lon, lat arrays → x, y arrays) gives. Empty where the map has nothing (past the
    city limits, or before the map has been downloaded)."""
    global _index
    if _index is None:
        kinds = surfaces() if any(PACKAGES.glob("*.zip")) else {}
        geoms = [g[levels == 0] for levels, g in kinds.values()]
        geoms = np.concatenate(geoms) if geoms else np.array([], dtype=object)
        _index = (STRtree(geoms), geoms)
    tree, geoms = _index
    hits = geoms[tree.query(box(*bbox))]
    if not len(hits):
        return Polygon()
    local = shapely.transform(hits, lambda c: np.column_stack(transform(c[:, 0], c[:, 1])))
    return shapely.union_all(shapely.make_valid(local), grid_size=0.01)


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
