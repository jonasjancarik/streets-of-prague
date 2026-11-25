"""Build Fantova budova from its Prague survey shell and the Wilsonova elevation.

Run the landmark survey bake for praha/fantova first, then run this script with
the pipeline Python. Coordinates are metres: +X along the façade to the south,
+Y towards the platforms, Z above the entrance pavement.
"""

import math
import sys
from pathlib import Path

import numpy as np
import shapely
from PIL import Image
from shapely.geometry import Polygon

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(ROOT / "assets/old-town-square"))
from craft import Atlas, Building, at, band, drum, lathe, rect, rod, shell, survey
import pavilions

FRAME = (-2169.00922697, 2617.41380864, 29.9, -114.89920052)
FRONT = -13.32
PANELS = ("gable", "clock-shaft", "rotunda", "belt", "drum-window", "wing-bay")


def facade(m):
    # Coordinates on the frontal photograph, reduced to 700 px wide. The
    # surveyed 30.4 m between the tower axes fixes its scale on the street.
    def point(p, y):
        x, v = p
        return [(x - 347.5) * 0.0712, y, (605 - v) * 0.0718]

    def photo(points, y):
        m.face(
            [point(p, y) for p in points], "gable", [((x - 174) / 350, (v - 160) / 445) for x, v in points]
        )

    # The stepped attic and the arms of the city between the raised finials.
    skyline = [
        (174, 265),
        (204, 265),
        (226, 260),
        (227, 246),
        (232, 244),
        (234, 256),
        (269, 240),
        (271, 225),
        (277, 221),
        (279, 235),
        (320, 214),
        (320, 168),
        (326, 166),
        (328, 179),
        (350, 182),
        (369, 178),
        (370, 167),
        (376, 166),
        (377, 214),
        (416, 235),
        (418, 222),
        (424, 225),
        (426, 240),
        (463, 255),
        (464, 244),
        (470, 246),
        (471, 261),
        (496, 265),
        (524, 265),
    ]
    outline = [*skyline, (524, 605), (174, 605)]
    # Recess the fanlight behind its stone reveal. The bottom is behind the canopy.
    arc = [(350 + 119 * math.cos(a), 450 - 107 * math.sin(a)) for a in np.linspace(math.pi, 0, 37)]
    window = [*arc, (469, 493), (231, 493)]
    shape = Polygon(outline, [window])
    for tri in shapely.constrained_delaunay_triangles(shape).geoms:
        pts = list(tri.exterior.coords)[:3]
        # Clockwise in pixel coordinates gives an outward normal after flipping the vertical axis.
        photo(pts if not tri.exterior.is_ccw else pts[::-1], FRONT)
    for a, b in zip(skyline, skyline[1:]):
        m.face(
            [point(a, FRONT), point(b, FRONT), point(b, FRONT + 0.55), point(a, FRONT + 0.55)], "sandstone"
        )
    # A fan of triangles works on the convex glazed opening.
    photo(list(reversed(window)), FRONT + 0.38)
    for a, b in zip(window, window[1:] + window[:1]):
        m.face([point(a, FRONT + 0.38), point(b, FRONT + 0.38), point(b, FRONT), point(a, FRONT)], "carving")
    for x in (237, 273, 319, 373, 421, 463):
        spring = 450 - 107 * math.sqrt(max(0, 1 - ((x - 350) / 119) ** 2))
        rod(m, point((x, 493), FRONT + 0.28), point((x, spring), FRONT + 0.28), 0.065, "seam", 6)

    # Projecting stone ribs on the red attic, including the taller centre pair.
    for x, top in [(229, 245), (274, 224), (323, 168), (373, 168), (421, 224), (467, 245)]:
        bottom = 295 if 310 < x < 390 else 312
        a, b = point((x, bottom), FRONT), point((x, top), FRONT)
        m.box(a[0] - 0.09, FRONT - 0.19, a[0] + 0.09, FRONT + 0.02, a[2], b[2], "carving")


def clock_tower(m, x):
    y, front = -9.96, FRONT - 0.08
    ring = rect(x, y, 6.12, 6.5)
    drum(m, ring, -0.25, 24.12, "plaster")

    # Clock, sculpted surrounds and paired ground-floor openings from the
    # unobstructed north tower. The other tower has the same frontage.
    def elevation(a, b, uv=None):
        m.face([at(a, -0.25), at(b, -0.25), at(b, 24.12), at(a, 24.12)], "clock-shaft", uv)

    elevation([x - 3.06, front], [x + 3.06, front])
    for sign in (-1, 1):
        xx = x + sign * 3.08
        a, b = [xx, y - 3.26], [xx, y + 3.26]
        elevation(*((a, b) if sign == 1 else (b, a)))
    band(m, x, front, 6.50, 0.80, 6.94, 0.32, "sandstone")
    band(m, x, front, 6.20, 0.86, 12.55, 0.36, "carving")
    for sx in (-2.55, -1.58, 1.58, 2.55):
        rod(m, (x + sx, front - 0.40, 12.90), (x + sx, front - 0.40, 13.55), 0.035, "iron")
    rod(m, (x - 2.75, front - 0.40, 13.55), (x + 2.75, front - 0.40, 13.55), 0.042, "seam")
    lathe(m, x, y, [(23.75, 3.05), (24.05, 3.32), (24.40, 3.4), (24.68, 3.18)], "carving", 32)
    lathe(m, x, y, [(24.66, 3.06), (26.9, 2.96)], "drum-window", 12)
    lathe(m, x, y, [(26.85, 2.95), (27.12, 3.1), (27.40, 3.26)], "carving", 32)
    # The upper rotunda has tall recessed windows between carved piers,
    # then a garland drum and a ribbed, glazed lantern.
    for i in range(12):
        a = np.array([math.cos(i * math.tau / 12), math.sin(i * math.tau / 12)])
        b = np.array([math.cos((i + 1) * math.tau / 12), math.sin((i + 1) * math.tau / 12)])
        centre = np.array([x, y])
        m.wall(centre + 2.46 * a, centre + 2.46 * b, 27.4, 32.85, "rotunda")
        pier = centre + 2.60 * a
        lathe(
            m,
            *pier,
            [(27.38, 0.25), (27.65, 0.29), (28.0, 0.18), (31.8, 0.16), (32.2, 0.31), (32.7, 0.30)],
            "carving",
            8,
        )
    lathe(m, x, y, [(32.64, 2.65), (32.9, 3.06), (33.65, 3.22), (34.35, 2.86)], "belt", 36)
    lathe(m, x, y, [(34.32, 2.82), (34.54, 2.88), (34.72, 2.55)], "sandstone", 32)
    dome = [(34.71, 2.48), (35.65, 2.45), (36.42, 2.12), (37.08, 1.48), (37.36, 0.65), (37.42, 0.12)]
    lathe(m, x, y, dome, "lantern", 24)
    for z, r in dome[:-1]:
        lathe(m, x, y, [(z, r + 0.045), (z + 0.075, r + 0.045)], "iron", 24)
    for angle in np.arange(12) * math.tau / 12:
        ribs = [(x + r * math.cos(angle), y + r * math.sin(angle), z) for z, r in dome]
        for a, b in zip(ribs, ribs[1:]):
            rod(m, a, b, 0.038, "iron", 5)
    lathe(m, x, y, [(37.42, 0.12), (37.6, 0.14), (39.85, 0.035), (40.1, 0)], "iron", 8)


def canopy(m):
    back, lip = -13.4, -17.5

    def z(y):
        return 6.65 + (back - y) * 0.19

    # Glazed panels span five door bays. Both sides of the roof are visible.
    for i in range(10):
        a, b = -9.9 + i * 1.98, -9.9 + (i + 1) * 1.98
        pts = [(a, back, z(back)), (a, lip, z(lip)), (b, lip, z(lip)), (b, back, z(back))]
        m.face(pts, "canopy")
        m.face(pts[::-1], "canopy")
    for x in np.linspace(-9.9, 9.9, 21):
        rod(m, (x, back, z(back) + 0.04), (x, lip, z(lip) + 0.04), 0.052, "painted-iron")
    for y in np.linspace(back, lip, 6):
        rod(m, (-9.95, y, z(y) + 0.055), (9.95, y, z(y) + 0.055), 0.048, "painted-iron")
    for x in np.linspace(-9.9, 9.9, 6):
        rod(m, (x, back, 4.85), (x, lip, z(lip) - 0.03), 0.095, "painted-iron", 8)
        rod(m, (x, back, 6.4), (x, lip, z(lip) - 0.03), 0.075, "painted-iron", 8)
        for d in (1.1, 2.1, 3.1):
            y = back - d
            rod(m, (x, y, 4.85 + d * 0.60), (x, y, z(y) - 0.09), 0.046, "painted-iron")
    rod(m, (-10, lip, 7.42), (10, lip, 7.42), 0.12, "painted-iron", 8)


def wings(m):
    # The two 55 m galleries taper slightly in plan. Each bay has an arched
    # ground-floor window, rusticated surrounds and a smaller attic window.
    for x0, y0, x1, y1, rear0, rear1 in [
        (-73.43, -7.19, -18.13, -7.03, -1.02, -1.46),
        (18.40, -8.19, 73.55, -8.39, -1.66, -2.02),
    ]:
        for i in range(12):
            a, b = [(x0 + (x1 - x0) * u, y0 + (y1 - y0) * u - 0.065) for u in (i / 12, (i + 1) / 12)]
            c, d = [(x0 + (x1 - x0) * u, rear0 + (rear1 - rear0) * u - 0.10) for u in (i / 12, (i + 1) / 12)]
            m.face(
                [at(a, -0.15), at(b, -0.15), at(b, 7.32), at(a, 7.32)],
                "wing-bay",
                [(0, 1), (1, 1), (1, 0.42), (0, 0.42)],
            )
            m.face(
                [at(c, 7.20), at(d, 7.20), at(d, 12.30), at(c, 12.30)],
                "wing-bay",
                [(0, 0.42), (1, 0.42), (1, 0), (0, 0)],
            )
            band(m, a[0], a[1] - 0.07, 0.20, 0.24, -0.12, 6.95, "carving")
            for z, depth, l, r in [(7.0, 0.22, a, b), (11.9, 0.34, c, d)]:
                m.face(
                    [
                        at(l, z),
                        at(r, z),
                        at([r[0], r[1] - depth], z + 0.15),
                        at([l[0], l[1] - depth], z + 0.15),
                    ],
                    "sandstone",
                )
                m.face(
                    [
                        at([l[0], l[1] - depth], z + 0.15),
                        at([r[0], r[1] - depth], z + 0.15),
                        at(r, z + 0.27),
                        at(l, z + 0.27),
                    ],
                    "carving",
                )


def build():
    tris, texture = survey("fantova", FRAME)
    images = {key: Image.open(HERE / f"{key}.webp").convert("RGB") for key in PANELS}
    images.update({p.stem: Image.open(p).convert("RGB") for p in sorted((HERE / "panels").glob("*.webp"))})
    images.update(
        survey=texture,
        lantern=Image.new("RGB", (8, 8), (109, 137, 147)),
        canopy=Image.new("RGB", (8, 8), (130, 159, 150)),
        **{
            "painted-iron": Image.new("RGB", (8, 8), (51, 91, 75)),
            "chimney-brick": Image.new("RGB", (8, 8), (145, 82, 64)),
        },
    )
    m = Building(Atlas(2048, images))
    p = tris[:, :, :3]
    # The central roof and platform wall come from the survey. The galleries
    # stop at the inner walls of the two independently modelled end pavilions.
    front_wall = (np.abs(p[:, :, 0]).max(1) < 19.1) & (p[:, :, 1].max(1) < -12.4)
    towers = np.zeros(len(p), dtype=bool)
    for x in (-15.15, 15.35):
        towers |= (np.abs(p[:, :, 0] - x).max(1) < 3.8) & (np.abs(p[:, :, 1] + 9.96).max(1) < 3.8)
    shell(m, pavilions.gallery_triangles(tris[~(front_wall | towers)]), 100)
    facade(m)
    for x in (-15.15, 15.35):
        clock_tower(m, x)
    canopy(m)
    wings(m)
    for end in ("north", "south"):
        pavilions.pavilion(m, end)
    m.save(
        ROOT / "public/fantova.glb",
        "Fantova budova",
        "CC BY-SA 4.0. Survey: IPR Praha (CC BY). Adapted photographs: Lynx1211 (CC BY-SA 4.0), "
        "ŠJů (CC BY 4.0, CC BY-SA 3.0 and 4.0), Wikimedia Commons. "
        "https://github.com/jonasjancarik/streets-of-prague/blob/main/assets/SOURCES.md#fantova-budova",
        extent=112,
    )


if __name__ == "__main__":
    build()
