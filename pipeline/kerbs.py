"""Where a street's kerbs are, each side on its own.

OSM gives a street's lanes, not how wide it is from kerb to kerb, so the width
from lanes (osm_area.road_width) leaves out parking lanes and the room a tram
takes. Each side starts from half the driving width, widened to take in a tram
track running in the street and then a tagged parking lane. Where the pavement
is mapped as its own way beside the street (as it mostly is in Prague), the kerb
goes to that pavement's inner edge instead, within reason. That catches a
pavement belonging to some other street or a path across a square.
"""

import numpy as np
import shapely
from shapely import STRtree

# How far cars reach into the street from the kerb, by how they stand.
PARKING_DEPTH = {"parallel": 2.0, "diagonal": 5.0, "perpendicular": 5.0}
PARKING_KINDS = tuple(PARKING_DEPTH)
NO_PARKING = {"no", "separate", "no_parking", "no_stopping", "fire_lane"}
ON_KERB = {"on_kerb", "half_on_kerb", "kerb"}  # cars stand (half) on the pavement

STEP = 5.0  # between samples along a street
END = 6.0  # samples keep this far from the ends, where other streets join
PARALLEL = 0.85  # |cos| of the angle a pavement or track makes with the street
TRAM_LANE = 1.6  # half a lane, beside the track centre
# A mapped pavement may put the kerb this much past the estimate: more for one
# tagged as a street's pavement (footway=sidewalk) than for any other path.
MORE = {True: 8.0, False: 4.0}
LESS = 1.0  # or this much short of it, where the width is only a guess by class
# The surveyed surface may reach this much past the estimate (parking bays, turning
# lanes); further, and it's a car park or a square beside the street, not its kerb.
BEYOND = 8.0
ON = 1.0  # a sample this close to the surveyed surface is on it


def parking_depth(tag, side):
    """How far parked cars reach into the street on one side ("left"/"right"): 0 if none."""
    for s in (side, "both"):
        v, o = tag(f"parking:{s}"), tag(f"parking:{s}:orientation")
        if v in NO_PARKING:
            return 0.0
        if v in ON_KERB:
            return 1.0 if v == "half_on_kerb" else 0.0
        if v or o:
            return PARKING_DEPTH.get(o, 2.0)
        lane = tag(f"parking:lane:{s}")  # the older scheme
        if lane in NO_PARKING:
            return 0.0
        if lane in PARKING_KINDS:
            where = tag(f"parking:lane:{s}:{lane}")
            if where in ON_KERB:
                return 1.0 if where == "half_on_kerb" else 0.0
            return PARKING_DEPTH[lane]
    return 0.0


def estimate(drive, tag, guessed):
    """What the tags say about one street: its driving width, and for "left" and "right"
    the room parked cars take. `guessed`: the width is only a default for the class."""
    # A tagged width is kerb to kerb already.
    tagged = tag("width") is not None
    return {"half": drive / 2, **{side: 0.0 if tagged else parking_depth(tag, side) for side in ("left", "right")},
            "tram": tag("embedded_rails") not in (None, "no"), "guessed": guessed}


class Kerbs:
    """Paths that may be pavements (lines with their half widths and whether they're
    tagged as a street's pavement), tram tracks and the car roads themselves to
    measure streets against."""

    def __init__(self, sidewalks, trams, roads, surface=None):
        # The street surfaces from the technical map (dtm.streets), one polygon each,
        # and their edges (the kerbs) cut into segments, to find quickly.
        self.surf = np.array([p for p in shapely.get_parts(surface) if p.geom_type == "Polygon"]
                             if surface is not None and not surface.is_empty else [], dtype=object)
        rings = shapely.get_rings(self.surf) if len(self.surf) else np.array([], dtype=object)
        coords, ring = shapely.get_coordinates(rings, return_index=True)
        same = ring[1:] == ring[:-1]
        self.kerb_a, self.kerb_b = coords[:-1][same], coords[1:][same]
        self.kerb_tree = STRtree(shapely.linestrings(np.stack([self.kerb_a, self.kerb_b], axis=1))) if same.any() else None
        self.sw = np.array([g for g, _, _ in sidewalks], dtype=object)
        self.sw_half = np.array([h for _, h, _ in sidewalks], dtype=float)
        self.sw_more = np.array([MORE[bool(tagged)] for _, _, tagged in sidewalks], dtype=float)
        self.trams = np.array(list(trams), dtype=object)
        self.roads = np.array(list(roads), dtype=object)
        self.sw_tree, self.tram_tree, self.road_tree = STRtree(self.sw), STRtree(self.trams), STRtree(self.roads)
        self._sample_cache = None

    def _sampled(self, lines):
        """Reuse only the last identical set of immutable lines, in the same order."""
        got = self._sample_cache
        if got is not None and len(got[0]) == len(lines) and all(a is b for a, b in zip(got[0], lines)):
            return got[1]
        idx, orig, tang = _samples(lines)
        on, inside = self._on(orig)
        data = idx, orig, tang, on, inside
        self._sample_cache = (tuple(lines), data)
        return data

    def surveyed(self, lines):
        """The share of each street's centre line that runs on the surveyed surface."""
        if not lines:
            return np.zeros(0)
        idx, _, _, on, _ = self._sampled(lines)
        return np.bincount(idx, weights=on, minlength=len(lines)) / np.maximum(np.bincount(idx, minlength=len(lines)), 1)

    def __call__(self, lines, ests):
        """(left, right) kerb offsets from the centre line of each street, as seen along it."""
        if not lines:
            return []
        idx, orig, tang, on, inside = self._sampled(lines)
        left = np.stack([-tang[:, 1], tang[:, 0]], axis=1)

        halves = np.array([e["half"] for e in ests])
        out = [[None, None] for _ in lines]
        for s, side in ((1, "left"), (-1, "right")):
            park = np.array([e[side] for e in ests])
            # Tram tracks first: one in the street needs a lane's room beside it.
            reach = halves + np.where([e["tram"] for e in ests], 3.0, 0.5)
            tram = self._hits(orig, left * s, tang, reach[idx], self.tram_tree, self.trams)
            base = halves.copy()
            for k, v in _per_line(idx, tram, len(lines), 0.5):
                base[k] = max(base[k], v + TRAM_LANE)
            est = base + park
            sw = self._hits(orig, left * s, tang, est[idx], self.sw_tree, self.sw, self.sw_half, self.sw_more)
            # A pavement beyond another carriageway (the other half of a divided street,
            # a service road alongside) is that one's.
            road = self._hits(orig, left * s, tang, est[idx] + max(MORE.values()), self.road_tree, self.roads, skip=0.5)
            sw = np.where(np.isnan(road) | (sw < road), sw, np.nan)
            measured = dict(_per_line(idx, sw, len(lines), 0.4))
            surveyed = dict(_per_line(idx, self._across(orig, left * s, est[idx] + BEYOND, on, inside), len(lines), 0.4))
            for k, e in enumerate(ests):
                kerb = est[k]
                m = measured.get(k)
                if k in surveyed:
                    kerb = max(surveyed[k], 1.5)
                elif m is not None:
                    low = base[k] - LESS if e["guessed"] else base[k]
                    kerb = max(m, low, 1.5)
                out[k][0 if s > 0 else 1] = round(float(kerb), 2)
        return [tuple(o) for o in out]

    def _on(self, orig):
        """For each sample: whether it's on the surveyed surface (or within ON of it),
        and whether it's inside it."""
        on, inside = np.zeros(len(orig), bool), np.zeros(len(orig), bool)
        if len(self.surf):
            tree = STRtree(shapely.points(orig))
            on[tree.query(self.surf, predicate="dwithin", distance=ON)[1]] = True
            inside[tree.query(self.surf, predicate="contains")[1]] = True
        return on, inside

    def _across(self, orig, normal, reach, on, inside):
        """How far the surveyed surface reaches across the street from each sample (along
        `normal`) before it ends at the kerb; NaN where the sample isn't on the surface
        or the surface carries on past `reach`."""
        best = np.full(len(orig), np.nan)
        si = on.nonzero()[0]
        if self.kerb_tree is None or not len(si):
            return best
        ends = orig[si] + normal[si] * reach[si][:, None]
        ri, ki = self.kerb_tree.query(shapely.linestrings(np.stack([orig[si], ends], axis=1)))
        # Where each ray (p + t d) crosses each kerb segment (a + u (b - a)) near it.
        p, d = orig[si][ri], normal[si][ri]
        a, e = self.kerb_a[ki], self.kerb_b[ki] - self.kerb_a[ki]
        den = d[:, 0] * e[:, 1] - d[:, 1] * e[:, 0]
        ok = np.abs(den) > 1e-9
        den = np.where(ok, den, 1.0)
        w = a - p
        t = (w[:, 0] * e[:, 1] - w[:, 1] * e[:, 0]) / den
        u = (w[:, 0] * d[:, 1] - w[:, 1] * d[:, 0]) / den
        ok &= (u >= 0) & (u <= 1) & (t > 0) & (t <= reach[si][ri])
        ri, t = ri[ok], t[ok]
        # The first kerb out from a sample inside the surface; from one just outside it,
        # the second (the first is where the ray comes onto the surface).
        order = np.lexsort((t, ri))
        ri, t = ri[order], t[order]
        first = np.r_[True, ri[1:] != ri[:-1]]
        rank = np.arange(len(ri)) - np.maximum.accumulate(np.where(first, np.arange(len(ri)), 0))
        want = np.where(inside[si][ri], 0, 1)
        hit = rank == want
        best[si[ri[hit]]] = t[hit]
        return best

    def _hits(self, orig, normal, tang, reach, tree, geoms, half=None, more=None, skip=0.0):
        """Distance from each sample to the nearest line parallel to the street across
        it (further than `skip`, which leaves out the street itself), less that line's
        `half` width; NaN where there's none within `reach` (plus the line's `more`)."""
        best = np.full(len(orig), np.nan)
        if not len(geoms):
            return best
        half = np.zeros(len(geoms)) if half is None else half
        more = np.zeros(len(geoms)) if more is None else more
        ends = orig + normal * (reach + more.max() + half.max())[:, None]
        rays = shapely.linestrings(np.stack([orig, ends], axis=1))
        ri, gi = tree.query(rays, predicate="intersects")
        if not len(ri):
            return best
        o = shapely.points(orig[ri])
        near = shapely.get_point(shapely.shortest_line(o, shapely.intersection(rays[ri], geoms[gi])), 1)
        at = shapely.line_locate_point(geoms[gi], near)
        a = shapely.get_coordinates(shapely.line_interpolate_point(geoms[gi], at - 1))
        b = shapely.get_coordinates(shapely.line_interpolate_point(geoms[gi], at + 1))
        d = b - a
        n = np.linalg.norm(d, axis=1)
        cos = np.abs((d * tang[ri]).sum(axis=1)) / np.maximum(n, 1e-9)
        dist = shapely.distance(o, near) - half[gi]
        ok = (cos > PARALLEL) & (n > 0) & (dist <= reach[ri] + more[gi]) & (dist > skip)
        dist = np.where(ok, dist, np.inf)
        full = np.full(len(orig), np.inf)
        np.minimum.at(full, ri, dist)
        return np.where(np.isfinite(full), full, np.nan)


def _samples(lines):
    """Points every STEP metres along each line, away from its ends: (line of each,
    the points, the unit direction of the line there)."""
    idx, orig, tang = [], [], []
    for k, line in enumerate(lines):
        L = line.length
        ds = np.array([L / 2]) if L < 2 * END + 1 else np.arange(END, L - END + 1e-6, STEP)
        a = shapely.get_coordinates(shapely.line_interpolate_point(line, np.maximum(ds - 0.5, 0)))
        b = shapely.get_coordinates(shapely.line_interpolate_point(line, np.minimum(ds + 0.5, L)))
        t = b - a
        n = np.linalg.norm(t, axis=1, keepdims=True)
        t = np.divide(t, n, out=np.zeros_like(t), where=n > 0)
        idx.append(np.full(len(ds), k))
        orig.append((a + b) / 2)
        tang.append(t)
    return np.concatenate(idx), np.concatenate(orig), np.concatenate(tang)


def _per_line(idx, values, n_lines, share):
    """(line, median) for lines where at least `share` of the samples found something."""
    counts = np.bincount(idx, minlength=n_lines)
    starts = np.concatenate([[0], np.cumsum(counts)[:-1]])
    for k in range(n_lines):
        v = values[starts[k]:starts[k] + counts[k]]
        hit = v[~np.isnan(v)]
        if counts[k] and len(hit) >= max(1, share * counts[k]):
            yield k, float(np.median(hit))
