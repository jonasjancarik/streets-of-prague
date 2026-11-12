"""Download the map's inputs that the build steps don't fetch on their own.

    uv run fetch_sources.py               # everything missing or out of date
    uv run fetch_sources.py --refresh-osm # also replace the OSM extract with today's

- OpenStreetMap: Geofabrik's extract of the Czech Republic (about 950 MB) into
  .cache/osm/czech-republic-latest.osm.pbf. Kept once it's there (a new extract
  makes every area's streets and buildings be worked out again); --refresh-osm
  fetches today's.
- IPR's digital technical map (DTM kraje, ZPS), this month's: set 2, the surfaces
  (about 130 MB, into .cache/dtm/ZPS_OPL/; build_tiles.py fetches it too), and set 3,
  the lines with their surveyed heights (kerbs, walls, fences and railings; about
  270 MB, into .cache/dtm/ZPS_KR/). Without set 3 the terrain has no quay or
  retaining walls and the streets aren't levelled from their kerbs.
- TSK's paid-parking counts (build_parking.py): the newest month of every district,
  from the copy kept in github.com/jonasjancarik/parkovani-praha (TSK's own server
  needs a login), into .cache/parking/.

Everything else (IPR's buildings, terrain, aerial photos and photo mesh, PID's
timetables, the bike feeds) is downloaded by the step that needs it.
"""

import argparse
import hashlib
import json
import shutil
import zipfile
from pathlib import Path

import requests

import dtm
from build_parking import NAME, latest

CACHE = Path(__file__).parent / ".cache"
PBF = CACHE / "osm" / "czech-republic-latest.osm.pbf"
GEOFABRIK = "https://download.geofabrik.de/europe/czech-republic-latest.osm.pbf"
LINES_LIST = "https://geoportalpraha.cz/api/get-dtm-download-metadata?code=03"
PARKING = CACHE / "parking"
PARKING_REPO = "jonasjancarik/parkovani-praha"
PARKING_DIR = "data/downloaded/parked_cars/"
HEADERS = {"User-Agent": "streets-of-prague pipeline"}


def _download(url, path, size=None):
    """Stream url into path through a .part file, so an interrupted download never
    looks finished."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".part")
    with requests.get(url, headers=HEADERS, stream=True, timeout=300) as r:
        r.raise_for_status()
        total = size or int(r.headers.get("content-length") or 0)
        done, shown = 0, -1
        with tmp.open("wb") as f:
            for chunk in r.iter_content(1 << 20):
                f.write(chunk)
                done += len(chunk)
                if total > 50e6 and (pct := done * 100 // total) // 10 != shown:
                    shown = pct // 10
                    print(f"  {path.name}: {pct}% of {total / 1e6:.0f} MB", flush=True)
    tmp.replace(path)


def osm(refresh):
    if PBF.exists() and not refresh:
        print(f"osm: {PBF.name} is here ({PBF.stat().st_size / 1e6:.0f} MB); --refresh-osm for a newer one")
        return
    print("osm: downloading Geofabrik's Czech Republic extract (about 950 MB)", flush=True)
    new = PBF.with_name(PBF.name + ".new")
    _download(GEOFABRIK, new)
    expected = requests.get(GEOFABRIK + ".md5", headers=HEADERS, timeout=60).text.split()[0]
    md5 = hashlib.md5()
    with new.open("rb") as f:
        while block := f.read(1 << 24):
            md5.update(block)
    if md5.hexdigest() != expected:
        new.unlink()
        raise SystemExit("osm: the extract's checksum doesn't match Geofabrik's; try again")
    new.replace(PBF)


def technical_map():
    try:
        dtm.download()  # set 2, as build_tiles.py does
    except OSError as e:
        print(f"dtm: couldn't reach IPR for set 2 ({e})")
    folder = dtm.CACHE / "ZPS_KR"  # where dtm_heights.py and dtm_walls.py read set 3
    folder.mkdir(parents=True, exist_ok=True)
    try:
        listing = json.loads(dtm._get(LINES_LIST))
    except OSError as e:
        have = len(list(folder.glob("*.zip")))
        print(f"dtm: couldn't reach IPR for set 3 ({e}); {have} districts here")
        return
    keep = set()
    for district in listing:
        for f in district["formats"]:
            if f["format"] != "GPKG" or f["kraj"] != "CZ010":
                continue
            path = folder / f["soubor_nazev"]
            keep.add(path)
            if path.exists() and path.stat().st_size == int(f["velikost"]):
                continue
            print(f"dtm: downloading {district['obec']}, set 3 ({int(f['velikost']) / 1e6:.1f} MB)", flush=True)
            _download(dtm.FILE + f["kod_stazeni"], path)
            with zipfile.ZipFile(path) as z:
                if z.testzip() is not None:
                    path.unlink()
                    raise SystemExit(f"dtm: {path.name} came broken; run again")
    for old in set(folder.glob("*.zip")) - keep:
        old.unlink()
    print(f"dtm: set 2 {len(list(dtm.PACKAGES.glob('*.zip')))} districts, set 3 {len(keep)} districts")


def parking():
    tree = requests.get(f"https://api.github.com/repos/{PARKING_REPO}/git/trees/main?recursive=1",
                        headers=HEADERS, timeout=120)
    tree.raise_for_status()
    files = [Path(e["path"]) for e in tree.json()["tree"]
             if e["path"].startswith(PARKING_DIR) and NAME.match(Path(e["path"]).name)]
    wanted = [f for _, (_, v) in latest(files).items() for f in [v["D"], *v["N"]]]
    PARKING.mkdir(parents=True, exist_ok=True)
    got = 0
    for f in wanted:
        path = PARKING / f.name
        if path.exists():
            continue
        _download(f"https://raw.githubusercontent.com/{PARKING_REPO}/main/{f.as_posix()}", path)
        got += 1
    keep = {f.name for f in wanted}
    for old in PARKING.glob("*.json"):
        if old.name not in keep:
            old.unlink()
    print(f"parking: {len(wanted)} files for {len(latest(files))} districts ({got} new) in {PARKING}")


def tools():
    """What the later steps need from outside Python."""
    missing = []
    if not shutil.which("osmium"):
        missing.append("osmium (brew install osmium-tool, or apt install osmium-tool): cuts the areas out of the OSM extract")
    if not (shutil.which("blender") or Path("/Applications/Blender.app").exists()):
        missing.append("Blender (blender.org, on the PATH or $BLENDER): bakes the landmarks; build_map.sh --quick skips them")
    for m in missing:
        print(f"missing: {m}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--refresh-osm", action="store_true", help="replace the OSM extract with today's")
    ap.add_argument("--skip-osm", action="store_true", help="leave the OSM extract out (the steps then ask Overpass)")
    args = ap.parse_args()
    if not args.skip_osm:
        osm(args.refresh_osm)
    technical_map()
    parking()
    tools()
