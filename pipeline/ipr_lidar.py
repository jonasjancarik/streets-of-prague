"""Import and sample IPR Praha's 2023 bare-earth elevation raster (CC BY).

The ZIP contains numeric elevations in Bpv, on a 1 m EPSG:5514 grid. The
shaded-relief ImageServer listed alongside it serves a different product.
"""

import argparse
import hashlib
import json
import math
import os
import shutil
import tempfile
import zipfile
from pathlib import Path

import numpy as np
from pyproj import Transformer
from pyproj.aoi import AreaOfInterest
from pyproj.enums import TransformDirection

ITEM = "97d2c9c11aa9478cb21b469b8a4f820e"
URL = f"https://www.arcgis.com/sharing/rest/content/items/{ITEM}/data"
ARCHIVE_SHA256 = "d8ec644fd45d5a13a2ecf2d8418e3cf78bc8c21aaf6026f09f3838a8edabce9b"
SOURCE = {
    "title": "Digitální model terénu - rastr",
    "provider": "IPR Praha",
    "license": "CC BY",
    "catalogueRevision": "2023-07-15",
    "rasterExport": "2025-07-10",
    "item": ITEM,
    "url": URL,
    "crs": "EPSG:5514",
    "verticalDatum": "Bpv",
    "pixelMetres": 1,
}
CACHE = Path(__file__).parent / ".cache" / "ipr_lidar" / "2023"
CACHE_FORMAT = 1
HEIGHTS = "heights.npy"
PROVENANCE = "source.json"


def source_paths(directory):
    directory = Path(directory)
    return directory / HEIGHTS, directory / PROVENANCE


def world_origin(text):
    # A world file stores the centre of the upper-left pixel, with y decreasing
    # as the row number grows. The known product has no rotation or shear.
    dx, ry, rx, dy, x, y = map(float, text.split())
    if (dx, ry, rx, dy) != (1, 0, 0, -1) or not all(map(math.isfinite, (x, y))):
        raise ValueError("expected a north-up 1 m IPR elevation grid")
    return x, y


def decode(tiff, origin, path):
    import tifffile  # importer only; the map build reads the NumPy cache

    with tifffile.TiffFile(tiff) as src:
        page = src.pages[0]
        if len(page.shape) != 2 or min(page.shape) < 2 or page.dtype != np.dtype("float32"):
            raise ValueError("expected a single-band Float32 elevation TIFF")
        keys = page.geotiff_tags or {}
        x, y = origin
        if (keys.get("ProjectedCSTypeGeoKey") != 5514 or keys.get("GTRasterTypeGeoKey") != 1
                or keys.get("ModelPixelScale") != [1, 1, 0]
                or not np.allclose(keys.get("ModelTiepoint", [math.nan] * 6), [0, 0, 0, x - 0.5, y + 0.5, 0], rtol=0, atol=1e-8)):
            raise ValueError("GeoTIFF and world file disagree on the EPSG:5514 grid")
        # Parse the tag directly because tifffile can reject the decimal string
        # for -FLT_MAX even though it rounds to the valid Float32 sentinel.
        nodata = np.float32(float(page.tags["GDAL_NODATA"].value))
        data = np.lib.format.open_memmap(path, mode="w+", dtype="<f4", shape=page.shape)
        page.asarray(out=data, maxworkers=4)
        valid_count = 0
        low, high = math.inf, -math.inf
        for first in range(0, len(data), 128):
            rows = data[first:first + 128]
            valid = np.isfinite(rows) & (rows != nodata)
            values = rows[valid]
            if values.size:
                low, high = min(low, float(values.min())), max(high, float(values.max()))
                valid_count += values.size
            rows[~valid] = np.nan
        if not valid_count or low < 100 or high > 700:
            raise ValueError(f"unexpected IPR elevation range ({low:g} to {high:g} m)")
        data.flush()
        return {"shape": list(data.shape), "validCells": valid_count, "min": low, "max": high}


def import_archive(archive, output):
    """Verify the pinned IPR ZIP and publish a complete cache in one rename."""
    output = Path(output)
    if output.exists():
        raise FileExistsError(f"{output} already exists. Choose a new cache directory.")
    output.parent.mkdir(parents=True, exist_ok=True)
    with Path(archive).open("rb") as raw, tempfile.TemporaryDirectory(dir=output.parent) as tmp:
        sha = hashlib.file_digest(raw, "sha256").hexdigest()
        if sha != ARCHIVE_SHA256:
            raise ValueError(f"unexpected IPR archive SHA-256 {sha}. Check that the complete DTM.zip was downloaded.")
        raw.seek(0)
        temporary = Path(tmp)
        staged = temporary / "cache"
        staged.mkdir()
        heights, provenance = source_paths(staged)
        tiff = temporary / "dtm_1m.tif"
        with zipfile.ZipFile(raw) as source:
            origin = world_origin(source.read("dtm_1m.tfw").decode("ascii"))
            with source.open("dtm_1m.tif") as member, tiff.open("wb") as extracted:
                shutil.copyfileobj(member, extracted, length=1024 * 1024)
        stats = decode(tiff, origin, heights)
        manifest = {"format": CACHE_FORMAT, "source": SOURCE, "archiveSha256": sha, "origin": origin, **stats}
        provenance.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
        os.rename(staged, output)
    return manifest


def sample_projected(heights, origin, xs, ys):
    """Bilinear heights in EPSG:5514, with NaN outside data coverage."""
    x, y = origin
    u, v = np.broadcast_arrays(np.asarray(xs, float) - x, y - np.asarray(ys, float))
    result = np.full(u.shape, np.nan, dtype=np.float32)
    rows, cols = heights.shape
    inside = (u >= 0) & (u <= cols - 1) & (v >= 0) & (v <= rows - 1)
    if not inside.any():
        return result
    u, v = u[inside], v[inside]
    i = np.minimum(u.astype(int), cols - 2)
    j = np.minimum(v.astype(int), rows - 2)
    fu, fv = u - i, v - j
    total = np.zeros_like(u)
    for dx, wx in ((0, 1 - fu), (1, fu)):
        for dy, wy in ((0, 1 - fv), (1, fv)):
            weight = wx * wy
            total += np.where(weight > 0, weight * heights[j + dy, i + dx], 0)
    result[inside] = total
    return result


def sampler(directory, local):
    """Return the sampler and source record for the verified, memory-mapped raster."""
    heights_path, metadata_path = source_paths(directory)
    try:
        metadata = json.loads(metadata_path.read_text())
        heights = np.load(heights_path, mmap_mode="r", allow_pickle=False)
        origin = tuple(map(float, metadata["origin"]))
        if (metadata["format"] != CACHE_FORMAT or metadata["source"] != SOURCE
                or metadata["archiveSha256"] != ARCHIVE_SHA256
                or heights.dtype != np.dtype("<f4") or heights.ndim != 2 or min(heights.shape) < 2
                or list(heights.shape) != metadata["shape"]
                or len(origin) != 2 or not all(map(math.isfinite, origin))):
            raise ValueError("incompatible raster cache")
    except (OSError, EOFError, ValueError, TypeError, KeyError, AttributeError) as exc:
        raise ValueError(f"{directory}: {exc}. Import DTM.zip with ipr_lidar.py first.") from exc

    # Match ipr_buildings.krovak_to_local in reverse: converting directly from
    # the datum-less local projection would omit the Czech datum shift.
    local_to_wgs = Transformer.from_crs(local, "EPSG:4326", always_xy=True)
    krovak_to_wgs = Transformer.from_crs("EPSG:5514", "EPSG:4326", always_xy=True,
                                        area_of_interest=AreaOfInterest(14.2, 49.9, 14.8, 50.2))

    def at(xs, ys):
        lon, lat = local_to_wgs.transform(xs, ys)
        kx, ky = krovak_to_wgs.transform(lon, lat, direction=TransformDirection.INVERSE)
        return sample_projected(heights, origin, kx, ky)

    return at, {**SOURCE, "archiveSha256": metadata["archiveSha256"]}


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("archive", type=Path, help="IPR Praha's original DTM.zip download")
    ap.add_argument("--output", type=Path, default=CACHE, help="new cache directory")
    args = ap.parse_args()
    try:
        stats = import_archive(args.archive, args.output)
    except (OSError, ValueError, KeyError, ImportError, zipfile.BadZipFile) as exc:
        ap.exit(1, f"{exc}\n")
    print(f"{args.output}: {stats['validCells']:,} cells, {stats['min']:.2f}–{stats['max']:.2f} m Bpv")


if __name__ == "__main__":
    main()
