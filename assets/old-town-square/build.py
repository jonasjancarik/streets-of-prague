"""Rebuild the Old Town Square GLBs from the Prague survey shells and local photo panels."""

import argparse
from PIL import Image
from craft import Atlas, Building, HERE, ROOT, NAMES, survey
import churches
import column
import hall

ASSETS = {
    "radnice": (
        hall.PANELS,
        hall.build,
        "Dietmar Rabich, Yair Haklai, Jorge Láscar, PatrikPaprika, Sajjadmrt",
    ),
    "tyn": (churches.TYN_PANELS, churches.tyn, "Dennis Jarvis"),
    "mikulas": (churches.NICHOLAS_PANELS, churches.nicholas, "Petr Šmerkl, Wikipedia"),
    "sloup": (column.PANELS, column.build, "Gampe, Xyzabec"),
}


def build(name):
    panels, sculpt, photographers = ASSETS[name]
    images = {key: Image.open(HERE / f"{key}.webp").convert("RGB") for key in panels}
    if name == "sloup":
        mesh = Building(Atlas(1024, images))
        sculpt(mesh)
    else:
        triangles, images["survey"] = survey(name)
        mesh = Building(Atlas(2048, images))
        sculpt(mesh, triangles)
    mesh.save(
        ROOT / f"public/old-town-{name}.glb",
        NAMES[name],
        f"CC BY-SA 4.0. Survey: IPR Praha (CC BY 4.0). Adapted photographs: {photographers}. "
        "https://github.com/jonasjancarik/streets-of-prague/blob/main/assets/SOURCES.md#old-town-square",
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("names", nargs="*", help="radnice, tyn, mikulas or sloup (default: all)")
    for name in parser.parse_args().names or ASSETS:
        build(name)
