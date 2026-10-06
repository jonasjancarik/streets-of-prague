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
BESIDE = 10.0  # m: two structures this close share lattice points (PAD, and a cell's diagonal)
SAME = 3.0  # m: two structures further apart in height than this can't share a level
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

def ipr_decks(local, source_manifest=None):
    """IPR's bridges' flat faces on a 1 m grid in the local metres: {cell: heights},
    cell = (round(x), round(y)). Kept per area in pipeline/.cache/ipr/parsed/.
    Optional source_manifest receives the shapefile identities used by this cache.
    """
    cache = CACHE / "parsed" / f"mosty_{zlib.crc32(local.encode()):08x}.pkl"
    shp = CACHE / "mosty" / "mosty.shp"
    if not shp.exists():
        print("  downloading IPR's bridges…")
        data = urllib.request.urlopen(f"https://www.arcgis.com/sharing/rest/content/items/{MOSTY_ITEM}/data").read()
        shp.parent.mkdir(parents=True, exist_ok=True)
        zipfile.ZipFile(io.BytesIO(data)).extractall(shp.parent)
    sources = build_cache.sources(sorted(p for p in shp.parent.iterdir() if p.is_file()))
    if source_manifest is not None:
        source_manifest.update(sources)
    key = [1, local, sources, build_cache.function_key(ipr_decks), build_cache.runtime_key()]
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

    def __init__(self, ways):
        self.xy, self.key, self.adj = [], {}, []
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
            for a, b in zip(path, path[1:]):
                d = math.dist(self.xy[a], self.xy[b]) or 0.01
                self.adj[a].append((b, d))
                self.adj[b].append((a, d))
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
            self.kind.append(kind)
        return i

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
                    weight = 1.0 / length
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


def solve(ways, ground, decks):
    """Heights along every structure way (metres above sea level), as a profile per
    way: (cumulative distance along it, heights) at its points. `ground(xs, ys)`: bare
    terrain; `decks`: IPR's bridges (ipr_decks)."""
    net = Net(ways)
    if not len(net.xy):
        return net, []
    T = ground(net.xy[:, 0], net.xy[:, 1])
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
        if all(i in fixed for i in ends) and abs(fixed[ends[0]] - fixed[ends[1]]) > STEEP * max(length[w["id"]], 1):
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

    # Bridges: IPR's deck where it has one.
    kind = np.array(net.kind)
    snapped = 0
    for i in np.nonzero(kind == "bridge")[0]:
        if i in fixed or np.isnan(net.h[i]):
            continue
        z = deck_at(decks, *net.xy[i], net.h[i] + 2.0, below=6.0, above=4.0)
        if not np.isnan(z):
            fixed[i] = z
            snapped += 1
    if snapped:
        near = net.spread(fixed)

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
    keep = set(base) | crossed
    for _ in range(25):
        h = net.h.copy()
        for i, nb in enumerate(net.adj):
            if i in keep or not nb:
                continue
            h[i] = 0.5 * net.h[i] + 0.5 * np.mean([net.h[j] for j, _ in nb])
        net.h = h
    profiles = paths_profiles(net)
    print(f"  {len(ways)} bridge and tunnel ways: {len(base)} ends on the ground, {snapped} points on IPR's decks")
    return net, profiles


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
    bridges = [k for k, w in enumerate(ways) if w["kind"] == "bridge"]
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

    for poly in outlines:
        if poly.area < 30:
            continue
        on = []
        if tree is not None:
            hits = [bridges[k] for k in tree.query(poly, predicate="intersects")]
            # The ways on this bridge: those at the height of the one most of which lies
            # on it (not a flyover crossing it higher up, or a street passing under).
            share = {k: lines[k].intersection(poly).length for k in hits}
            if share and max(share.values()) > 5:
                ref = max(share, key=share.get)
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
                    if not distinct and abs(out[k].height(np.array([m.x]), np.array([m.y]))[0] - href) < SAME:
                        on.append(k)
        if on:
            ls = [lines[k] for k in on]
            hs = [out[k].height for k in on]

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


STEEP, STEEP_LENGTH = 0.15, 80.0  # a bridge way shorter than this many metres, steeper than this: not a ramp, a mistake in the map
SCRAP = 25.0  # m: a bridge way shorter than this, lying on a much longer one, is a scrap of that bridge
PORTAL = 12.0  # m a tunnel reaches out of its portal, at the portal's height


def pads(ways):
    """Where the ground has to come up to a bridge's end: [(polygon, height)], the
    street's last metres between the edge of the wall the bridge comes off and where the
    map has the bridge begin (see abutment). They'd hang down to the quay below."""
    out = []
    for w in ways:
        if w.get("scrap"):  # (its ends' heights aren't the bridge's: see pieces)
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


def assign_levels(groups):
    """Levels for the groups: bridges 1, 2, … from the lowest up and tunnels -1, -2, …
    from the highest down, so that no two groups overlapping at heights more than
    SAME apart share one."""
    info = []
    for g in groups:
        shape = unary_union([p.shape for p in g])
        c = shape.representative_point()
        h = float(np.nanmean(g[0].height(np.array([c.x]), np.array([c.y]))))
        declared = {p.mapped_layer for p in g if p.mapped_layer is not None}
        nodes = frozenset(n for p in g for n in p.nodes)
        info.append((g, shape, h, g[0].kind, declared, nodes))
    tree = STRtree([s for _, s, _, _, _, _ in info])
    order = sorted(range(len(info)), key=lambda k: info[k][2] if info[k][3] == "bridge" else -info[k][2])
    level = {}
    for k in order:
        g, shape, _, kind, declared, nodes = info[k]
        taken = set()
        for o in tree.query(shape, predicate="dwithin", distance=BESIDE):
            if o == k or o not in level or info[o][3] != kind:
                continue
            # Explicitly separate decks can be fully nested, with no nearby
            # exterior edge to sample. Their mapped layers remain distinct.
            mapped_apart = bool(declared and info[o][4] and declared.isdisjoint(info[o][4]) and nodes.isdisjoint(info[o][5]))
            if mapped_apart:
                taken.add(level[o])
                continue
            # Over each other or side by side: a level's heights are on the terrain's lattice
            # and reach PAD past each piece, so steps going down beside a bridge's deck, or
            # a jetty at the water's level, would pull the deck's edge down with them. Where
            # the two are close, are they anywhere more than SAME apart?
            near = shape.exterior if shape.geom_type == "Polygon" else shape.boundary
            near = near.intersection(info[o][1].buffer(BESIDE))
            if near.is_empty or near.length < 0.5:
                continue
            ps = [near.interpolate(d) for d in np.arange(0, near.length, 3.0)]
            xs, ys = np.array([q.x for q in ps]), np.array([q.y for q in ps])
            with np.errstate(invalid="ignore"):
                apart = np.abs(piece_height(g, xs, ys) - piece_height(info[o][0], xs, ys))
            if np.nanmax(apart, initial=0) > SAME:
                taken.add(level[o])
        step = 1 if kind == "bridge" else -1
        lv = step
        while lv in taken:
            lv += step
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

ON_WAY = 1.5  # m: a street's edge this close to a structure way is that way
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
        votes = defaultdict(int)
        hit, near = self.tree.query(pts, predicate="dwithin", distance=ON_WAY)
        seen = set()
        for k, o in zip(hit, near):
            w = self.ways[o]
            if w["kind"] == kind and (k, w["level"]) not in seen:
                seen.add((k, w["level"]))
                votes[w["level"]] += 1
        return max(votes, key=lambda lv: (votes[lv], -abs(lv))) if votes else None

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
        of `level` close by: 1 along it, 0 across it; 0.6 with no way near (a bridge of the
        tram's own, drawn as an outline alone)."""
        best = None
        for o in self.tree.query(p, predicate="dwithin", distance=BY_WAY) if self.tree is not None else []:
            w = self.ways[o]
            if w["kind"] != "bridge" or w["level"] != level:
                continue
            s = self.lines[o].project(p)
            a, b = self.lines[o].interpolate(max(0, s - 1)), self.lines[o].interpolate(s + 1)
            length = math.hypot(b.x - a.x, b.y - a.y)
            if length > 1e-6:
                best = max(best or 0, abs((b.x - a.x) * d[0] + (b.y - a.y) * d[1]) / length)
        return 0.6 if best is None else best

    def rails(self, key, rails):
        """The stretches of a tile's tram tracks that are on a bridge: [{level, pts}].
        A stretch over two decks at once (one bridge crossing another) is on the one it
        runs along."""
        shapes = self.shapes(key)
        out = []
        if not shapes:
            return out
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
                if len(on) == 1:
                    level = on[0]
                elif on:
                    d = ((b[0] - a[0]) / length, (b[1] - a[1]) / length)
                    level = max(on, key=lambda lv: (round(self.along(lv, m, d), 2), -lv))
                if level != cur_level:
                    if cur and cur_level:
                        out.append({"level": cur_level, "pts": cur})
                    cur, cur_level = [[round(a[0], 2), round(a[1], 2)]], level
                if cur is not None:
                    cur.append([round(b[0], 2), round(b[1], 2)])
            if cur and cur_level:
                out.append({"level": cur_level, "pts": cur})
        return out


def build(ways, outlines, roads, ground, local, tiles, N, T, step, gx0, gy0, tile_boxes, source_manifest=None, way_levels=None):
    """Everything for the game: per tile, a list of (level, kind, heights, polygons).
    `ways`: structure_ways from every chunk; `outlines`: the man_made=bridge polygons;
    `roads`: the street polygons (for the ends of bridges with no street on them).
    `source_manifest`: optional dictionary collecting the IPR bridge inputs for
    strict assembly's freshness check. `way_levels`: an optional list that gets each
    way's level, {kind, level, pts} (for OnLevels).
    """
    ways = merge_ways(ways)
    decks = ipr_decks(local, source_manifest)
    net, profiles = solve(ways, ground, decks)
    ways, profiles = drop_shallow(ways, net, profiles, ground)
    road_tree = STRtree(roads) if roads else None
    all_pieces, groups = pieces(ways, profiles, outlines, ground, decks, road_tree)
    deepest = assign_levels(groups)
    if way_levels is not None:  # (the pieces start with one per way, in the ways' order)
        way_levels.extend({"kind": w["kind"], "level": p.level, "pts": w["pts"]} for w, p in zip(ways, all_pieces))
    print(f"  {len(all_pieces)} bridge and tunnel pieces on up to {deepest} levels either way")
    heights = rasterise(all_pieces, tiles, N, T, step, gx0, gy0)
    polys = outlines_per_tile(all_pieces, tile_boxes)
    out = {}
    for k in tiles:
        levels = sorted(set(heights.get(k, {})) & set(polys.get(k, {})))
        if levels:
            out[k] = [(lv, "bridge" if lv > 0 else "tunnel", heights[k][lv], polys[k][lv]) for lv in levels]
    return out
