"""List the entries of pipeline/.cache that no current pipeline step would read.

    python3 cache_stale.py            # a dry run: lists them with sizes, deletes nothing
    python3 cache_stale.py --cache DIR   # another cache folder (default: .cache beside this file)
    python3 cache_stale.py --trash    # moves them to the Trash with `trash` (asks nothing)

Only what the steps' paths and keys make certain is listed (see the rules below); a cache
that is merely old, or large, is not. It reads layers/<area>/meta.json for each area's
grid and local projection, so run it where the layers are. Add a rule when a step starts
keeping something new, or stops reading something.
"""

import json
import subprocess
import sys
import zlib
from pathlib import Path

CACHE = Path(sys.argv[sys.argv.index("--cache") + 1] if "--cache" in sys.argv else Path(__file__).parent / ".cache").resolve()
# Image folders under cover/img that ground_cover.export() fills (rgb, cir, dsm) and the IPR surface model.
COVER_IMG = {"rgb", "cir", "dsm", "dsm_ipr", "dsm_1m_wide"}
OSM_NAME = __import__("re").compile(r"^(?P<area>[a-z]+)_(?P<ci>\d+)_(?P<cj>\d+)\.(osm|parsed\.pkl|osm\.source\.json)$")


def size(path: Path) -> int:
    if path.is_file() or path.is_symlink():
        return path.lstat().st_size
    return sum(p.lstat().st_size for p in path.rglob("*") if p.is_file() or p.is_symlink())


def areas() -> dict:
    out = {}
    for meta in sorted((CACHE / "layers").glob("*/meta.json")):
        m = json.loads(meta.read_text())
        out[m["area"]] = m
    return out


def stale(known: dict):
    for p in sorted(CACHE.glob("previous-map-*")):
        yield p, "an earlier map kept as a backup; no step reads it"
    for p in sorted(CACHE.glob("*.log")) + sorted((CACHE / "cover").glob("*.log")):
        yield p, "a build log"
    test = CACHE / "cover" / "dtmp_test.geojson"
    if test.exists():
        yield test, "a test file"
    for p in sorted((CACHE / "cover" / "img").glob("*")):
        if p.name not in COVER_IMG:
            yield p, "an image set from a classifier experiment; ground_cover reads only " + ", ".join(sorted(COVER_IMG))
    for sub in ("results", "tiles"):
        for p in sorted((CACHE / "cover" / sub).glob("*")):
            if p.name not in known:
                yield p, f"ground cover of an area that has no layers ({', '.join(known)})"
    for p in sorted((CACHE / "osm").glob("*")):
        m = OSM_NAME.match(p.name)
        if not m:
            continue
        meta = known.get(m["area"])
        if not meta:
            yield p, f"OSM chunk of area {m['area']}, which has no layers"
            continue
        C = meta["chunk_tiles"]
        if int(m["ci"]) >= -(-meta["cols"] // C) or int(m["cj"]) >= -(-meta["rows"] // C):
            yield p, f"OSM chunk outside the {m['area']} grid"
    crcs = {f"{zlib.crc32(m['crs'].encode()):08x}" for m in known.values()}
    for p in sorted((CACHE / "ipr" / "parsed").glob("*.pkl")) + sorted((CACHE / "ipr" / "mosty").glob("parsed*")):
        if p.parent.name == "parsed" and p.stem.rsplit("_", 1)[-1] not in crcs:
            yield p, "parsed IPR sheet for a projection no area has now"
    for p in sorted(CACHE.rglob("*.tmp")) + sorted(CACHE.rglob("*.partial")):
        yield p, "an unfinished write"


def main():
    known = areas()
    rows = [(p, size(p), why) for p, why in stale(known)]
    total = 0
    for p, n, why in rows:
        total += n
        print(f"{n / 1e6:10.1f} MB  {p.relative_to(CACHE)}  ({why})")
    print(f"{len(rows)} entries, {total / 1e9:.2f} GB (the whole cache is not measured: it holds millions of files); areas with layers: {', '.join(known) or 'none'}")
    if "--trash" in sys.argv:
        for p, _, _ in rows:
            subprocess.run(["trash", str(p)], check=True)
        print("moved to the Trash")
    elif rows:
        print("Dry run: nothing was moved. Add --trash to move them to the Trash.")


if __name__ == "__main__":
    main()
