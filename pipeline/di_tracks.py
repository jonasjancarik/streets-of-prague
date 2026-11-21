"""The tram tracks where they really are: OpenStreetMap's tracks moved onto the surveyed
track axes of the digital technical map.

    uv run di_tracks.py      # download what's new, match, and report how far tracks moved

OSM's tram tracks are traced by hand from aerial photos and are typically 0.3 m off,
in places 2-3 m, enough to run a track into a kerb or onto a stop's island. The DTM's
transport infrastructure set (DI, "dopravní infrastruktura", JVF) has every track's
centre line surveyed ("osa koleje tramvajové dráhy", position accuracy class 3). It
isn't in set 2 or 3 that dtm.py reads: the set is downloaded on its own, one zip per
district (all 57, about 31 MB), into pipeline/.cache/dtm/DI/.

The network, the switches, bridges and tunnels and which way a line goes all stay
OSM's: only the position of each OSM node on a tram track changes, to the nearest
point of the surveyed axis that runs the same way and belongs to that track. moved()
gives the moves keyed by the node's WGS84 coordinates, so osm_area (the rails drawn in
the tiles) and build_lines (the lines the trams run along) move the very same nodes the
same way, and the lines keep sharing their points. Where DI has no axis near a track,
OSM's position is kept.

A DI axis belongs to the OSM track nearest to it: with two tracks side by side 3 m
apart and OSM's one drawn 2 m off towards its neighbour, the neighbour's axis is
nearer to it, but that axis is nearer still to the neighbour's own OSM line, so the
node goes to the next axis, its own.

Source: DTM kraje – DI, datový podklad © IPR Praha (CC BY 4.0).
"""

import json
import math
import pickle
import re
import urllib.request
import zipfile
from pathlib import Path

import numpy as np
import shapely
from pyproj import Transformer
from shapely import STRtree

CACHE = Path(__file__).parent / ".cache" / "dtm" / "DI"
LIST = "https://geoportalpraha.cz/api/get-dtm-download-metadata?code=07"
FILE = "https://isdtmk.dtm-praha-sck.cz/api/istem/vydej/download/path/"
AXES = CACHE / "axes.pkl"
MOVES = CACHE / "moves.pkl"
TAG = "objtyp:OsaKolejeTramvajoveDrahy"

REACH = 3.2      # m: farthest an OSM node is moved (a track's neighbour is ~3 m away)
TURN = math.radians(25)  # an axis at more than this to the OSM track is another track
OWN = 0.05       # m of slack when checking that an axis is nearest to the node's own track

_memo = {}  # moved()'s last result in this process

TO_JTSK = Transformer.from_crs("EPSG:4326", "EPSG:5514", always_xy=True)
TO_WGS = Transformer.from_crs("EPSG:5514", "EPSG:4326", always_xy=True)


def key(lon, lat):
    """The coordinates OSM gives a node, as osm_area and build_lines both read them."""
    return round(float(lon), 7), round(float(lat), 7)


def download():
    """The DI zips of every district, fetched when the month's map is new; their paths."""
    CACHE.mkdir(parents=True, exist_ok=True)
    with urllib.request.urlopen(LIST, timeout=60) as r:
        listing = json.load(r)
    paths = []
    for district in listing:
        for f in district["formats"]:
            if f["kraj"] != "CZ010" or f["format"] != "JVF":
                continue
            path = CACHE / f["soubor_nazev"]
            if not (path.exists() and path.stat().st_size == int(f["velikost"])):
                print(f"di_tracks: downloading {f['soubor_nazev']}")
                with urllib.request.urlopen(FILE + f["kod_stazeni"], timeout=300) as r:
                    path.write_bytes(r.read())
            paths.append(path)
    return sorted(paths)


def local():
    """The newest DI zip of each district already downloaded, for running offline."""
    newest = {}
    for path in sorted(CACHE.glob("VS_CZ010_MOMC_*_DI.jvf.zip")):
        newest[re.search(r"MOMC_(\d+)_", path.name).group(1)] = path
    return sorted(newest.values())


def axes(paths):
    """Every surveyed tram track axis in the zips, as [n, 2] arrays in S-JTSK (EPSG:5514).
    Only the one object type is read, with a regular expression rather than a full XML
    parse (Praha 1's file alone is 13 MB of XML)."""
    stamp = [(p.name, p.stat().st_size) for p in paths]
    if AXES.exists():
        cached = pickle.loads(AXES.read_bytes())
        if cached["stamp"] == stamp:
            return cached["axes"]
    out = []
    for path in paths:
        with zipfile.ZipFile(path) as z:
            text = z.read(next(n for n in z.namelist() if n.endswith(".xml"))).decode("utf-8")
        a, b = text.find(f"<{TAG}>"), text.find(f"</{TAG}>")
        if a < 0:
            continue
        for pos in re.findall(r"<gml:posList>([^<]+)<", text[a:b]):
            xy = np.array(pos.split(), float).reshape(-1, 3)[:, :2]
            if len(xy) > 1:
                out.append(xy)
    AXES.write_bytes(pickle.dumps({"stamp": stamp, "axes": out}))
    return out


def match(nodes, ways, lines):
    """{node id: (x, y)} in S-JTSK for the OSM tram nodes that move onto a surveyed axis.
    `nodes`: {id: (x, y)} in S-JTSK; `ways`: node id sequences of the tram tracks;
    `lines`: the surveyed axes (axes())."""
    # The surveyed axes cut into segments.
    sa = np.concatenate([c[:-1] for c in lines])
    sb = np.concatenate([c[1:] for c in lines])
    keep = np.hypot(*(sb - sa).T) > 1e-3
    sa, sb = sa[keep], sb[keep]
    survey = STRtree(shapely.linestrings(np.stack([sa, sb], axis=1)))
    # OSM's tracks cut into segments, each with its way, and each node's ways and the
    # directions of its segments.
    oa, ob, owner = [], [], []
    node_ways, dirs = {}, {}
    for w, nds in enumerate(ways):
        nds = [n for n in nds if n in nodes]
        for a, b in zip(nds, nds[1:]):
            pa, pb = np.array(nodes[a]), np.array(nodes[b])
            d = pb - pa
            if np.hypot(*d) < 1e-3:
                continue
            oa.append(pa)
            ob.append(pb)
            owner.append(w)
            for n in (a, b):
                node_ways.setdefault(n, set()).add(w)
                dirs.setdefault(n, []).append(d / np.hypot(*d))
    oa, ob, owner = np.array(oa), np.array(ob), np.array(owner)
    osm = STRtree(shapely.linestrings(np.stack([oa, ob], axis=1)))

    ids = list(dirs)
    pts = np.array([nodes[n] for n in ids])
    near_n, near_s = survey.query(shapely.points(pts), predicate="dwithin", distance=REACH)
    cands = {}
    for i, s in zip(near_n, near_s):
        cands.setdefault(i, []).append(s)
    moved = {}
    for i, segs in cands.items():
        n, p = ids[i], pts[i]
        segs = np.array(segs)
        a, b = sa[segs], sb[segs]
        d = b - a
        length = np.hypot(*d.T)
        u = d / length[:, None]
        t = np.clip(((p - a) * u).sum(1), 0, length)
        foot = a + u * t[:, None]
        dist = np.hypot(*(foot - p).T)
        # Same way as the OSM track: at a switch, the same way as any of its branches.
        cos = np.abs(np.array(dirs[n]) @ u.T).max(0)
        ok = cos >= math.cos(TURN)
        for k in np.argsort(dist):
            if not ok[k]:
                continue
            # The axis must be nearest to this node's own track.
            q = shapely.points(foot[k])
            near = osm.query(q, predicate="dwithin", distance=dist[k] + OWN)
            if len(near):
                gap = shapely.distance(q, osm.geometries[near])
                own = gap[np.isin(owner[near], list(node_ways[n]))]
                other = gap[~np.isin(owner[near], list(node_ways[n]))]
                if len(other) and (not len(own) or other.min() + OWN < own.min()):
                    continue
            moved[n] = tuple(foot[k])
            break
    return moved


def moved(nodes=None, ways=None):
    """{key(lon, lat): (lon, lat)}: where each OSM tram node goes. Without arguments, from
    the local OSM extract's tram tracks (build_lines.load_pbf), cached until the extract
    or the DI files change; {} without either, so OSM's tracks are used as they are.
    `nodes`: {id: (lon, lat, ...)}, `ways`: {id: (tags, node ids)}, as load_pbf gives."""
    paths = local()
    if not paths:
        return {}
    if nodes is None:
        import build_lines
        if not build_lines.PBF.exists():
            return {}
        stamp = ([(p.name, p.stat().st_size) for p in paths], build_lines.PBF.stat().st_mtime,
                 Path(__file__).stat().st_mtime)
        if _memo.get("stamp") == stamp:
            return _memo["moves"]
        if MOVES.exists():
            cached = pickle.loads(MOVES.read_bytes())
            if cached["stamp"] == stamp:
                _memo.update(cached)
                return cached["moves"]
        nodes, ways, _ = build_lines.load_pbf(None)
    else:
        stamp = None
    tram = [nds for tags, nds in ways.values() if tags.get("railway") == "tram"]
    used = {n for nds in tram for n in nds if n in nodes}
    ids = list(used)
    lon = np.array([nodes[n][0] for n in ids])
    lat = np.array([nodes[n][1] for n in ids])
    x, y = TO_JTSK.transform(lon, lat)
    got = match(dict(zip(ids, zip(x, y))), tram, axes(paths))
    out = {}
    if got:
        gid = list(got)
        glon, glat = TO_WGS.transform(*np.array([got[n] for n in gid]).T)
        out = {key(*nodes[n][:2]): (float(a), float(b)) for n, a, b in zip(gid, glon, glat)}
    if stamp is not None:
        MOVES.write_bytes(pickle.dumps({"stamp": stamp, "moves": out}))
        _memo.update(stamp=stamp, moves=out)
    return out


def move_lines(geoms, moves):
    """The tram track geometries (WGS84 LineStrings) with their OSM nodes moved."""
    def f(c):
        out = c.copy()
        for k, (lo, la) in enumerate(c):
            m = moves.get(key(lo, la))
            if m is not None:
                out[k] = m
        return out
    return shapely.transform(geoms, f)


if __name__ == "__main__":
    import build_lines
    download()
    nodes, ways, _ = build_lines.load_pbf(None)
    moves = moved()
    tram = {n for tags, nds in ways.values() if tags.get("railway") == "tram" for n in nds if n in nodes}
    shift = []
    for n in tram:
        m = moves.get(key(*nodes[n][:2]))
        if m:
            a = TO_JTSK.transform(*nodes[n][:2])
            b = TO_JTSK.transform(*m)
            shift.append(math.dist(a, b))
    shift = np.array(shift)
    print(f"{len(shift)} of {len(tram)} OSM tram nodes moved onto a surveyed axis; "
          f"by median {np.median(shift):.2f} m, 95% {np.percentile(shift, 95):.2f} m, max {shift.max():.2f} m")
