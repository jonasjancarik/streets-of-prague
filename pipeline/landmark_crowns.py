"""The two copper roofs of St Nicholas, Malá Strana, in the game's Y-up metres.

The city model ends both towers in pyramids. Horizontal sections through the
aerial survey retain the drum, onion profiles, lanterns and finials. Start on
the city model's own cut edges so the lower masonry stays closed.
"""
import numpy as np

TAU = 2 * np.pi


def section(triangles, height):
    cut = triangles[(triangles[:, :, 1].min(1) < height) & (triangles[:, :, 1].max(1) >= height)]
    segments = []
    for tri in cut:
        points = []
        for a, b in zip(tri, np.roll(tri, -1, axis=0)):
            if (a[1] < height) != (b[1] < height):
                p = a + (b - a) * ((height - a[1]) / (b[1] - a[1]))
                points.append(p[[0, 2]])
        if len(points) == 2:
            segments.append(points)
    return np.array(segments)


def outline(segments, centre, directions, angles, reach):
    """Outermost crossing of each ray. Interpolate narrow gaps in the survey."""
    def cross(a, b):
        return a[..., 0] * b[..., 1] - a[..., 1] * b[..., 0]

    start = segments[:, 0] - centre
    edge = segments[:, 1] - segments[:, 0]
    det = cross(directions[:, None], edge)
    det[np.abs(det) < 1e-10] = np.nan
    radius = cross(start, edge) / det
    along = cross(start, directions[:, None]) / det
    hits = (radius > 0) & (radius <= reach) & (along >= -1e-6) & (along <= 1 + 1e-6)
    radii = np.where(hits, radius, 0).max(1)
    known = radii > 0
    if known.sum() < .6 * len(angles):
        return None
    radii = np.interp(angles, angles[known], radii[known], period=TAU)
    return centre + radii[:, None] * directions


def simplify(rings, tolerance=.23):
    """Skip heights along a straight slope; keep ledges and changes of curvature."""
    def split(a, b):
        if b == a + 1:
            return [a]
        inner = rings[a + 1:b]
        fraction = (inner[:, 0, 1] - rings[a, 0, 1]) / (rings[b, 0, 1] - rings[a, 0, 1])
        chord = rings[a] + fraction[:, None, None] * (rings[b] - rings[a])
        error = np.linalg.norm(inner - chord, axis=2).max(axis=1)
        at = int(np.argmax(error))
        if error[at] <= tolerance:
            return [a]
        midpoint = a + 1 + at
        return split(a, midpoint) + split(midpoint, b)

    return rings[split(0, len(rings) - 1) + [len(rings) - 1]]


def join_rings(lower, lower_angles, upper, upper_angles):
    """Stitch rings with different vertex counts in their order around the roof."""
    i = j = 0
    n, m = len(lower), len(upper)
    while i < n or j < m:
        a = lower_angles[i + 1] if i + 1 < n else TAU if i < n else np.inf
        b = upper_angles[j + 1] if j + 1 < m else TAU if j < m else np.inf
        if a < b:
            yield [lower[i % n], upper[j % m], lower[(i + 1) % n]]
            i += 1
        else:
            yield [lower[i % n], upper[j % m], upper[(j + 1) % m]]
            j += 1


def below(tri, height):
    polygon = []
    for a, b in zip(tri, np.roll(tri, -1, axis=0)):
        if a[1] < height:
            polygon.append(a)
        if (a[1] < height) != (b[1] < height):
            polygon.append(a + (b - a) * ((height - a[1]) / (b[1] - a[1])))
    return [[polygon[0], polygon[i], polygon[i + 1]] for i in range(1, len(polygon) - 1)]


def ring(xz, y):
    return np.column_stack((xz[:, 0], np.full(len(xz), y), xz[:, 1]))


def st_nicholas(clean, survey):
    vertices = clean.reshape(-1, 3)
    dome = vertices[vertices[:, 1].argmax()]
    others = vertices[np.linalg.norm(vertices[:, [0, 2]] - dome[[0, 2]], axis=1) > 14]
    belfry = others[others[:, 1].argmax()]
    # Heights below the two tips in the original model place each join in the
    # straight drum below its cornice. The two search circles exclude one another.
    settings = [(dome, 22.80, 12.3, 24), (belfry, 18.80, 7.1, 20)]
    minimum = min(tip[1] - drop for tip, drop, _, _ in settings)
    for tip, drop, reach, sides in settings:
        centre = tip[[0, 2]]
        height = tip[1] - drop
        def roof(tris):
            return (tris[:, :, 1].max(1) > height) & (np.linalg.norm(tris.mean(1)[:, [0, 2]] - centre, axis=1) < reach)
        selected = roof(clean)
        low, high = clean[selected], survey[roof(survey)]
        base = section(low, height)
        if not len(base) or not len(high):
            raise ValueError("St Nicholas roof missing from the city model or survey")
        points = np.unique(base.reshape(-1, 2).round(5), axis=0)
        off = points - centre
        angle = np.arctan2(off[:, 1], off[:, 0])
        start = angle[np.linalg.norm(off, axis=1).argmax()]
        base_angles = (angle - start) % TAU
        order = base_angles.argsort()
        bottom = ring(points[order], height)
        angles = np.arange(sides) * TAU / sides
        directions = np.column_stack((np.cos(angles + start), np.sin(angles + start)))
        first = outline(base, centre, directions, angles, reach + 1)
        if first is None:
            raise ValueError("Open attachment ring on St Nicholas")
        sections = [ring(first, height)]
        peak = high.reshape(-1, 3)[high[:, :, 1].argmax()]
        for y in np.arange(height + .14, peak[1], .36):
            seg = section(high, y)
            if not len(seg):
                continue
            points = seg.reshape(-1, 2)
            # The gilded tip can lean away from the centre of the drum.
            at = (points.min(0) + points.max(0)) / 2
            skin = outline(seg, at, directions, angles, reach + 1)
            if skin is not None:
                sections.append(ring(skin, y))
        if len(sections) < 3:
            raise ValueError("Too few survey sections on St Nicholas")
        sections = simplify(np.asarray(sections))
        pieces = [p for triangle in low for p in below(triangle, height)]
        bottom_angles = base_angles[order]
        for upper in sections[1:]:
            pieces.extend(join_rings(bottom, bottom_angles, upper, angles))
            bottom, bottom_angles = upper, angles
        pieces.extend([p, peak, bottom[(i + 1) % sides]] for i, p in enumerate(bottom))
        clean = np.concatenate((clean[~selected], pieces))
    return clean, minimum
