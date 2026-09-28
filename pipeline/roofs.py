"""What a roof is covered with: "tiles" (red), "slate" (grey) or "copper" (green), from
OSM's roof:material and roof:colour, with corrections for landmarks OSM gets wrong or
leaves out. None means OSM doesn't say (or says something flat, like concrete or
gravel) and the usual rules apply: pitched roofs in Prague are nearly all red tiles.

Raw colours are never used as they are; every roof is drawn in one of the three
covers so the city keeps one look.
"""

import colorsys

TILES_COLOURS = {"red", "firebrick", "brown", "maroon", "darkred", "rust", "orange", "orangered", "indianred",
                 "sienna", "tomato", "coral", "salmon", "terracotta", "brick", "chocolate", "saddlebrown"}
SLATE_COLOURS = {"gray", "grey", "darkgray", "darkgrey", "dimgray", "dimgrey", "slategray", "slategrey",
                 "darkslategray", "darkslategrey", "lightgray", "lightgrey", "silver", "black", "blue", "navy",
                 "darkblue", "steelblue", "anthracite"}
COPPER_COLOURS = {"copper", "green", "palegreen", "lightgreen", "darkgreen", "seagreen", "mediumseagreen",
                  "darkseagreen", "teal", "turquoise", "aquamarine", "mediumaquamarine", "cadetblue"}
TILE_MATERIALS = {"roof_tiles", "tiles", "tile", "clay", "ceramic"}
SLATE_MATERIALS = {"slate", "shale", "eternit"}
METAL_MATERIALS = {"metal", "tin", "zinc", "steel", "aluminium", "sheet_metal"}

# OSM buildings (and building parts) whose roof we know better than their tags say.
OVERRIDES = {
    "relation/15317899": "slate",   # St Vitus: grey roofs (its parts add the copper)
    "relation/295830": "slate",     # Arcibiskupský palác
    "relation/15317893": "slate",   # Schwarzenberský palác
    "way/30123527": "copper",       # Rudolfinum (tagged gray)
    "way/30825119": "copper",       # Uměleckoprůmyslové museum
    "relation/49848": "copper",     # Filozofická fakulta, nám. Jana Palacha
}

# Parts of buildings that OSM draws as one, in WGS84: the roofs inside take this cover.
# IPR models the New Royal Palace of the Castle as one building too, so these go by
# roof triangle.
REGIONS = [
    ("slate", "Castle: the south wing and the south side of the first courtyard",
     [(14.39840, 50.08950), (14.39880, 50.08930), (14.40055, 50.08960), (14.40060, 50.08985),
      (14.39905, 50.08986), (14.39870, 50.08975)]),
    ("slate", "Castle: the wing from the south wing up to the Old Royal Palace",
     [(14.40030, 50.08965), (14.40075, 50.08960), (14.40170, 50.09080), (14.40140, 50.09100)]),
    ("slate", "Castle: the north wing past the Picture Gallery, up to the Powder Bridge",
     [(14.39955, 50.09090), (14.40050, 50.09112), (14.40050, 50.09125), (14.39955, 50.09115)]),  # not the Mihulka tower
]


def _hex(v: str):
    v = v.strip().lstrip("#")
    if len(v) == 3:
        v = "".join(c * 2 for c in v)
    try:
        return tuple(int(v[i:i + 2], 16) / 255 for i in (0, 2, 4)) if len(v) == 6 else None
    except ValueError:
        return None


def from_colour(colour) -> str | None:
    if not colour:
        return None
    c = str(colour).strip().lower()
    if c in TILES_COLOURS:
        return "tiles"
    if c in SLATE_COLOURS:
        return "slate"
    if c in COPPER_COLOURS:
        return "copper"
    rgb = _hex(c)
    if rgb is None:
        return None  # white, sand, gold and the like: nothing that fits
    h, s, v = colorsys.rgb_to_hsv(*rgb)
    h *= 360
    if v < 0.25 or (s < 0.12 and v < 0.85):
        return "slate"
    if s < 0.12:
        return None
    if h <= 45 or h >= 330:
        return "tiles"
    if 70 <= h < 200:
        return "copper"
    if 200 <= h < 260 and s < 0.4:
        return "slate"
    return None


def cover(material, colour) -> str | None:
    """The cover a roof's OSM tags describe, or None."""
    m = str(material).strip().lower() if material else ""
    if m in SLATE_MATERIALS:
        return "slate"
    if m == "copper":
        return "copper"
    by_colour = from_colour(colour)
    if m in TILE_MATERIALS:
        return by_colour or "tiles"  # grey concrete tiles are tagged roof_tiles + gray
    if m in METAL_MATERIALS:
        return by_colour or "slate"
    if m:
        return None  # glass, concrete, tar paper, gravel, stone: flat roofs
    return by_colour
