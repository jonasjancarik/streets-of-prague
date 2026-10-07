"""Lets experiments reuse the parsed sheets while mesh_colours.py is being edited:
read_sheet is unchanged, only the code key (a hash of every pipeline file) moves."""
import pickle, zlib
import build_cache, layers, ipr_buildings as ipr
def patch(area="praha"):
    meta = layers.read_meta(area)
    local, jobs = ipr.sheet_jobs(area, meta)
    f = ipr.CACHE / "parsed" / f"{jobs[-1][0]}_{zlib.crc32(local.encode()):08x}.pkl"
    key = pickle.load(open(f, "rb"))["key"]
    build_cache.code_key = lambda: key[2]
