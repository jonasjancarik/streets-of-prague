"""Samples tiles of praha and keeps, per building, its walls' colour in the sun and in the
shade and the ground's light beside it, to fit the shade correction offline.
usage (from pipeline/): shade_sample.py out.pkl i0 i1 j0 j1 step"""
import pickle, sys, time
sys.path.insert(0, "."); sys.path.insert(0, sys.argv[0].rsplit("/", 1)[0])
import numpy as np, shapely
import keep_key, layers, mesh_colours as mc
keep_key.patch()
out = sys.argv[1]
i0, i1, j0, j1, step = map(int, sys.argv[2:7])
meta = layers.read_meta("praha")
wanted = {(i, j) for i in range(i0, i1, step) for j in range(j0, j1, step)}
by_tile = mc.tile_buildings("praha", meta, wanted)
trees = mc.area_trees(meta)
rows = []
t0 = time.time()
for ij, s, took in mc.sample_tiles(meta, by_tile, trees, 1, False, False):
    summ = mc.summarise(s, balanced=False)
    blds = by_tile[ij]
    fps = [shapely.union_all(fp) for _, _, _, fp in blds]
    tree = shapely.STRtree(fps)
    for b, (rec, raw) in enumerate(zip(summ, s["buildings"])):
        w, sh = rec["wall"], rec["shade"]
        if not w:
            continue
        touching = [int(k) for k in tree.query(fps[b], predicate="dwithin", distance=0.6) if k != b]
        rows.append({"tile": ij, "b": b, "id": rec["id"], "lit": w["lab"], "lit_sure": w["sure"], "lit_n": w["n"],
                     "shade": sh["raw"], "shade_sure": sh["sure"], "shade_n": sh["n"], "shade_old": sh.get("lab"),
                     "ground": raw.get("ground"), "tile_ground": s["ground"], "touching": touching,
                     "centre": [fps[b].centroid.x, fps[b].centroid.y]})
    print(ij, f"{took:.0f}s", len(summ), flush=True)
    pickle.dump(rows, open(out, "wb"))
print("done", len(rows), time.time() - t0)
