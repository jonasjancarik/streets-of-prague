"""Join a driving edge to a bridge across a short gap in a clipped abutment pad."""

from collections import defaultdict

import numpy as np
import shapely
from shapely.geometry import LineString, Polygon, box
from shapely.ops import substring

from osm_area import _rings
from tin_record import heights, level_heights


def shapes(rows):
    return shapely.union_all([Polygon(r[0], r[1:]).buffer(0) for r in rows])


def landing(road, half, pad_height, ground):
    """Find the first two successive metre sections that meet the upper road across its width."""
    distances = np.arange(0, min(16, road.length - 1), 1.0)
    if len(distances) < 3:
        return None
    xy = shapely.get_coordinates(shapely.line_interpolate_point(road, distances))
    tangent = shapely.get_coordinates(shapely.line_interpolate_point(road, distances + 0.25)) - xy
    tangent /= np.linalg.norm(tangent, axis=1)[:, None]
    normals = np.column_stack((-tangent[:, 1], tangent[:, 0]))
    points = xy[:, None, :] + normals[:, None, :] * (half * np.linspace(-0.9, 0.9, 5))[None, :, None]
    zs = ground(points.reshape(-1, 2)).reshape(-1, 5)
    # A short fall to another floor, followed by a return to the deck's height.
    if not np.isfinite(zs).all() or pad_height - zs[:3, 2].min() < 2:
        return None
    meets = np.max(np.abs(zs - pad_height), axis=1) < 0.45
    for i in range(2, len(meets)):
        if meets[i - 1] and meets[i]:
            return float(distances[i]), float(np.median(zs[i]))
    return None


def fit_tile(tile, terrain, directory):
    """Return graph spans and extend existing deck polygons. Ground and level rasters stay intact."""
    pads = [(shapes(t["polys"]), t["h"]) for t in tile.get("terraces", []) if "h" in t]
    if not pads:
        return {}
    bridges = defaultdict(list)
    for e in tile["drive"]:
        if e.get("bridge") and (e.get("level") or 0) > 0 and not e.get("levels"):
            for node, pts in ((e["u"], e["pts"]), (e["v"], e["pts"][::-1])):
                bridges[node].append((e["level"], LineString(pts)))
    if not bridges:
        return {}
    k = f"{tile['i']}_{tile['j']}"
    raw = heights(directory, k)
    if not raw:
        return {}
    n = terrain["n"]
    grid = np.frombuffer(raw, "<u2", n * n).reshape(n, n)
    origin = np.asarray(tile["box"][:2])

    def interpolate(values, points, missing=False):
        uv = np.clip((points - origin) / terrain["step"], 0, n - 1.000001)
        i, j = uv.astype(int).T
        a, b = (uv - uv.astype(int)).T
        corners = np.array([values[j, i], values[j, i + 1], values[j + 1, i], values[j + 1, i + 1]])
        weights = np.array([(1 - b) * (1 - a), (1 - b) * a, b * (1 - a), b * a])
        if missing:
            weights *= corners != 0
        total = weights.sum(axis=0)
        return np.divide((weights * corners).sum(axis=0), total, out=np.full(len(points), np.nan), where=total > 0)

    def ground(points):
        z = 100 + interpolate(grid, points) * terrain.get("unit", 0.1)
        for poly, h in pads:
            z[shapely.contains_xy(poly, *points.T)] = h
        return z

    decks = {s["level"]: s for s in tile.get("structures", []) if s["kind"] == "bridge"}
    payload = level_heights(directory, k)
    if not payload:
        return {}
    grids = np.frombuffer(payload, "<u2").reshape(len(tile["structures"]), n, n)
    by_level = {s["level"]: g for s, g in zip(tile["structures"], grids)}
    ground_roads = [
        (LineString(e["pts"]), e["width"] / 2, {e["u"], e["v"]})
        for e in tile["drive"]
        if not any(e.get(k) for k in ("bridge", "tunnel", "level", "levels"))
    ]
    changes, additions = {}, defaultdict(list)
    for e in tile["drive"]:
        if any(e.get(key) for key in ("level", "levels", "bridge", "tunnel")):
            continue
        ends = []
        for reverse, node in enumerate((e["u"], e["v"])):
            if node not in bridges:
                continue
            road = LineString(e["pts"][::-1] if reverse else e["pts"])
            at = road.interpolate(0)
            half = e["width"] / 2
            for level, bridge in bridges[node]:
                if level not in decks or bridge.length < 3 or at.distance(bridge.interpolate(0)) > 0.1:
                    continue
                # The joined lines must continue through the node with little turn.
                if road.interpolate(3).distance(bridge.interpolate(3)) < 5.8:
                    continue
                nearby = [h for pad, h in pads if pad.distance(at) < half]
                if not nearby or max(nearby) - min(nearby) > 0.45:
                    continue
                # Keep the complete landing and graph transition together in one tile.
                if not box(*tile["box"]).covers(substring(road, 0, 16).buffer(half + 1)):
                    continue
                result = landing(road, half, nearby[0], ground)
                if not result:
                    continue
                length, height = result
                tip = substring(road, 0, length)
                inside = bridge.interpolate(1)
                deck_height = 100 + 0.01 * interpolate(by_level[level], np.array(inside.coords), missing=True)[0]
                if not np.isfinite(deck_height) or abs(deck_height - nearby[0]) > 0.45:
                    continue
                line = LineString([inside.coords[0], *tip.coords])
                deck = decks[level]
                shape = line.buffer(half + 0.4, cap_style="flat")
                if not shape.intersects(shapes(deck["polys"])):
                    continue
                # A bridge lattice has a margin beyond the visible deck. Only
                # expose it where it already carries the approaching carriageway.
                samples = shapely.get_coordinates(shapely.segmentize(shape.exterior, 1))
                samples = np.vstack([samples, shapely.get_coordinates(shapely.segmentize(line, 1))])
                surface = 100 + 0.01 * interpolate(by_level[level], samples, missing=True)
                if np.any(np.abs(surface - height) > 0.45):
                    continue
                # The cut in the abutment protects another road underneath.
                # Check its elevation independently on its own centreline.
                lower = False
                for other, width, nodes in ground_roads:
                    if node in nodes or other.distance(shape) > width:
                        continue
                    crossing = other.interpolate(other.project(at))
                    if ground(np.array(crossing.coords))[0] < deck_height - 3:
                        lower = True
                        break
                if not lower:
                    continue
                additions[level].append(shape)
                # At the lip a lattice cell can have an empty corner. Keep
                # every finite deck sample and supply only the missing ones.
                ramp = {
                    "fallback": True,
                    "w": 2 * half + 1,
                    "pts": [
                        [
                            x,
                            y,
                            round(
                                deck_height
                                + (height - deck_height) * line.project(shapely.Point(x, y)) / line.length,
                                2,
                            ),
                        ]
                        for x, y in line.coords
                    ],
                }
                if ramp not in deck.setdefault("ramps", []):
                    deck["ramps"].append(ramp)
                ends.append((reverse, length, level))
                break
        if ends:
            changes[e["id"]] = [(e["pts"][-1 if reverse else 0], length, level) for reverse, length, level in ends]
    for level, strips in additions.items():
        deck = decks[level]
        union = shapely.union_all([shapes(deck["polys"]), *strips], grid_size=0.01)
        deck["polys"] = [_rings(p, 0) for p in shapely.get_parts(union) if p.geom_type == "Polygon"]
    return changes


def apply_spans(edges, joins):
    """Tile copies of an edge can start at different distances from its join."""
    for edge in edges:
        if edge["id"] not in joins or edge.get("levels") or edge.get("level"):
            continue
        length = LineString(edge["pts"]).length
        spans = [[0, 0]]
        for at, reach, level in joins[edge["id"]]:
            if at in (edge["pts"][0], edge["pts"][-1]) and length <= reach:
                edge["level"] = level
                break
            if at == edge["pts"][0] and length > reach:
                spans[0][1] = level
                spans.append([round(reach, 2), 0])
            elif at == edge["pts"][-1] and length > reach:
                spans.append([round(length - reach, 2), level])
        if len(spans) > 1 and not edge.get("level"):
            edge["levels"] = sorted(spans)


def collect(streets_chunk, terrain, on_levels, bounds, directory, join_shapes, join_spans):
    for key, street_tile in streets_chunk["tiles"].items():
        terraces = terrain.get("terraces", {}).get(key, [])
        if not any("h" in pad for pad in terraces):
            continue
        i, j = map(int, key.split("_"))
        structures_here = [
            dict(s, ramps=list(s["ramps"])) if s.get("ramps") else dict(s) for s in terrain["tiles"].get(key, [])
        ]
        tile = dict(
            i=i,
            j=j,
            box=bounds(i, j),
            terraces=terraces,
            structures=structures_here,
            drive=[dict(e) for e in street_tile["drive"]],
        )
        for e in tile["drive"]:
            if e.get("bridge"):
                e["level"] = on_levels.edge(e)
                e["levels"] = on_levels.stretches(e)
            elif cut := on_levels.over_cutting(e):
                e["levels"] = cut
        spans = fit_tile(tile, terrain["index"], directory)
        if spans:
            join_shapes[key] = structures_here
            for ident, ends in spans.items():
                join_spans.setdefault(ident, []).extend(
                    end for end in ends if end not in join_spans.get(ident, [])
                )
