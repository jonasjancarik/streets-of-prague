"""Street widths where OSM gives none and the technical map doesn't reach (plan 031).

A class alone says too little: a residential street is 8 m among blocks of flats and
5 m between village houses. Streets with a width or lanes tag, and those the survey
has, keep their widths; the others get a default for the setting (the buildings near
them), and no more than the room there is between the buildings, fences and walls
either side, less a verge each.
"""

import numpy as np
import shapely
from shapely import STRtree
from shapely.geometry import Polygon

from kerbs import _samples

# Carriageway width by class and setting. Calibrated on the outer districts inside the
# city (surveyed kerb to kerb, medians): houses 5.6-6.0 for residential, 5.6 living
# streets, flats 8.0, open land 7.4. Surveyed widths include parking bays, so the
# driving width is a little under; round numbers a little under the medians.
DEFAULTS = {
    "residential": {"houses": 5.5, "flats": 7.5, "open": 7.0},
    "unclassified": {"houses": 5.5, "flats": 7.0, "open": 6.0},
    "living_street": {"houses": 5.0, "flats": 5.5, "open": 5.0},
    "tertiary": {"houses": 7.5, "flats": 9.0, "open": 8.0},
    "service": {"houses": 3.5, "flats": 5.0, "open": 4.0},
}
MIN_WIDTH = {"service": 3.0}  # others: 4.0
FALLBACK_MIN = 4.0
SETTING_RADIUS = 35.0  # m: the buildings that make a street's setting
FLATS_SHARE = 0.35  # of the buildings near it over 400 m², or a mean footprint over 450
FLATS_MEAN = 450.0
VERGE = 0.75  # m kept clear on each side of the carriageway
REACH = 14.0  # m: how far to look for something either side
MIN_SHARE = 0.4  # of a street's samples must have something on both sides


class Setting:
    """The buildings, mapped fences and walls to size streets against."""

    def __init__(self, buildings, barriers):
        shapes = [Polygon(b["rings"][0], b["rings"][1:]) for b in buildings if not b.get("part")]
        self.shapes = np.array(shapes, dtype=object)
        self.area = np.array([s.area for s in shapes])
        self.tree = STRtree(self.shapes)
        # What may stand in a street's way sideways: buildings, and the lines of barriers.
        lines = [shapely.linestrings(b["pts"]) for b in barriers if len(b["pts"]) > 1]
        self.obstacles = np.array([*shapes, *lines], dtype=object)
        self.obstacle_tree = STRtree(self.obstacles)

    def kind(self, lines):
        """"houses", "flats" or "open" for each line, by the buildings within SETTING_RADIUS."""
        out = []
        if not len(self.shapes):
            return ["open"] * len(lines)
        ri, bi = self.tree.query(np.array(lines, dtype=object), predicate="dwithin", distance=SETTING_RADIUS)
        counts = np.bincount(ri, minlength=len(lines))
        big = np.bincount(ri, weights=self.area[bi] > 400, minlength=len(lines))
        mean = np.bincount(ri, weights=self.area[bi], minlength=len(lines)) / np.maximum(counts, 1)
        for k in range(len(lines)):
            if counts[k] < 3:
                out.append("open")
            elif big[k] / counts[k] > FLATS_SHARE or mean[k] > FLATS_MEAN:
                out.append("flats")
            else:
                out.append("houses")
        return out

    def room(self, lines):
        """Median distance between what stands either side of each line (NaN: not enough)."""
        out = np.full(len(lines), np.nan)
        if not len(lines) or not len(self.obstacles):
            return out
        idx, orig, tang = _samples(lines)
        left = np.stack([-tang[:, 1], tang[:, 0]], axis=1)
        dist = []
        for s in (1, -1):
            rays = shapely.linestrings(np.stack([orig, orig + left * s * REACH], axis=1))
            best = np.full(len(orig), np.inf)
            ri, gi = self.obstacle_tree.query(rays, predicate="intersects")
            if len(ri):
                hit = shapely.distance(shapely.points(orig[ri]), shapely.intersection(rays[ri], self.obstacles[gi]))
                np.minimum.at(best, ri, np.where(hit > 0.1, hit, np.inf))  # not from inside a building
            dist.append(best)
        both = np.isfinite(dist[0]) & np.isfinite(dist[1])
        gap = np.where(both, dist[0] + dist[1], np.nan)
        counts = np.bincount(idx, minlength=len(lines))
        starts = np.concatenate([[0], np.cumsum(counts)[:-1]])
        for k in range(len(lines)):
            v = gap[starts[k]:starts[k] + counts[k]]
            if counts[k] and both[starts[k]:starts[k] + counts[k]].sum() >= MIN_SHARE * counts[k]:
                out[k] = np.nanmedian(v)
        return out

    def widths(self, lines, hws):
        """The width to give each street, or None for a class this doesn't size."""
        kinds = self.kind(lines)
        room = self.room(lines)
        out = []
        for hw, kind, gap in zip(hws, kinds, room):
            table = DEFAULTS.get(hw)
            if table is None:
                out.append(None)
                continue
            width = table[kind]
            if not np.isnan(gap):
                width = min(width, max(gap - 2 * VERGE, MIN_WIDTH.get(hw, FALLBACK_MIN)))
            out.append(round(width, 2))
        return out


def apply(setting, kerbs, lines, hws, ests, tagged):
    """The widths for streets that are neither tagged nor surveyed: each estimate's
    half width is set to match. Returns a width per street (None where unchanged)."""
    if setting is None or not len(lines):
        return [None] * len(lines)
    share = kerbs.surveyed(lines)
    pick = [k for k in range(len(lines)) if not tagged[k] and share[k] < 0.5 and hws[k] in DEFAULTS]
    out = [None] * len(lines)
    if pick:
        for k, w in zip(pick, setting.widths([lines[k] for k in pick], [hws[k] for k in pick])):
            ests[k]["half"] = w / 2
            out[k] = w
    return out


SHOULDER = 0.6  # m of gravel beside the carriageway of a through road
SHOULDER_ROADS = ("tertiary", "unclassified")


def shoulders(setting, kerbs, lines, hws, guessed, sides, bridges, surveyed_share):
    """A strip of gravel along both sides of the through roads sized here (no width or
    lanes tag, not surveyed, not on a bridge), outside blocks of flats: out in the
    country a road has a shoulder and then grass, not a kerb. `sides` is each line's
    (left, right) half widths. The strips reach under the carriageway, which is drawn
    over them."""
    pick = [k for k, hw in enumerate(hws) if hw in SHOULDER_ROADS and guessed[k] and not bridges[k]]
    if not pick:
        return []
    shares = kerbs.surveyed([lines[k] for k in pick])
    kinds = setting.kind([lines[k] for k in pick])
    out = []
    for k, share, kind in zip(pick, shares, kinds):
        if share >= surveyed_share or kind == "flats":
            continue
        left, right = sides[k]
        out += [lines[k].buffer(left + SHOULDER, single_sided=True), lines[k].buffer(-(right + SHOULDER), single_sided=True)]
    return out
