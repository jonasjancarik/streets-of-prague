"""Bridges and tunnels: the parts of the streets that aren't on the ground, with
heights of their own.

The OSM ways on a bridge or in a tunnel come from each chunk's OSM data
(structure_ways, kept with the streets layer); ipr_terrain.py works out their
heights (build) once it has the bare terrain:

- Where a bridge or a tunnel meets a street on the ground, it's at the ground's
  height; in between, heights run evenly from one such end to the next, along the
  ways (and through junctions, as in Blanka's underground ramps).
- Bridges take the height of their deck from IPR's 3D model of Prague's bridges
  wherever it has them (672 bridges, most of those in the city), which gives the
  deck its real rise and fall; a bridge IPR doesn't have runs evenly between its ends.
- Tunnels run at least a few metres under the ground above them, deeper the
  further they are from a portal.
- Where one bridge or tunnel crosses another on a different OSM layer, the upper
  one clears the lower by a storey.

Bridges (OSM's bridge ways and man_made=bridge outlines) and tunnels are then put
on levels: 1, 2, … above the ground and -1, -2, … below it, so that no two that
overlap at different heights share a level. The game gets each level's outline and
heights per tile (ipr_terrain.py writes them).

Source for the bridges' decks: IPR Praha, 3D model mostů (datový podklad © IPR
Praha, CC BY), downloaded once into pipeline/.cache/ipr/mosty/.
"""

import heapq
import io
import math
import pickle
import urllib.request
import zipfile
import zlib
from collections import defaultdict

import numpy as np
from scipy.sparse import coo_matrix
from scipy.sparse.linalg import spsolve
import shapely
import shapely.ops
from shapely import STRtree
from shapely.geometry import LineString, Polygon
from shapely.ops import unary_union

from ipr_buildings import CACHE, krovak_to_local
import build_cache

DENSE = 5.0  # m between the points a structure's heights are worked out at
PAD = 6.0  # m of heights past a structure's edge (more than a lattice diagonal)
COVER = 8.0  # m of ground over a tunnel, away from its portals
COVER_SLOPE = 0.25  # how quickly a tunnel goes under that cover from a portal
SHALLOW = 2.5  # m: a tunnel that never gets this far under the ground is just a passage on it
CLEAR = 5.5  # m between a bridge or tunnel and one crossing it on another layer
WATER_CLEAR = 5.5  # m between open water and a bridge over it, away from the banks
WATER_SLOPE = 0.08  # how quickly a bridge rises to that from where it leaves the ground
STAIRS_SLOPE = 0.5  # and how quickly stairs do
STAIRS_MAX = 0.8  # steeper than this isn't even stairs
ON_FOOT = {"footway", "path", "pedestrian", "steps"}
SOFT = 0.05  # how much less a link along stairs holds two heights together than one along a deck
BESIDE = 10.0  # m: two structures this close share lattice points (PAD, and a cell's diagonal)
SAME = 3.0  # m: two structures further apart in height than this can't share a level
STAIRS_SAME = 1.0  # m: the same for stairs (which have their own profile) and what's beside them
NO_HIGHWAY = {"proposed", "construction", "elevator", "platform", "bus_stop", "abandoned", "razed", "planned"}
STATION_FOOT = {"footway", "steps", "corridor", "pedestrian", "path"}  # a station's ways inside
STATION = 30.0  # m from a metro station, platform or stop: its corridors and stairs
MOSTY_ITEM ="622e66a29f3d459a8dbc57939954db8c"  # IPR's mosty_shp


def structure_kind(tags):
    """'bridge', 'tunnel' or None for a way's tags. Passages through buildings are on
    the ground (see osm_area.py)."""
    if tags.get("bridge") not in (None, "no"):
        return "bridge"
    if tags.get("tunnel") not in (None, "no", "building_passage"):
        return "tunnel"
    return None


def is_subway_station(tags):
    """A metro station, its platform or its stop in OSM (a node, or a way round it)."""
    if tags.get("station") == "subway":
        return True
    return tags.get("subway") == "yes" and (tags.get("railway") in ("station", "stop", "platform")
                                           or tags.get("public_transport") in ("station", "stop_position", "platform"))


def station_ways(els, tf, ground=frozenset()):
    """The ids of the ways that are a metro station's corridors and stairs: OSM tags them
    tunnel=yes, but they're the station inside, not tunnels to walk through. Footways
    and stairs in tunnels, taken together where they meet, are left out as a whole if
    any of them is indoors (indoor=*), reaches a metro entrance (railway=subway_entrance),
    comes within STATION metres of a metro station, platform or stop, or is inside a
    station's outline. Underpasses away from the metro (under the magistrála by Hlavní
    nádraží, say) stay. `ground`: ways tagged as tunnels that are passages through
    buildings at street level (osm_area.extract's ground_ways), neither."""
    where = {el["id"]: (el["lon"], el["lat"]) for el in els if el["type"] == "node"}
    entrances = {el["id"] for el in els if el["type"] == "node" and el.get("tags", {}).get("railway") == "subway_entrance"}
    near, outlines = [], []
    for el in els:
        tags = el.get("tags", {})
        if el["type"] == "node" and is_subway_station(tags):
            near.append(where[el["id"]])
        elif el["type"] == "way" and is_subway_station(tags):
            pts = [where[n] for n in el["nodes"] if n in where]
            near += pts
            if len(pts) > 3 and el["nodes"][0] == el["nodes"][-1]:
                outlines.append(Polygon(list(zip(*tf.transform(*zip(*pts))))).buffer(0))
    foot = {el["id"]: el for el in els if el["type"] == "way" and el.get("tags", {}).get("highway") in STATION_FOOT
            and structure_kind(el["tags"]) == "tunnel" and el["id"] not in ground}
    if not foot:
        return set()
    # Group the footways that meet (share a node) into one piece each.
    parent = {i: i for i in foot}

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a
    first = {}
    for i, el in foot.items():
        for n in el["nodes"]:
            parent[find(i)] = find(first.setdefault(n, i))
    pieces = defaultdict(list)
    for i in foot:
        pieces[find(i)].append(i)
    stations = STRtree(shapely.points([tf.transform(*p) for p in near]) if near else [])
    inside = STRtree(outlines)
    out = set()
    for ids in pieces.values():
        nodes = {n for i in ids for n in foot[i]["nodes"]}
        pts = [tf.transform(*where[n]) for n in nodes if n in where]
        line = shapely.multipoints(pts) if pts else None
        if (any("indoor" in foot[i]["tags"] for i in ids) or nodes & entrances
                or (line is not None and (len(stations.query(line, predicate="dwithin", distance=STATION))
                                          or len(inside.query(line, predicate="intersects"))))):
            out.update(ids)
    return out


def structure_ways(data, tf, ground=frozenset()):
    """Every highway on a bridge or in a tunnel in a chunk's OSM data (osmnx's JSON of
    it): {id, kind, layer, hw, w, pts, nodes, grade}, `grade` saying for each node
    whether a way on the ground meets it there (or the way ends there, on its own).
    `on_ground` records only observed ground contact. A way alone in one chunk
    may continue in another: merge_ways decides loose ends after combining chunks.
    A metro station's corridors and stairs aren't tunnels (station_ways), and nor are
    the passages through buildings in `ground` (osm_area.extract's ground_ways)."""
    from osm_area import road_width, _float

    els = data["elements"]
    where = {el["id"]: (el["lon"], el["lat"]) for el in els if el["type"] == "node"}
    inside = station_ways(els, tf, ground)
    ways = [el for el in els if el["type"] == "way" and el.get("tags", {}).get("highway") not in (None, *NO_HIGHWAY)
            and el["id"] not in inside]

    def kind_of(el):
        return None if el["id"] in ground else structure_kind(el["tags"])
    on_ground, uses = set(), defaultdict(int)
    for el in ways:
        for n in el["nodes"]:
            uses[n] += 1
        if not kind_of(el):
            on_ground.update(el["nodes"])
    out = []
    for el in ways:
        tags = el["tags"]
        kind = kind_of(el)
        nodes = [n for n in el["nodes"] if n in where]
        if not kind or len(nodes) < 2:
            continue
        xs, ys = tf.transform([where[n][0] for n in nodes], [where[n][1] for n in nodes])
        try:
            layer = int(float(tags.get("layer", "")))
            mapped_layer = layer
        except ValueError:
            layer = 1 if kind == "bridge" else -1
            mapped_layer = None
        hw = tags["highway"]
        ends = {nodes[0], nodes[-1]}
        out.append({
            "id": el["id"], "kind": kind, "layer": layer, "hw": hw,
            "mapped_layer": mapped_layer,
            "w": round(road_width(hw, _float(tags.get("width")), _float(tags.get("lanes"))), 1),
            "pts": [[round(x, 2), round(y, 2)] for x, y in zip(xs, ys)], "nodes": nodes,
            "grade": [n in on_ground or (n in ends and uses[n] == 1) for n in nodes],
            "on_ground": [n in on_ground for n in nodes],
        })
    return out


# ---- IPR's bridges ------------------------------------------------------------------

def bridge_shapefile(download=False):
    shp = CACHE / "mosty" / "mosty.shp"
    if download and not shp.exists():
        print("  downloading IPR's bridges…")
        data = urllib.request.urlopen(f"https://www.arcgis.com/sharing/rest/content/items/{MOSTY_ITEM}/data").read()
        shp.parent.mkdir(parents=True, exist_ok=True)
        zipfile.ZipFile(io.BytesIO(data)).extractall(shp.parent)
    return shp


def bridge_files():
    shp = bridge_shapefile()
    return sorted({shp, *(p for p in shp.parent.glob("*") if p.is_file())})


def ipr_decks(local, source_manifest=None):
    """IPR's bridges' flat faces on a 1 m grid in the local metres: {cell: heights},
    cell = (round(x), round(y)). Kept per area in pipeline/.cache/ipr/parsed/.
    Optional source_manifest receives the shapefile identities used by this cache.
    """
    cache = CACHE / "parsed" / f"mosty_{zlib.crc32(local.encode()):08x}.pkl"
    shp = bridge_shapefile(download=True)
    sources = build_cache.sources(bridge_files())
    if source_manifest is not None:
        source_manifest.update(sources)
    key = [1, local, sources, build_cache.function_key(ipr_decks),
           build_cache.reach_key(build_cache.PIPELINE / "ipr_buildings.py", ["krovak_to_local"], imports=True),
           build_cache.runtime_key(build_cache.PACKAGES["terrain"])]
    got = build_cache.load_pickle(cache, key)
    if got:
        return got["decks"]
    import geopandas as gpd
    polys = [np.asarray(p.exterior.coords) for p in gpd.read_file(shp).geometry if p is not None]
    flat = []
    for c in polys:
        if len(c) < 4 or c.shape[1] < 3:
            continue
        # Newell's normal: only faces that lie flat (a deck, not its sides).
        nx = np.sum((c[:-1, 1] - c[1:, 1]) * (c[:-1, 2] + c[1:, 2]))
        ny = np.sum((c[:-1, 2] - c[1:, 2]) * (c[:-1, 0] + c[1:, 0]))
        nz = np.sum((c[:-1, 0] - c[1:, 0]) * (c[:-1, 1] + c[1:, 1]))
        if abs(nz) > 0.97 * math.sqrt(nx * nx + ny * ny + nz * nz) > 0:
            flat.append(c)
    to_local = krovak_to_local(local)
    allc = np.concatenate(flat)
    lx, ly = to_local.transform(allc[:, 0], allc[:, 1])
    cells = defaultdict(list)
    at = 0
    for c in flat:
        n = len(c)
        x, y, z = lx[at:at + n], ly[at:at + n], c[:, 2]
        at += n
        poly = Polygon(np.column_stack([x, y]))
        if not poly.is_valid or poly.area < 1:
            continue
        # The face's plane, z = a x + b y + d, through its corners.
        A = np.column_stack([x, y, np.ones(n)])
        (a, b, d), *_ = np.linalg.lstsq(A, z, rcond=None)
        x0, y0, x1, y1 = poly.bounds
        gx, gy = np.meshgrid(np.arange(math.floor(x0), math.ceil(x1) + 1), np.arange(math.floor(y0), math.ceil(y1) + 1))
        inside = shapely.contains_xy(poly, gx, gy)
        for px, py in zip(gx[inside], gy[inside]):
            cells[(int(px), int(py))].append(round(float(a * px + b * py + d), 2))
    out = {k: np.array(v, dtype=np.float32) for k, v in cells.items()}
    cache.parent.mkdir(parents=True, exist_ok=True)
    if not build_cache.sources_current(sources):
        raise RuntimeError("IPR bridge sources changed while parsing")
    build_cache.atomic(cache, pickle.dumps({"key": key, "decks": out}, protocol=5))
    print(f"  IPR's bridges: {len(flat)} flat faces over {len(out)} m²")
    return out


def deck_at(decks, x, y, guess, below=4.0, above=3.0):
    """The top of IPR's deck at (x, y) near the height `guess` (a height in metres
    above sea level), or NaN: the highest flat face within the window, which is the
    deck's surface rather than the underside or a pier below."""
    hs = decks.get((int(round(x)), int(round(y))))
    if hs is None:
        return np.nan
    ok = hs[(hs > guess - below) & (hs < guess + above)]
    return float(ok.max()) if len(ok) else np.nan


# ---- Heights along the ways -----------------------------------------------------------

class Net:
    """The structures' ways as a graph: their OSM nodes (shared where ways meet) and
    points in between every DENSE metres, each with a height to work out."""

    def __init__(self, ways, soft=frozenset()):
        self.xy, self.key, self.adj = [], {}, []
        self.soft = set()  # the links along stairs: where a height changes, it changes there
        self.climb = []  # per point: (neighbour, how far a way can rise between the two)
        self.kind = []
        self.paths = []  # per way: its points, in order
        self._non_bridge_seeds = []
        for w in ways:
            path = []
            pts, nodes = w["pts"], w["nodes"]
            for i in range(len(pts)):
                path.append(self.node(("n", nodes[i]), pts[i], w["kind"]))
                if i + 1 < len(pts):
                    (ax, ay), (bx, by) = pts[i], pts[i + 1]
                    n = max(1, math.ceil(math.hypot(bx - ax, by - ay) / DENSE))
                    for k in range(1, n):
                        path.append(self.node(("d", w["id"], i, k), (ax + (bx - ax) * k / n, ay + (by - ay) * k / n), w["kind"]))
            rate = STAIRS_SLOPE if w.get("hw") == "steps" else WATER_SLOPE
            for a, b in zip(path, path[1:]):
                d = math.dist(self.xy[a], self.xy[b]) or 0.01
                self.adj[a].append((b, d))
                self.adj[b].append((a, d))
                self.climb[a].append((b, d * rate))
                self.climb[b].append((a, d * rate))
                if w["id"] in soft:
                    self.soft.add((a, b))
                    self.soft.add((b, a))
            self.paths.append(path)
            if path and w['kind'] != 'bridge':
                self._non_bridge_seeds.append(path[0])
        self.xy = np.asarray(self.xy, dtype=float).reshape(-1, 2)
        self.h = np.full(len(self.xy), np.nan)

    def node(self, key, xy, kind):
        i = self.key.get(key)
        if i is None:
            i = self.key[key] = len(self.adj)
            self.xy.append(tuple(xy))
            self.adj.append([])
            self.climb.append([])
            self.kind.append(kind)
        return i

    def rise(self, fixed):
        """How far above its ends on the ground a way can have got at each point: a
        street's grade along streets, a flight of stairs' along stairs."""
        best = np.full(len(self.adj), np.inf)
        heap = [(0.0, int(i)) for i in fixed]
        heapq.heapify(heap)
        while heap:
            d, i = heapq.heappop(heap)
            if d >= best[i]:
                continue
            best[i] = d
            for j, more in self.climb[i]:
                if d + more < best[j]:
                    heapq.heappush(heap, (d + more, j))
        return best

    def spread(self, fixed):
        """Harmonic heights for complete bridge components; legacy elsewhere.

        Linear on a chain and continuous at junctions, rather than switching
        between two nearest anchors that may both lie on one side. Return shortest
        graph distances to the nearest provided anchor, independently of heights.
        Components with no anchor stay unknown; one anchor gives a constant height.
        Components containing tunnels, or any non-finite anchor, retain the prior
        two-nearest propagation. In particular an unknown portal outside the map
        must not erase a tunnel's supported interior and shared bridge transitions.
        """
        n = len(self.adj)
        self.h.fill(np.nan)
        near = np.full(n, np.inf)
        if not fixed or not n:
            return near
        heap = [(0.0, int(i)) for i in fixed]
        heapq.heapify(heap)
        while heap:
            d, i = heapq.heappop(heap)
            if d >= near[i]:
                continue
            near[i] = d
            for j, length in self.adj[i]:
                if d + length < near[j]:
                    heapq.heappush(heap, (d + length, j))

        # Topology does not change between the ground, deck and crossing passes.
        # Reuse the Laplacian; only its fixed/free partition changes.
        if not hasattr(self, "_laplacian"):
            rows, cols, values = [], [], []
            for i, neighbours in enumerate(self.adj):
                degree = 0.0
                for j, length in neighbours:
                    weight = (SOFT if (i, j) in self.soft else 1.0) / length
                    rows.append(i); cols.append(j); values.append(-weight)
                    degree += weight
                rows.append(i); cols.append(i); values.append(degree)
            self._laplacian = coo_matrix((values, (rows, cols)), shape=(n, n)).tocsr()
            self._components = np.asarray(components(self), dtype=np.int32)
            order = np.argsort(self._components, kind="stable")
            splits = np.flatnonzero(np.r_[True, self._components[order][1:] != self._components[order][:-1]])
            self._component_nodes = {int(self._components[order[a]]): order[a:b]
                                     for a, b in zip(splits, np.r_[splits[1:], n])}
            self._legacy_components = {int(self._components[i]) for i in self._non_bridge_seeds}
        comp = self._components
        anchors = defaultdict(list)
        pinned = np.zeros(n, dtype=bool)
        for i, h in fixed.items():
            pinned[i] = True
            self.h[i] = h
            anchors[int(comp[i])].append((int(i), float(h)))
        active = np.zeros(n, dtype=bool)
        limits = np.full((n, 2), np.nan)  # component IDs are their seed node indices
        legacy = {}
        for component, points in anchors.items():
            heights = np.array([h for _, h in points])
            if component in self._legacy_components or not np.isfinite(heights).all():
                legacy.update(points)
                continue
            on = self._component_nodes[component]
            if np.all(heights == heights[0]):
                self.h[on] = heights[0]  # includes the one-anchor case, exactly
            else:
                active[on] = True
                limits[component] = [heights.min(), heights.max()]
        if legacy:
            self._spread_nearest(legacy)
        free = np.flatnonzero(active & ~pinned)
        if len(free):
            pins = np.flatnonzero(pinned & active)
            matrix = self._laplacian[free][:, free]
            rhs = -(self._laplacian[free][:, pins] @ self.h[pins])
            solved = np.asarray(spsolve(matrix, rhs), dtype=float)
            if solved.shape != free.shape:
                raise RuntimeError(f"bridge height solve returned shape {solved.shape}, expected {free.shape}")
            bad = np.flatnonzero(~np.isfinite(solved))
            if len(bad):
                i = int(free[bad[0]])
                raise RuntimeError(f"bridge height solve component {comp[i]} returned a non-finite height at node {i}")
            lo, hi = limits[comp[free]].T
            tolerance = 1e-6 + 1e-9 * np.maximum(np.abs(lo), np.abs(hi))
            bad = np.flatnonzero((solved < lo - tolerance) | (solved > hi + tolerance))
            if len(bad):
                j = int(bad[0]); i = int(free[j])
                raise RuntimeError(f"bridge height solve component {comp[i]} returned {solved[j]:.9g} m at node {i}, "
                                   f"outside fixed range [{lo[j]:.9g}, {hi[j]:.9g}] m (tolerance {tolerance[j]:.3g} m)")
            self.h[free] = solved
        return near

    def _spread_nearest(self, fixed):
        """Original propagation, restricted to selected disconnected components.

        Unknown anchors stay unknown; a node supported by two nearer finite pins
        can still have a finite height. Component selection keeps one shared model
        for tunnels and the bridges physically connected to them.
        """
        best = [[] for _ in self.adj]
        heap = [(0.0, i, i) for i in fixed]
        heapq.heapify(heap)
        while heap:
            d, i, src = heapq.heappop(heap)
            b = best[i]
            if len(b) >= 2 or any(s == src for _, s in b):
                continue
            b.append((d, src))
            for j, length in self.adj[i]:
                if len(best[j]) < 2 and not any(s == src for _, s in best[j]):
                    heapq.heappush(heap, (d + length, j, src))
        for i, b in enumerate(best):
            if i in fixed:
                self.h[i] = fixed[i]
            elif len(b) == 2:
                (da, a), (db, c) = b
                self.h[i] = (fixed[a] * db + fixed[c] * da) / (da + db)
            elif b:
                self.h[i] = fixed[b[0][1]]


def solve(ways, ground, decks, soft=frozenset(), streets=()):
    """Heights along every structure way (metres above sea level), as a profile per
    way: (cumulative distance along it, heights) at its points. `ground(xs, ys)`: bare
    terrain; `decks`: IPR's bridges (ipr_decks); `soft`: the ids of the ways that are
    stairs (see stairs): between a deck and the ground it's they that take up the
    difference in height, not the deck's last metres; `streets`: the car streets on the
    ground, as lines (see ipr_ends)."""
    net = Net(ways, soft)
    streets = (STRtree(streets), streets) if len(streets) else None
    if not len(net.xy):
        return net, []
    T = ground(net.xy[:, 0], net.xy[:, 1])
    try:  # (on open water: every lattice point round it is the river's)
        wet = np.isnan(ground(net.xy[:, 0], net.xy[:, 1], dry=True)) & ~np.isnan(T)
    except TypeError:
        wet = np.zeros(len(T), dtype=bool)
    fixed = {}
    for w in ways:
        # Only its ends: a way on the ground meeting a bridge halfway along (stairs up
        # from the valley under Nuselský most, say) meets it at the deck's height.
        for k, (n, g) in enumerate(zip(w["nodes"], w["grade"])):
            if g and k in (0, len(w["nodes"]) - 1):
                i = net.key[("n", n)]
                ahead = np.subtract(w["pts"][0], w["pts"][1]) if k == 0 else np.subtract(w["pts"][-1], w["pts"][-2])
                if w["kind"] == "bridge":
                    # A bridge drawn from past the edge of its wall: the street's last metres,
                    # from the wall to where the bridge begins, are at the bridge's height
                    # (ipr_terrain.py lifts the ground there; see pads).
                    fixed[i], back = abutment(ground, net.xy[i], ahead, T[i])
                    if back:
                        w.setdefault("raised", {})[0 if k == 0 else -1] = (back + 0.5, fixed[i])
                else:
                    fixed[i] = portal(ground, *net.xy[i])
    # The map cuts a bridge's ways into scraps a few metres long at its ends (a turning
    # lane, the last of a pavement), and where a scrap meets the long way some path down
    # to the quay often joins too: that node counts as on the ground, 8 m below the
    # street the scrap's other end is on. A scrap running on from a much longer bridge way
    # is level, at the higher of its two ends, which lifts the long way's end with it.
    length = {w["id"]: LineString(w["pts"]).length for w in ways}
    at_node = defaultdict(list)
    for w in ways:
        if w["kind"] == "bridge":
            at_node[w["nodes"][0]].append(w)
            at_node[w["nodes"][-1]].append(w)
    level = set()  # the scraps settled so far: the next ones run on from them
    for _ in range(3):
        for w in ways:
            if w["kind"] != "bridge" or length[w["id"]] >= SCRAP:
                continue
            ends = [net.key[("n", w["nodes"][0])], net.key[("n", w["nodes"][-1])]]
            if not any(o is not w and (o["id"] in level or length[o["id"]] >= 4 * length[w["id"]])
                       for n in (w["nodes"][0], w["nodes"][-1]) for o in at_node[n]):
                continue
            known = [fixed[i] for i in ends if i in fixed]
            if known:
                for i in ends:
                    if i in fixed:
                        fixed[i] = max(known)
                level.add(w["id"])
    # No bridge that cars or people use drops a storey in a few metres. Where a short
    # bridge way's two ends on the ground are that far apart in height (a service way off
    # Hlávkův most whose far end the map ties to the landing by the water, 10 m down in
    # 40 m), the lower end isn't where the map says: the way is level.
    for w in ways:
        if w["kind"] != "bridge" or w["hw"] == "steps" or length[w["id"]] >= STEEP_LENGTH:
            continue
        ends = [net.key[("n", w["nodes"][0])], net.key[("n", w["nodes"][-1])]]
        # (A way for people on foot can be that steep: stairs the map calls a footway.)
        if all(i in fixed for i in ends) and w["hw"] in ON_FOOT and abs(fixed[ends[0]] - fixed[ends[1]]) <= STAIRS_MAX * max(length[w["id"]], 1):
            continue
        if all(i in fixed for i in ends) and abs(fixed[ends[0]] - fixed[ends[1]]) > STEEP * max(length[w["id"]], 1):
            # Where IPR measured the deck, it says which end is wrong: a ramp's end on the
            # slope under it (the slip road off Jižní spojka over Vrbova, 5 m under its
            # deck), or on the top of an abutment wall the terrain model kept (Strakonická
            # by Barrandovský most, 3 m over it). Each end on IPR's deck, and the street's
            # last metres brought to it.
            on_ipr = ipr_ends(w, decks, ground, [fixed[i] for i in ends], streets)
            if on_ipr:
                for end, i, (h, far) in zip((0, -1), ends, on_ipr):
                    fixed[i] = h
                    w.setdefault("raised", {}).pop(end, None)
                    if far:
                        w["raised"][end] = (far, h)
                continue
            fixed[ends[0]] = fixed[ends[1]] = max(fixed[ends[0]], fixed[ends[1]])
            w.pop("raised", None)
    # (What's kept for the street's last metres before each end, see pads, at the height it has now.)
    for w in ways:
        for end, (far, _) in list(w.get("raised", {}).items()):
            w["raised"][end] = (far, fixed[net.key[("n", w["nodes"][end])]])
    # A bridge or tunnel that meets the ground nowhere: its loose ends are on it.
    comp = components(net)
    anchored = {comp[i] for i in fixed}
    for i, nb in enumerate(net.adj):
        if comp[i] not in anchored and len(nb) <= 1:
            fixed[i] = T[i]
    base = dict(fixed)
    near = net.spread(fixed)
    room = np.minimum(WATER_CLEAR, net.rise(base))  # over open water: what a boat is left

    # Bridges: IPR's deck where it has one. (Over open water away from the banks, not a
    # face that leaves a boat no room: that's a pier's footing or its cap.)
    kind = np.array(net.kind)
    snapped = 0
    # (Not along stairs: IPR's flat faces there are the deck they leave or a landing,
    # and a flight pinned to one of them drags everything it joins.)
    on_stairs = {i for i, nb in enumerate(net.adj) if nb and all((i, j) in net.soft for j, _ in nb)}
    for i in np.nonzero(kind == "bridge")[0]:
        if i in fixed or np.isnan(net.h[i]) or i in on_stairs:
            continue
        z = deck_at(decks, *net.xy[i], net.h[i] + 2.0, below=6.0, above=4.0)
        if not np.isnan(z) and not (wet[i] and z < T[i] + room[i] - 0.5):
            fixed[i] = z
            snapped += 1
    if snapped:
        near = net.spread(fixed)

    # Bridges over open water clear it, as tunnels go under their cover: IPR has no deck
    # for a bridge built since its model, or for a footbridge slung under a road bridge,
    # and one that runs evenly between two low banks skims the river (Dvorecký most 3 m
    # over the Vltava, the footway under Barrandovský most: no boat got under them).
    # Not where IPR measured the deck, and not near the banks: a short bridge stays low.
    over_water = wet & (kind == "bridge")
    lifted = set()
    for _ in range(3 if over_water.any() else 0):
        low = over_water & (net.h < T + room - 0.05) & (near > 0)
        low[[i for i in fixed if i not in lifted]] = False
        if not low.any():
            break
        for i in np.nonzero(low)[0]:
            fixed[int(i)] = T[i] + room[i]
            lifted.add(int(i))
        net.spread(fixed)

    # Tunnels: under the ground, deeper away from their portals.
    tunnel = kind == "tunnel"
    for _ in range(3):
        cover = np.minimum(COVER, near * COVER_SLOPE)
        over = tunnel & (net.h > T - cover + 0.05) & (near > 0)
        if not over.any():
            break
        for i in np.nonzero(over)[0]:
            fixed[int(i)] = T[i] - cover[i]
        net.spread(fixed)

    # Crossings between layers: the upper one a storey above the lower.
    profiles = paths_profiles(net)
    crossed = set()
    for _ in range(2):
        moved = clear_crossings(ways, net, profiles, fixed, base)
        crossed |= moved
        if not moved:
            break
        net.spread(fixed)
        profiles = paths_profiles(net)
    # Smooth out the kinks where one rule hands over to another (a tunnel levelling
    # out under its cover, a bridge joining IPR's deck), over a few tens of metres;
    # the ends on the ground and the crossings stay where they are.
    keep = set(base) | crossed | lifted
    for _ in range(25):
        h = net.h.copy()
        for i, nb in enumerate(net.adj):
            if i in keep or not nb:
                continue
            # (Across a link along stairs only a little: the kink at their top is real.)
            wt = [SOFT if (i, j) in net.soft else 1.0 for j, _ in nb]
            h[i] = 0.5 * net.h[i] + 0.5 * np.average([net.h[j] for j, _ in nb], weights=wt)
        net.h = h
    profiles = paths_profiles(net)
    print(f"  {len(ways)} bridge and tunnel ways: {len(base)} ends on the ground, {snapped} points on IPR's decks")
    return net, profiles


# ---- Short underpasses in an open cutting ----------------------------------------------

CUT_LONGEST = 80.0  # m: a tunnel longer than this is a tunnel, whatever the terrain over it
CUT_DIP = 2.0  # m the terrain model dips under a street crossing a tunnel: an open cutting there
CUT_LOOK = 30.0  # m either side of the crossing that the street's own height is judged from
CUT_GRADE = 0.06  # the steepest the street over it can run from one side to the other


def cuttings(ways, streets, ground, deck_survey=None):
    """A short underpass whose street the terrain model shows in an open cutting: the
    model leaves the deck over it out, as it does a bridge's, and runs down the street
    inside (Kongresová under 5. května at Pankrác: a trench 20 m wide and 6 m deep under
    a tunnel 45 m long). As a tunnel it stood its walls up out of the cutting, and the
    street on top lay down in it. So it's turned round, as the terrain model has it: the
    underpass is on the ground, in its cutting, and each street over it is on a short
    bridge from where the ground is at its height on one side to the other.

    `ways`: structure_ways; `streets`: the car streets on the ground, {id: edge} (with
    pts, width, hw); `ground(xs, ys)`: the bare terrain. Returns the ids of the tunnel
    ways that are on the ground after all, and the bridge ways (marked `cut`). An
    optional `deck_survey` can add a missing carriageway on an already-found deck."""
    tunnels = [w for w in ways if w["kind"] == "tunnel" and len(w["pts"]) > 1 and w["hw"] not in ON_FOOT | STATION_FOOT | {"cycleway", "bridleway"}]
    edges = [e for e in streets.values() if len(e["pts"]) > 1 and not e.get("tunnel")]
    if not tunnels or not edges:
        return set(), []
    lines = [LineString(e["pts"]) for e in edges]
    tree = STRtree(lines)
    dropped, out = set(), []
    serial = iter(range(-1, -10**9, -1))  # (ids of their own for the new ways and their points: OSM's are positive)
    survey_serial = iter(range(-10**9, -2 * 10**9, -1))  # companions never renumber an existing cutting

    def cut_way(edge, span, survey_sources=None):
        pts = [[round(v, 2) for v in p] for p in shapely.get_coordinates(span)]
        ends = [i in (0, len(pts) - 1) for i in range(len(pts))]
        ids = survey_serial if survey_sources else serial
        return {
            "id": next(ids), "kind": "bridge", "layer": 1, "mapped_layer": None, "cut": True,
            "hw": edge.get("hw", "primary"), "w": round(float(edge["width"]), 1), "pts": pts,
            "nodes": [next(ids) for _ in pts], "grade": ends, "on_ground": ends.copy(),
            **({"survey_sources": survey_sources} if survey_sources else {}),
        }

    for w in tunnels:
        line = LineString(w["pts"])
        if line.length > CUT_LONGEST:
            continue
        near = [lines[k] for k in tree.query(line.buffer(CUT_LOOK + w["w"]))]
        merged = shapely.ops.linemerge(near)
        chains = list(getattr(merged, "geoms", [merged])) if not merged.is_empty else []
        found, candidates = [], []
        for k in tree.query(line, predicate="intersects"):
            edge, crossing = edges[k], lines[k]
            at = crossing.intersection(line)
            at = at if at.geom_type == "Point" else at.centroid
            if deck_survey is not None:
                # A companion may fork at an abutment. Extend along the whole street
                # where it is one unbranched chain, otherwise use that edge alone.
                linked = next((c for c in chains if c.covers(crossing)), crossing)
                candidates.append((edge, crossing, linked))
            if min(line.project(at), line.length - line.project(at)) < w["w"] / 2:
                continue  # meeting it at a portal, not crossing over it
            # The street with the ways it runs on into, so its sides reach past the cutting.
            chain = next((c for c in chains if c.distance(at) < 0.01 and c.length >= crossing.length - 0.01), crossing)
            sc = chain.project(at)
            if sc < CUT_LOOK or chain.length - sc < CUT_LOOK:
                continue
            ds = np.arange(0.0, CUT_LOOK + 0.5, 1.0)
            sides = []
            for sign in (-1, 1):
                pts = [chain.interpolate(sc + sign * d).coords[0] for d in ds]
                h = ground(np.array([p[0] for p in pts]), np.array([p[1] for p in pts]))
                if np.isnan(h).any():
                    break
                level = float(np.median(h[ds >= CUT_LOOK - 10]))
                reached = np.nonzero(h >= level - 0.5)[0]
                sides.append((level, float(ds[reached[0]]) + 2.0, float(h.min())))
            if len(sides) < 2:
                continue
            (h0, d0, low0), (h1, d1, low1) = sides
            span = d0 + d1
            if min(h0, h1) - min(low0, low1) < CUT_DIP or abs(h1 - h0) > CUT_GRADE * span:
                continue
            a, b = sc - d0, sc + d1
            span_line = shapely.ops.substring(chain, a, b)
            if any(LineString(f["pts"]).hausdorff_distance(span_line) < 2.0 for f in found):
                continue  # (the other way of a two-way street: one edge each way along the same line)
            print(f"    cutting: {w['hw']} way {w['id']} under {edge.get('name') or edge.get('hw')} at "
                  f"({at.x:.0f}, {at.y:.0f}): {min(h0, h1) - min(low0, low1):.1f} m down, {span:.0f} m across, sides {h0:.1f}/{h1:.1f}")
            found.append(cut_way(edge, span_line))
        if found and deck_survey is not None:
            known = [LineString(f["pts"]) for f in found]
            for edge, span, sources in deck_survey.companions(line, known, candidates, ground, CUT_DIP, CUT_GRADE):
                if any(LineString(f["pts"]).hausdorff_distance(span) < 2.0 for f in found):
                    continue  # two directions of the same edge
                found.append(cut_way(edge, span, sources))
                print(f"    survey companion: {edge['id']} on bridge {sources['bridge']['ID']}, "
                      f"carriageway {sources['road']['ID']}, {span.length:.1f} m")
        if found:
            dropped.add(w["id"])
            out += found
    return dropped, out


def companion_profile(way, ground):
    """The measured span reaches both approaches, which supply its end heights."""
    pts = np.asarray(way["pts"], dtype=float)
    s = np.r_[0.0, np.cumsum(np.hypot(*np.diff(pts, axis=0).T))]
    return s, np.interp(s, s[[0, -1]], ground(*pts[[0, -1]].T))


def drop_shallow(ways, net, profiles, ground):
    """Without the tunnels that never go under the ground: a short way tagged as a tunnel
    (an underpass, say) has both ends on the ground, so it dips only a metre or so. As a
    level it would sit at the street's own height and swallow whoever walked past it.
    A tunnel is judged with the ways joined to it, so a real tunnel's ends stay."""
    depth = ground(net.xy[:, 0], net.xy[:, 1]) - net.h
    comp = components(net)
    deepest = defaultdict(float)
    for i, c in enumerate(comp):
        if net.kind[i] == "tunnel" and not np.isnan(depth[i]):
            deepest[c] = max(deepest[c], float(depth[i]))
    keep = [w["kind"] != "tunnel" or deepest[comp[net.key[("n", w["nodes"][0])]]] >= SHALLOW for w in ways]
    if not all(keep):
        print(f"  {len(keep) - sum(keep)} tunnel ways never go {SHALLOW} m under the ground: left on it")
    return [w for w, k in zip(ways, keep) if k], [p for p, k in zip(profiles, keep) if k]


def portal(ground, x, y):
    """The height of a tunnel's portal: the lowest ground round it, which is the road
    cut into the slope (the terrain model rises up the face above the portal)."""
    a = np.linspace(0, 2 * np.pi, 12, endpoint=False)
    xs = np.concatenate([[x], x + 5 * np.cos(a), x + 10 * np.cos(a)])
    ys = np.concatenate([[y], y + 5 * np.sin(a), y + 10 * np.sin(a)])
    try:
        return float(np.nanmin(ground(xs, ys, dry=True)))  # (not the water's level, where there's a river beside it)
    except TypeError:
        return float(np.nanmin(ground(xs, ys)))


STEP = 1.0  # m: a rise of this much within 2 m, somewhere in ABUTMENT on from a bridge's end, is the wall of the street it comes off
ABUTMENT = 8.0


def abutment(ground, at, ahead, here):
    """The height of a bridge's end and how far on the street it comes off begins: the
    ground there and 0, unless the map draws the bridge from a little past the edge of
    the wall it leaves (a quay, a retaining wall, which are steps in the ground since
    dtm_heights.py): then the street's height, on along the way (`ahead`) within
    ABUTMENT, and the distance to the wall's edge."""
    d = np.asarray(ahead, float) / (np.hypot(*ahead) or 1)
    far = np.linspace(0, ABUTMENT, 9)
    on = np.asarray(at)[None, :] + d[None, :] * far[:, None]
    hs = ground(on[:, 0], on[:, 1])
    hs[0] = here
    if np.isnan(hs).any():
        return here, 0.0
    # A step, not a slope: the rise comes within 2 m (the lattice is 4 m: a step in it is
    # a ramp across one cell at most).
    rise = hs[2:] - hs[:-2]
    if rise.max() <= STEP:
        return here, 0.0
    # (The terrain's ramp may run on past the step: the street's height is the highest
    # out to half as far again.)
    more = np.asarray(at)[None, :] + d[None, :] * np.linspace(ABUTMENT, 1.5 * ABUTMENT, 5)[:, None]
    return float(np.nanmax(np.r_[hs, ground(more[:, 0], more[:, 1])])), float(far[int(np.argmax(rise)) + 2])


def ipr_ends(w, decks, ground, at_ends, streets=None):
    """A short bridge way's two ends on IPR's deck, [(height, how far on the street
    the ground comes to it)] for its first and last end, or None: where IPR has no deck
    along most of it, none within IPR_END of an end, one as steep as the map's ends, one
    the street reaches within IPR_END of neither end (it's to say which end is wrong, not
    overrule both), no ground within PAD_MAX on along the street within MEET of it, or
    a car street on the ground (`streets`: (STRtree, lines)) across the ground that
    would come up. That's a bridge the map draws too short, its ends on the street it
    crosses (Jižní spojka over Ryšavého): raising the ground walls that street off."""
    line = LineString(w["pts"])
    lo, hi = min(at_ends), max(at_ends)
    s = np.arange(0, line.length + 0.01, 1.0)
    z = np.array([deck_at(decks, p.x, p.y, hi, below=hi - lo + 3.0) for p in (line.interpolate(d) for d in s)])
    if np.isnan(z).mean() > 0.4:
        return None
    out, agree = [], False
    for end, (a, b) in ((0, (w["pts"][1], w["pts"][0])), (-1, (w["pts"][-2], w["pts"][-1]))):
        near = (z if end == 0 else z[::-1])[s <= IPR_END]
        near = near[~np.isnan(near)]
        if not len(near):
            return None
        h = float(near[0])
        d = np.subtract(b, a) / (math.dist(a, b) or 1)
        far = np.arange(0, PAD_MAX + 0.01, 1.0)
        on = np.asarray(b)[None, :] + d[None, :] * far[:, None]
        # (Where the street first comes within half of MEET of the deck, or nearest it: the
        # end at the street's height there, so the ground brought to it meets the street.)
        g = ground(on[:, 0], on[:, 1])
        off = np.where(np.isnan(g), np.inf, np.abs(g - h))
        close = np.nonzero(off <= MEET / 2)[0]
        k = int(close[0]) if len(close) else int(np.argmin(off))
        agree = agree or far[k] <= IPR_END
        if off[k] > MEET or (k and streets and crossed(LineString([b, on[k]]).buffer(w["w"] / 2 + 1.0, cap_style="flat"), d, streets)):
            return None
        out.append((float(g[k]), float(far[k]) + 0.5 if k else 0.0))
    if not agree or abs(out[0][0] - out[1][0]) > STEEP * max(line.length, 1):
        return None
    return out


def crossed(pad, d, streets):
    """Whether a street in `streets` ((STRtree, lines)) crosses `pad`, more than 30°
    off its direction `d` (not the street it lies on, running on from the bridge)."""
    tree, lines = streets
    for k in tree.query(pad, predicate="intersects"):
        for part in shapely.get_parts(lines[k].intersection(pad)):
            if part.geom_type == "LineString" and part.length >= 1:
                (x0, y0), (x1, y1) = part.coords[0], part.coords[-1]
                if abs((x1 - x0) * d[0] + (y1 - y0) * d[1]) < math.cos(math.pi / 6) * math.hypot(x1 - x0, y1 - y0):
                    return True
    return False


def components(net):
    comp = [-1] * len(net.adj)
    for s in range(len(net.adj)):
        if comp[s] >= 0:
            continue
        stack = [s]
        comp[s] = s
        while stack:
            i = stack.pop()
            for j, _ in net.adj[i]:
                if comp[j] < 0:
                    comp[j] = s
                    stack.append(j)
    return comp


def paths_profiles(net):
    out = []
    for path in net.paths:
        xy = net.xy[path]
        s = np.concatenate([[0], np.cumsum(np.hypot(*np.diff(xy, axis=0).T))])
        out.append((s, net.h[path].copy()))
    return out


def clear_crossings(ways, net, profiles, fixed, base):
    """Where two ways on different OSM layers cross closer than CLEAR in height, fix
    the one that should give way (the upper bridge up, the lower tunnel down) at the
    crossing. Returns the points it moved."""
    lines = [LineString(w["pts"]) for w in ways]
    tree = STRtree(lines)
    moved = set()
    for a, b in zip(*tree.query(lines, predicate="crosses")):
        if a >= b or ways[a]["layer"] == ways[b]["layer"] or set(ways[a]["nodes"]) & set(ways[b]["nodes"]):
            continue
        hit = lines[a].intersection(lines[b])
        for p in getattr(hit, "geoms", [hit]):
            if p.geom_type != "Point":
                continue
            ha = np.interp(lines[a].project(p), *profiles[a])
            hb = np.interp(lines[b].project(p), *profiles[b])
            up, lo = (a, b) if ways[a]["layer"] > ways[b]["layer"] else (b, a)
            hu, hl = (ha, hb) if up == a else (hb, ha)
            if hu - hl >= CLEAR:
                continue
            # A tunnel goes down under whatever crosses it (a bridge over an underpass is
            # the street at the ground's level: lifting it puts a hump in the junction);
            # between two bridges the upper one goes up.
            who, h = (lo, hu - CLEAR) if ways[lo]["kind"] == "tunnel" else (up, hl + CLEAR)
            path = net.paths[who]
            i = path[int(np.argmin(np.hypot(*(net.xy[path] - [p.x, p.y]).T)))]
            if i not in base:
                fixed[i] = h
                moved.add(i)
    return moved


def height_along(line, profile, xs, ys):
    """Heights of points taken straight across to a way (its profile at the nearest
    point on it)."""
    s = shapely.line_locate_point(line, shapely.points(xs, ys))
    return np.interp(s, *profile)


# ---- Pieces and levels ----------------------------------------------------------------

class Piece:
    """One bridge or tunnel as the game gets it: its outline and a height anywhere
    in or near it."""

    def __init__(self, kind, shape, height, members=(), mapped_layer=None, nodes=()):
        self.kind, self.shape, self.height = kind, shape, height
        self.members = list(members)
        self.level = 0
        self.mapped_layer = mapped_layer
        self.nodes = frozenset(nodes)
        # A way too steep for the lattice (stairs): its own profile, {w, pts: [[x, y, h]]}
        # (see ramps), kept out of the level's lattice.
        self.ramp = None


def pieces(ways, profiles, outlines, ground, decks, road_tree):
    """The pieces: every way on its own (its width wide), and every man_made=bridge
    outline (`outlines`), at the height of the ways on it or, with none, from its ends.
    Returns pieces and groups (lists of pieces that must share a level: an outline and
    the ways on it)."""
    out = []
    lines = [LineString(w["pts"]) for w in ways]
    for w, line, prof in zip(ways, lines, profiles):
        drawn = reach(w, lambda end: PORTAL if w["grade"][end] else 0) if w["kind"] == "tunnel" else line
        # A tunnel has a walkway either side of the road; a bridge's pavements are
        # mostly mapped (or its man_made=bridge outline has them).
        shape = drawn.buffer(w["w"] / 2 + (1.5 if w["kind"] == "tunnel" else 0), cap_style="flat", join_style="round")
        out.append(Piece(w["kind"], shape, (lambda xs, ys, line=line, prof=prof: height_along(line, prof, xs, ys)),
                         [w["id"]], w.get("mapped_layer"), w["nodes"]))
    groups = [[p] for p in out]
    # A surveyed companion already has its own span and profile. It cannot supply
    # the height of a separate mapped outline or borrow another way's profile.
    bridges = [k for k, w in enumerate(ways) if w["kind"] == "bridge" and not w.get("survey_sources")]
    tree = STRtree([out[k].shape for k in bridges]) if bridges else None
    group_of = {id(p): g for g in groups for p in g}

    def join(g, old):
        if old is not g:
            g.extend(old)
            for p in old:
                group_of[id(p)] = g
            old.clear()

    # The map cuts a bridge's ways into scraps a few metres long at its ends (a turning
    # lane, the last of a pavement), each tied to the ground under its own ends, which may
    # be the quay below. A scrap lying on a much longer way of the same layer is part of
    # that bridge: its height, and its level.
    for k in sorted(bridges, key=lambda k: -lines[k].length):
        if lines[k].length >= SCRAP:
            continue
        m = lines[k].interpolate(0.5, normalized=True)
        hosts = [j for j in (bridges[i] for i in tree.query(m, predicate="intersects"))
                 if j != k and lines[j].length >= 4 * lines[k].length and ways[j]["layer"] == ways[k]["layer"]]
        if hosts:
            j = max(hosts, key=lambda j: lines[j].length)
            out[k].height = out[j].height
            join(group_of[id(out[j])], group_of[id(out[k])])
            ways[k]["scrap"] = True
    ramps(ways, lines, profiles, out)

    for poly in outlines:
        if poly.area < 30:
            continue
        on = []
        if tree is not None:
            hits = [bridges[k] for k in tree.query(poly, predicate="intersects")]
            # The ways on this bridge: those at the height of the one that covers most of
            # it (not a flyover crossing it higher up, or a street passing under). Most of
            # it by area, not length: on Barrandovský most a cycleway runs the whole
            # outline and down a ramp off it, longer than any of the carriageways.
            share = {k: lines[k].intersection(poly).length for k in hits}
            if share and max(share.values()) > 5:
                ref = max(share, key=lambda k: share[k] * ways[k]["w"])
                c = lines[ref].intersection(poly).interpolate(0.5, normalized=True)
                href = out[ref].height(np.array([c.x]), np.array([c.y]))[0]
                for k in hits:
                    inside = lines[k].intersection(poly)
                    if inside.length < 1:
                        continue
                    m = inside.interpolate(0.5, normalized=True)
                    distinct = (ways[k].get("mapped_layer") is not None and ways[ref].get("mapped_layer") is not None
                                and ways[k]["mapped_layer"] != ways[ref]["mapped_layer"]
                                and not set(ways[k]["nodes"]) & set(ways[ref]["nodes"]))
                    if distinct or abs(out[k].height(np.array([m.x]), np.array([m.y]))[0] - href) >= SAME:
                        continue
                    # (Stairs are on the bridge only if they stay at its height from end to end.)
                    if out[k].ramp:
                        q = [inside.interpolate(f, normalized=True) for f in (0.05, 0.95)]
                        if np.abs(out[k].height(np.array([p.x for p in q]), np.array([p.y for p in q])) - href).max() >= STAIRS_SAME:
                            continue
                    on.append(k)
        if on:
            # (Its height from the ways that are its deck, not from stairs down off it.)
            deck = [k for k in on if not out[k].ramp] or on
            ls = [lines[k] for k in deck]
            hs = [out[k].height for k in deck]

            def height(xs, ys, ls=ls, hs=hs):
                pts = shapely.points(xs, ys)
                d = np.array([shapely.distance(line, pts) for line in ls])
                h = np.array([f(xs, ys) for f in hs])
                return h[np.argmin(d, axis=0), np.arange(len(xs))]
            declared = {ways[k]["mapped_layer"] for k in on if ways[k].get("mapped_layer") is not None}
            piece = Piece("bridge", poly, height, mapped_layer=next(iter(declared)) if len(declared) == 1 else None)
            out.append(piece)
            # One group: the outline and every way on it.
            g = [piece]
            for k in on:
                join(g, group_of[id(out[k])])
            groups.append(g)
            for p in g:
                group_of[id(p)] = g
        else:
            piece = Piece("bridge", poly, own_profile(poly, ground, decks, road_tree))
            out.append(piece)
            groups.append([piece])
            group_of[id(piece)] = groups[-1]
    return out, [g for g in groups if g]


RAMP = 0.2  # a bridge way this steep from end to end is stairs, whatever the map calls it
FLIGHT = 1.5  # m: and climbs at least this much
LANDING = 8.0  # m: a bridge way shorter than this that runs on from stairs is their landing


def stairs(ways, profiles):
    """Which bridge ways are stairs (their indices): those the map tags so, those as steep
    from end to end whatever it calls them, and the landings between flights (a short way
    running on from stairs)."""
    at_node = defaultdict(list)
    for k, w in enumerate(ways):
        if w["kind"] == "bridge":
            at_node[w["nodes"][0]].append(k)
            at_node[w["nodes"][-1]].append(k)
    steep = []
    for k, (w, (s, h)) in enumerate(zip(ways, profiles)):
        if w["kind"] != "bridge" or len(s) < 2 or np.isnan(h).any():
            continue
        # (A real flight: a scrap a metre long at a bridge's end, half a metre off the
        # ground it's tied to, is steep too, and is nothing.)
        if w["hw"] == "steps" or (abs(h[-1] - h[0]) > RAMP * max(s[-1], 1.0) and abs(h[-1] - h[0]) >= FLIGHT):
            steep.append(k)
    is_steep = set(steep)
    for k, (w, (s, h)) in enumerate(zip(ways, profiles)):
        if (w["kind"] == "bridge" and k not in is_steep and len(s) >= 2 and s[-1] < LANDING and not np.isnan(h).any()
                and any(j in is_steep for end in (0, -1) for j in at_node[w["nodes"][end]])):
            steep.append(k)
    return steep


def ramps(ways, lines, profiles, out):
    """Stairs on a bridge (and ways as steep, and their landings) get their own profile (Piece.ramp)
    and stay out of their level's lattice. The lattice has a point every 4 m and one
    height per point: stairs folded back beside the deck they come down from put their
    heights into the deck's last points (Železniční most at Výtoň: 1.8 m down), and on a
    level of their own two flights 4 m apart mix with each other. Where the stairs' first
    metres lie on the deck they leave (the map draws them from the middle of the
    footway), they are at the deck's height: the descent begins at its edge."""
    at_node = defaultdict(list)
    for k, w in enumerate(ways):
        if w["kind"] == "bridge":
            at_node[w["nodes"][0]].append(k)
            at_node[w["nodes"][-1]].append(k)
    steep = [k for k in stairs(ways, profiles) if not ways[k].get("scrap")]  # (a scrap is part of its deck)
    is_steep = set(steep)
    for k in steep:
        w, line, (s, h) = ways[k], lines[k], profiles[k]
        s, h = np.array(s, float), np.array(h, float)
        for end in (0, -1):
            hosts = [j for j in at_node[w["nodes"][end]] if j != k and j not in is_steep]
            if not hosts:
                continue
            # How far the way runs on the deck it leaves, from this end.
            far, host = -1.0, None
            for j in hosts:
                d = 0.0
                while d + 0.25 <= min(line.length, 12.0):
                    q = line.interpolate(d + 0.25 if end == 0 else line.length - d - 0.25)
                    if not out[j].shape.contains(q):
                        break
                    d += 0.25
                if d > far:
                    far, host = d, j
            if host is None or far >= line.length - 0.5:
                continue
            far = max(far, 0.0)  # (leaving the deck at once: still from its height)
            at = far if end == 0 else line.length - far
            q = line.interpolate(at)
            top = float(out[host].height(np.array([q.x]), np.array([q.y]))[0])
            if np.isnan(top):
                continue
            on = s <= at if end == 0 else s >= at
            pts = [line.interpolate(v) for v in s[on]]
            h[on] = out[host].height(np.array([p.x for p in pts]), np.array([p.y for p in pts]))
            if not np.any(np.abs(s - at) < 0.05):
                i = int(np.searchsorted(s, at))
                s, h = np.insert(s, i, at), np.insert(h, i, top)
        xy = [line.interpolate(v) for v in s]
        out[k].ramp = {"w": w["w"], "pts": [[round(p.x, 2), round(p.y, 2), round(float(z), 2)] for p, z in zip(xy, h)]}
        out[k].height = (lambda xs, ys, line=line, prof=(s, h): height_along(line, prof, xs, ys))


STEEP, STEEP_LENGTH = 0.15, 80.0  # a bridge way shorter than this many metres, steeper than this: not a ramp, a mistake in the map
IPR_END, PAD_MAX, MEET = 4.0, 20.0, 1.0  # m (ipr_ends): IPR's deck this near a short bridge's end is the end's; the ground this far on, within this of it, meets it
SCRAP = 25.0  # m: a bridge way shorter than this, lying on a much longer one, is a scrap of that bridge
PORTAL = 12.0  # m a tunnel reaches out of its portal, at the portal's height


def pads(ways):
    """Where the ground has to come up to a bridge's end: [(polygon, height)], the
    street's last metres between the edge of the wall the bridge comes off and where the
    map has the bridge begin (see abutment). They'd hang down to the quay below."""
    out = []
    for w in ways:
        if w.get("scrap") or w.get("cut"):  # (its ends' heights aren't the bridge's: see pieces; a cut's are the street's)
            continue
        for end, (far, height) in w.get("raised", {}).items():
            a, b = (w["pts"][1], w["pts"][0]) if end == 0 else (w["pts"][-2], w["pts"][-1])
            d = math.dist(a, b) or 1
            on = (b[0] + (b[0] - a[0]) / d * far, b[1] + (b[1] - a[1]) / d * far)
            out.append((LineString([b, on]).buffer(w["w"] / 2 + 1.0, cap_style="flat"), height))
    return out


def reach(w, by):
    """A way reaching `by(end)` metres out of each end (0 its first, -1 its last), along
    the road into it, at the end's height: a tunnel out of each portal (an end on the
    ground). The terrain model rises up the face above a portal a few metres before OSM's
    tunnel starts, so the way in starts a little before it."""
    pts = [tuple(p) for p in w["pts"]]
    for end, (a, b) in ((0, (pts[1], pts[0])), (-1, (pts[-2], pts[-1]))):
        far = by(end)
        if not far:
            continue
        d = math.dist(a, b) or 1
        out = (b[0] + (b[0] - a[0]) / d * far, b[1] + (b[1] - a[1]) / d * far)
        if end == 0:
            pts.insert(0, out)
        else:
            pts.append(out)
    return LineString(pts)


def own_profile(poly, ground, decks, road_tree):
    """A bridge outline with no street on it (a railway bridge, say): level between
    the heights of its two ends (where it meets streets and paths), along its long
    axis, and on IPR's deck where IPR has one."""
    rect = list(poly.minimum_rotated_rectangle.exterior.coords)
    e1, e2 = np.subtract(rect[1], rect[0]), np.subtract(rect[2], rect[1])
    axis = e1 if np.hypot(*e1) >= np.hypot(*e2) else e2
    axis = axis / (np.hypot(*axis) or 1)
    c = np.array(poly.centroid.coords[0])
    ring = poly.exterior.buffer(3).exterior
    pts = np.array([ring.interpolate(d).coords[0] for d in np.arange(0, ring.length, 2.0)])
    hs = ground(pts[:, 0], pts[:, 1])
    on_road = np.zeros(len(pts), bool)
    if road_tree is not None:
        on_road = np.array([len(road_tree.query(shapely.points(x, y).buffer(2), predicate="intersects")) > 0 for x, y in pts])
    along = (pts - c) @ axis
    span = along.max() - along.min()
    outer = (along < along.min() + 0.2 * span) | (along > along.max() - 0.2 * span)
    ok = on_road & outer & ~np.isnan(hs)
    ends_t, ends_h = np.array([0.0]), np.array([np.nanpercentile(hs, 90)])
    if ok.sum() >= 2:
        t, h = (pts[ok] - c) @ axis, hs[ok]
        lo, hi = t < np.median(t), t >= np.median(t)
        if lo.any() and hi.any() and t[hi].mean() - t[lo].mean() > 5:
            ends_t = np.array([np.median(t[lo]), np.median(t[hi])])
            ends_h = np.array([np.median(h[lo]), np.median(h[hi])])
        else:
            ends_h = np.array([np.median(h)])

    # Where IPR has the bridge itself (a face over most of the outline), its height is
    # IPR's top, whatever the ends say: a railway bridge's ends are embankments, not
    # streets, and the streets found near them are the ones passing under it (the bridge
    # at Holešovice came out 9 m low, on the water).
    x0, y0, x1, y1 = poly.bounds
    gx, gy = np.meshgrid(np.arange(math.ceil(x0), x1, 2.0), np.arange(math.ceil(y0), y1, 2.0))
    inside = shapely.contains_xy(poly, gx, gy)
    tops = [decks.get((int(round(x)), int(round(y)))) for x, y in zip(gx[inside], gy[inside])]
    have = [float(t.max()) for t in tops if t is not None]
    if len(have) >= 10 and len(have) > 0.5 * len(tops):
        ends_t, ends_h = np.array([0.0]), np.array([float(np.median(have))])

    def height(xs, ys):
        if len(ends_t) == 1:
            h = np.full(len(xs), ends_h[0])
        else:
            tt = (xs - c[0]) * axis[0] + (ys - c[1]) * axis[1]
            f = np.clip((tt - ends_t[0]) / (ends_t[1] - ends_t[0]), 0, 1)
            h = ends_h[0] + (ends_h[1] - ends_h[0]) * f
        ipr = np.array([deck_at(decks, x, y, g) for x, y, g in zip(xs, ys, h)])
        return np.where(np.isnan(ipr), h, ipr)
    return height


def assign_levels(groups, companions=frozenset()):
    """Levels for the groups: bridges 1, 2, … from the lowest up and tunnels -1, -2, …
    from the highest down, so that no two groups overlapping at heights more than
    SAME apart share one. Survey companions take an available level after the
    existing groups have their levels, without renumbering structures elsewhere."""
    info, regular, deferred = [], [], []
    for k, g in enumerate(groups):
        shape = unary_union([p.shape for p in g])
        c = shape.representative_point()
        h = float(np.nanmean(g[0].height(np.array([c.x]), np.array([c.y]))))
        declared = {p.mapped_layer for p in g if p.mapped_layer is not None}
        nodes = frozenset(n for p in g for n in p.nodes)
        info.append((g, shape, h, g[0].kind, declared, nodes, any(p.ramp for p in g)))
        members = {i for p in g for i in p.members} if companions else set()
        (deferred if members and members <= companions else regular).append(k)
    tree = STRtree([q[1] for q in info])
    def priority(k):
        return info[k][2] if info[k][3] == "bridge" else -info[k][2]

    order = sorted(regular, key=priority) + sorted(deferred, key=priority)
    level = {}
    for k in order:
        g, shape, _, kind, declared, nodes, stairs = info[k]
        taken = set()
        companion = k in deferred
        minimum, maximum = 1, math.inf
        for o in tree.query(shape, predicate="dwithin", distance=BESIDE):
            if o == k or o not in level or info[o][3] != kind:
                continue
            # Explicitly separate decks can be fully nested, with no nearby
            # exterior edge to sample. Their mapped layers remain distinct.
            mapped_apart = bool(declared and info[o][4] and declared.isdisjoint(info[o][4]) and nodes.isdisjoint(info[o][5]))
            if mapped_apart:
                taken.add(level[o])
                if not companion:
                    continue
            # Over each other or side by side: a level's heights are on the terrain's lattice
            # and reach PAD past each piece, so steps going down beside a bridge's deck, or
            # a jetty at the water's level, would pull the deck's edge down with them. Where
            # the two are close, are they anywhere more than SAME apart?
            near = shape.exterior if shape.geom_type == "Polygon" else shape.boundary
            near = near.intersection(info[o][1].buffer(BESIDE))
            overlap = shape.intersection(info[o][1]) if companion else None
            common = overlap is not None and overlap.area > 0
            if common:
                # One deck may sit inside the other. Drop point or line contacts
                # alongside the common area before sampling its whole perimeter.
                near = overlap.buffer(0).boundary
            if not common and (near.is_empty or near.length < 0.5):
                continue
            lines = shapely.get_parts(near) if common else (near,)
            ps = [line.interpolate(d) for line in lines for d in np.arange(0, line.length, 3.0)]
            if common:
                ps.append(overlap.representative_point())
            xs, ys = np.array([q.x for q in ps]), np.array([q.y for q in ps])
            with np.errstate(invalid="ignore"):
                difference = piece_height(g, xs, ys) - piece_height(info[o][0], xs, ys)
            if common and not np.isfinite(difference).all():
                raise ValueError("survey companion overlaps a bridge whose height is unknown")
            # (Stairs lie over or under the deck they leave in plan, a metre or two off its
            # height: they share its level only where they're at its height.)
            same = STAIRS_SAME if stairs or info[o][6] else SAME
            if np.nanmax(np.abs(difference), initial=0) > same:
                taken.add(level[o])
                if companion:
                    if np.nanmax(difference, initial=0) > same:
                        minimum = max(minimum, level[o] + 1)
                    if np.nanmin(difference, initial=0) < -same:
                        maximum = min(maximum, level[o] - 1)
        step = 1 if kind == "bridge" else -1
        lv = minimum if companion else step
        while lv in taken:
            lv += step
        if companion and lv > maximum:
            at = shape.representative_point()
            raise ValueError(f"survey companion near ({at.x:.0f}, {at.y:.0f}) cannot fit between the existing bridge levels")
        level[k] = lv
        for p in g:
            p.level = lv
    return max((abs(v) for v in level.values()), default=0)


def piece_height(group, xs, ys):
    """A group's height at points: that of the piece nearest to each."""
    pts = shapely.points(xs, ys)
    d = np.array([shapely.distance(p.shape, pts) for p in group])
    h = np.array([p.height(xs, ys) for p in group])
    return h[np.argmin(d, axis=0), np.arange(len(xs))]


def rasterise(all_pieces, tiles, N, T, step, gx0, gy0):
    """Per tile: {level: heights on the terrain's lattice (NaN away from that level's
    pieces)}, each point from the nearest piece of the level."""
    out = {}
    near = {}
    for p in all_pieces:
        minx, miny, maxx, maxy = p.shape.bounds
        grown = p.shape.buffer(PAD)
        for i in range(math.floor((minx - PAD - gx0) / T), math.floor((maxx + PAD - gx0) / T) + 1):
            for j in range(math.floor((miny - PAD - gy0) / T), math.floor((maxy + PAD - gy0) / T) + 1):
                if (i, j) not in tiles:
                    continue
                tx0, ty0 = gx0 + i * T, gy0 + j * T
                xs, ys = np.meshgrid(tx0 + np.arange(N + 1) * step, ty0 + np.arange(N + 1) * step)
                inside = shapely.contains_xy(grown, xs, ys)
                if not inside.any():
                    continue
                arr = out.setdefault((i, j), {}).setdefault(p.level, np.full((N + 1, N + 1), np.nan, dtype=np.float32))
                if p.ramp:  # (its heights are its own profile: the level is here, the lattice has nothing of it)
                    continue
                dist = near.setdefault((i, j, p.level), np.full((N + 1, N + 1), np.inf, dtype=np.float32))
                d = np.full(xs.shape, np.inf, dtype=np.float32)
                d[inside] = shapely.distance(p.shape, shapely.points(xs[inside], ys[inside]))
                mine = inside & (d < dist)
                if mine.any():
                    arr[mine] = p.height(xs[mine], ys[mine])
                    dist[mine] = d[mine]
                # Where two pieces of a level lie over each other, the higher one is what's
                # on top: the bridge, not the steps down from it or the road beneath that
                # got the same level.
                both = inside & (d == 0) & (dist == 0) & ~mine
                if both.any():
                    arr[both] = np.fmax(arr[both], p.height(xs[both], ys[both]))
    return out


def outlines_per_tile(all_pieces, tile_boxes):
    """Per tile: {level: polygons (as rings) of that level's pieces inside the tile}."""
    from osm_area import _polys, _rings
    by_level = defaultdict(list)
    for p in all_pieces:
        by_level[p.level].append(p.shape)
    out = defaultdict(dict)
    for level, shapes in by_level.items():
        merged = unary_union(shapes)
        tree = STRtree(list(tile_boxes.values()))
        keys = list(tile_boxes)
        for k in tree.query(merged, predicate="intersects"):
            polys = [_rings(q) for q in _polys(merged.intersection(tile_boxes[keys[k]])) if q.area > 0.5]
            if polys:
                out[keys[k]][level] = polys
    return out


def merge_ways(ways):
    """Combine duplicate ways, then identify loose ends on the complete structure graph.

    Legacy caches retain their old flags. Mixing legacy and observed-contact
    records in one connected component is ambiguous: refresh its streets chunks.
    Keep the chosen original dict so solve/pieces can leave raised/scrap evidence
    for the caller's pads(), as before.
    """
    records = defaultdict(list)
    for w in ways:
        records[w["id"]].append(w)
    merged, mode = {}, {}
    for ident, rows in records.items():
        w = max(rows, key=lambda r: (len(r["nodes"]), tuple(r["nodes"])))
        versions = {"on_ground" in row for row in rows}
        if len(versions) != 1:
            raise ValueError(f"bridge way {ident} combines old and new streets cache formats; rebuild its streets chunks")
        current = versions.pop()
        field = "on_ground" if current else "grade"
        if any(len(row[field]) != len(row["nodes"]) for row in rows):
            raise ValueError(f"bridge way {ident} has incomplete ground-contact data; rebuild its streets chunks")
        observed = {n for row in rows for n, yes in zip(row["nodes"], row[field]) if yes}
        w[field] = [n in observed for n in w["nodes"]]
        merged[ident], mode[ident] = w, current

    by_node = defaultdict(set)
    uses = defaultdict(int)
    for ident, w in merged.items():
        for n in w["nodes"]:
            by_node[n].add(ident)
            uses[n] += 1
    # Disjoint old/new components can coexist during a selective regional refresh;
    # connected ones cannot silently combine two meanings of a true grade flag.
    unseen = set(merged)
    while unseen:
        start = unseen.pop()
        pending = [start]
        while pending:
            ident = pending.pop()
            for n in merged[ident]["nodes"]:
                for other in by_node[n]:
                    if mode[other] != mode[start]:
                        raise ValueError(f"bridge sources at OSM node {n} combine old and new streets cache formats; rebuild its streets chunks")
                    if other in unseen:
                        unseen.remove(other)
                        pending.append(other)
    on_ground = {n for ident, w in merged.items() if mode[ident]
                 for n, yes in zip(w["nodes"], w["on_ground"]) if yes}
    for ident, w in merged.items():
        if mode[ident]:
            ends = {w["nodes"][0], w["nodes"][-1]}
            w["on_ground"] = [n in on_ground for n in w["nodes"]]
            w["grade"] = [n in on_ground or (n in ends and uses[n] == 1) for n in w["nodes"]]
    return [merged[k] for k in sorted(merged)]


# ---- Which level a street or a tram track is on ------------------------------------------

ON_WAY = 0.3  # m: a street's edge this close to a structure way is that way (they're the same line in the map; another way may run a metre beside it, under it or over it)
ALONG = 0.5  # a track at more than 60° to a bridge's ways isn't on that bridge: it crosses under or over it
OUTLINE = 60.0  # m: as far as a bridge's outline reaches from its ways
BY_WAY = 12.0  # m: a tram track this close to a bridge's way runs along it, or crosses it


class OnLevels:
    """Which level each street and each stretch of tram track is on, from the levels the
    ways got (`ways`: [{kind, level, pts}], kept with the terrain layer) and each tile's
    level outlines. Where two bridges cross, the game can't tell from the outlines alone
    which deck a street's paint or a tram's tracks belong to."""

    def __init__(self, ways, tiles):
        self.ways = ways
        self.lines = [LineString(w["pts"]) for w in ways]
        self.tree = STRtree(self.lines) if ways else None
        self.tiles = tiles
        self._shapes = {}

    def edge(self, e):
        """The level of a street on a bridge or in a tunnel (a network edge with `pts`),
        or None: that of the structure ways most of it runs along."""
        kind = "bridge" if e.get("bridge") else "tunnel" if e.get("tunnel") else None
        if not kind or self.tree is None or len(e["pts"]) < 2:
            return None
        line = LineString(e["pts"])
        n = max(3, int(line.length / 3))
        pts = shapely.points([line.interpolate((k + 0.5) / n, normalized=True).coords[0] for k in range(n)])
        # Each point votes for the way of its kind nearest to it (a ramp down beside a
        # bridge runs within a metre of the bridge's own way in plan).
        best = {}
        hit, near = self.tree.query(pts, predicate="dwithin", distance=ON_WAY)
        for k, o in zip(hit, near):
            if self.ways[o]["kind"] == kind:
                d = self.lines[o].distance(pts[k])
                if k not in best or d < best[k][0]:
                    best[k] = (d, self.ways[o]["level"])
        votes = defaultdict(int)
        for _, lv in best.values():
            votes[lv] += 1
        return max(votes, key=lambda lv: (votes[lv], -abs(lv))) if votes else None

    def stretches(self, e):
        """Where an edge made of several ways changes level along itself: [[metres from
        its start, level], …] from 0 on, or None when it's on one level throughout (see
        edge). A slip road off a bridge is one edge of two ways, the second on a level of
        its own once it has parted from the deck."""
        kind = "bridge" if e.get("bridge") else "tunnel" if e.get("tunnel") else None
        if not kind or self.tree is None or len(e["pts"]) < 2:
            return None
        line = LineString(e["pts"])
        n = max(3, int(line.length / 3))
        pts = shapely.points([line.interpolate((k + 0.5) / n, normalized=True).coords[0] for k in range(n)])
        best = {}
        hit, near = self.tree.query(pts, predicate="dwithin", distance=ON_WAY)
        for k, o in zip(hit, near):
            if self.ways[o]["kind"] == kind:
                d = self.lines[o].distance(pts[k])
                if k not in best or d < best[k][0]:
                    best[k] = (d, self.ways[o]["level"])
        out = []
        for k in range(n):
            if k in best and (not out or out[-1][1] != best[k][1]):
                out.append([round(k / n * line.length, 1) if out else 0.0, best[k][1]])
        return out if len(out) > 1 else None

    def over_cutting(self, e):
        """Where a street on the ground crosses an underpass's cutting on a bridge of
        cuttings' (the ways marked `cut`): [[metres from its start, level], …] from 0 on
        (level 0 the ground), or None."""
        if e.get("bridge") or e.get("tunnel") or self.tree is None or len(e["pts"]) < 2:
            return None
        line = LineString(e["pts"])
        n = max(3, int(line.length / 1.5))
        pts = shapely.points([line.interpolate((k + 0.5) / n, normalized=True).coords[0] for k in range(n)])
        on = {}
        hit, near = self.tree.query(pts, predicate="dwithin", distance=ON_WAY)
        for k, o in zip(hit, near):
            if not self.ways[o].get("cut"):
                continue
            # Along it, not across it (the underpass's own street, under the bridge).
            s, t = line.project(pts[k]), self.lines[o].project(pts[k])
            a, b = line.interpolate(s - 1), line.interpolate(s + 1)
            c, d = self.lines[o].interpolate(t - 1), self.lines[o].interpolate(t + 1)
            u, v = (b.x - a.x, b.y - a.y), (d.x - c.x, d.y - c.y)
            if abs(u[0] * v[0] + u[1] * v[1]) > 0.9 * math.hypot(*u) * math.hypot(*v):
                on[int(k)] = self.ways[o]["level"]
        if not on:
            return None
        out = []
        for k in range(n):
            lv = on.get(k, 0)
            if not out or out[-1][1] != lv:
                out.append([round(k / n * line.length, 1) if out else 0.0, lv])
        return out if len(out) > 1 or out[0][1] else None

    def shapes(self, key):
        """A tile's bridge levels as (level, prepared shape)."""
        if key not in self._shapes:
            out = []
            for lv in self.tiles.get(key, []):
                if lv["kind"] == "bridge":
                    shape = unary_union([Polygon(p[0], p[1:]).buffer(0) for p in lv["polys"]])
                    shapely.prepare(shape)
                    out.append((lv["level"], shape))
            self._shapes[key] = out
        return self._shapes[key]

    def along(self, level, p, d):
        """How nearly a track at `p` heading `d` (a unit vector) runs along a bridge way
        of `level`: 1 along it, 0 across it. Of the ways within BY_WAY the one it follows
        best; with none that close, the longest within OUTLINE (a wide bridge's outline
        reaches well past its ways); 0.6 with none at all (a bridge of the tram's own,
        drawn as an outline alone)."""
        def score(o):
            s = self.lines[o].project(p)
            a, b = self.lines[o].interpolate(max(0, s - 10)), self.lines[o].interpolate(s + 10)
            length = math.hypot(b.x - a.x, b.y - a.y)
            return abs((b.x - a.x) * d[0] + (b.y - a.y) * d[1]) / length if length > 1e-6 else 0.0
        if self.tree is None:
            return 0.6
        mine = lambda reach: [o for o in self.tree.query(p, predicate="dwithin", distance=reach)  # noqa: E731
                              if self.ways[o]["kind"] == "bridge" and self.ways[o]["level"] == level]
        close = mine(BY_WAY)
        if close:
            return max(score(o) for o in close)
        far = mine(OUTLINE)
        return score(max(far, key=lambda o: self.lines[o].length)) if far else 0.6

    def rails(self, key, rails, roads=None):
        """The stretches of a tile's tram tracks that are on a bridge: [{level, pts}].
        A stretch over two decks at once (one bridge crossing another) is on the one it
        runs along, and one that only crosses a bridge's outline, or lies in a street on
        the ground, is under it."""
        shapes = self.shapes(key)
        out = []
        if not shapes:
            return out
        # A track in a street on the ground is on the ground, whatever is over it (it may
        # run along under a viaduct). `roads`: the tile's street polygons by kind.
        on_street = on_bridge = None
        if roads:
            polys = lambda kinds: unary_union([Polygon(r[0], r[1:]).buffer(0) for k in kinds for r in roads.get(k, [])])  # noqa: E731
            on_street, on_bridge = polys([k for k in roads if k != "bridge"]), polys(["bridge"])
        for r in rails:
            if r["kind"] != "tram" or len(r["pts"]) < 2:
                continue
            ps = [r["pts"][0]]
            for a, b in zip(r["pts"], r["pts"][1:]):
                n = max(1, math.ceil(math.dist(a, b) / 4))
                ps += [[a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n] for k in range(1, n + 1)]
            cur, cur_level = None, 0
            for a, b in zip(ps, ps[1:]):
                length = math.dist(a, b)
                if length < 1e-6:
                    continue
                m = shapely.Point((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)
                on = [lv for lv, shape in shapes if shape.contains(m)]
                level = 0
                if on and on_street is not None and on_street.contains(m) and not on_bridge.contains(m):
                    on = []
                if on:
                    # On the deck it runs along; not on one it only passes under (the
                    # trams on the embankment under Železniční most were laid on the
                    # railway bridge's footways, 4 m up).
                    d = ((b[0] - a[0]) / length, (b[1] - a[1]) / length)
                    score = {lv: round(self.along(lv, m, d), 2) for lv in on}
                    best = max(on, key=lambda lv: (score[lv], -lv))
                    if score[best] >= ALONG:
                        level = best
                if level != cur_level:
                    if cur and cur_level:
                        out.append({"level": cur_level, "pts": cur})
                    cur, cur_level = [[round(a[0], 2), round(a[1], 2)]], level
                if cur is not None:
                    cur.append([round(b[0], 2), round(b[1], 2)])
            if cur and cur_level:
                out.append({"level": cur_level, "pts": cur})
        return out


def cut_ramps(all_pieces):
    """Each stairs' profile without the stretches that lie on a deck way of its own level
    (once the levels are known): there the deck's lattice is what counts, for the stairs
    and for whatever else crosses them. [(piece, {w, pts})], a piece once per stretch left."""
    with_ramp = [p for p in all_pieces if p.ramp]
    decks = [p for p in all_pieces if not p.ramp and p.kind == "bridge" and p.members]
    tree = STRtree([p.shape for p in decks]) if decks else None
    out = []
    for p in with_ramp:
        pts = np.array(p.ramp["pts"])
        line = LineString(pts[:, :2])
        s = np.concatenate([[0], np.cumsum(np.hypot(*np.diff(pts[:, :2], axis=0).T))])
        over = [decks[k].shape for k in (tree.query(line, predicate="intersects") if tree is not None else []) if decks[k].level == p.level]
        left = line.difference(unary_union(over)) if over else line
        for part in shapely.get_parts(left):
            if part.geom_type != "LineString" or part.length < 0.5:
                continue
            a, b = sorted((line.project(shapely.Point(part.coords[0])), line.project(shapely.Point(part.coords[-1]))))
            at = np.unique(np.concatenate([[a], s[(s > a) & (s < b)], [b]]))
            xy = [line.interpolate(v) for v in at]
            out.append((p, {"w": p.ramp["w"], "pts": [[round(q.x, 2), round(q.y, 2), round(float(z), 2)] for q, z in zip(xy, np.interp(at, s, pts[:, 2]))]}))
    return out


def ramps_per_tile(all_pieces, tile_boxes):
    """Per tile: {level: the profiles of that level's stairs that reach into the tile}."""
    out = defaultdict(lambda: defaultdict(list))
    cut = cut_ramps(all_pieces)
    if cut:
        keys = list(tile_boxes)
        tree = STRtree(list(tile_boxes.values()))
        for p, ramp in cut:
            reach = LineString([q[:2] for q in ramp["pts"]]).buffer(ramp["w"] / 2 + 0.1)
            for k in tree.query(reach, predicate="intersects"):
                out[keys[k]][p.level].append(ramp)
    return out


def build(ways, outlines, roads, ground, local, tiles, N, T, step, gx0, gy0, tile_boxes, source_manifest=None, way_levels=None, ramps_out=None, streets=()):
    """Everything for the game: per tile, a list of (level, kind, heights, polygons).
    `ways`: structure_ways from every chunk; `outlines`: the man_made=bridge polygons;
    `roads`: the street polygons (for the ends of bridges with no street on them).
    `source_manifest`: optional dictionary collecting the IPR bridge inputs for
    strict assembly's freshness check. `way_levels`: an optional list that gets each
    way's level, {kind, level, pts} (for OnLevels). `ramps_out`: an optional dictionary
    that gets, per tile and level, the profiles of the ways too steep for the lattice.
    `streets`: the car streets on the ground, as lines (see ipr_ends).
    """
    ways = merge_ways(ways)
    companions = [w for w in ways if w.get("survey_sources")]
    if companions:
        ways = [w for w in ways if not w.get("survey_sources")]
    decks = ipr_decks(local, source_manifest)
    net, profiles = solve(ways, ground, decks, streets=streets)
    # Again with the stairs known (the first run's profiles say which ways are stairs).
    soft = frozenset(ways[k]["id"] for k in stairs(ways, profiles))
    if soft:
        net, profiles = solve(ways, ground, decks, soft, streets)
    ways, profiles = drop_shallow(ways, net, profiles, ground)
    # These spans already have ground contacts at both ends. Keep their profiles
    # out of the graph for existing bridges and tunnels.
    ways += companions
    profiles += [companion_profile(w, ground) for w in companions]
    road_tree = STRtree(roads) if roads else None
    all_pieces, groups = pieces(ways, profiles, outlines, ground, decks, road_tree)
    survey_ids = {w["id"] for w in companions}
    deepest = assign_levels(groups, survey_ids)
    if way_levels is not None:  # (the pieces start with one per way, in the ways' order)
        way_levels.extend({"kind": w["kind"], "level": p.level, "pts": w["pts"],
                           **{k: w[k] for k in ("cut", "survey_sources") if w.get(k)}} for w, p in zip(ways, all_pieces))
    print(f"  {len(all_pieces)} bridge and tunnel pieces on up to {deepest} levels either way")
    heights = rasterise(all_pieces, tiles, N, T, step, gx0, gy0)
    if companions:
        # A whole-level union can change ring ordering and simplification far
        # from the added spans. Keep the regular outline pass for other tiles.
        extra = {p for p in all_pieces if survey_ids.intersection(p.members)}
        polys = outlines_per_tile([p for p in all_pieces if p not in extra], tile_boxes)
        keys = list(tile_boxes)
        tree = STRtree(list(tile_boxes.values()))
        touched = {keys[i] for p in extra for i in tree.query(p.shape.buffer(PAD), predicate="intersects")}
        polys.update(outlines_per_tile(all_pieces, {k: tile_boxes[k] for k in sorted(touched)}))
    else:
        polys = outlines_per_tile(all_pieces, tile_boxes)
    if ramps_out is not None:
        ramps_out.update({k: dict(v) for k, v in ramps_per_tile(all_pieces, tile_boxes).items()})
    out = {}
    for k in tiles:
        levels = sorted(set(heights.get(k, {})) & set(polys.get(k, {})))
        if levels:
            out[k] = [(lv, "bridge" if lv > 0 else "tunnel", heights[k][lv], polys[k][lv]) for lv in levels]
    return out
