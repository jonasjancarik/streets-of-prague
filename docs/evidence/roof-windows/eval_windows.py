"""Crops of roofs with the roof windows the detector finds drawn on them, to judge by eye.
usage: eval_windows.py <out dir> <per tile> lat,lon ...   (run from pipeline/)"""
import json, pickle, sys, zlib
sys.path.insert(0, ".")
import numpy as np
from PIL import Image, ImageDraw
from pyproj import Transformer
sys.path.insert(0, sys.argv[0].rsplit("/", 1)[0])
import keep_key, layers, mesh_colours as mc
keep_key.patch()

out_dir, per = sys.argv[1], int(sys.argv[2])
meta = layers.read_meta("praha")
T, (ox, oy) = meta["tile"], meta["origin"]
tf = Transformer.from_crs("EPSG:4326", meta["crs"], always_xy=True)
FINE, FINE_RES, ZOOM = 16, 0.05, 2
rows = []
for spot in [a for a in sys.argv[3:] if not a.startswith('--')]:
    lat, lon = map(float, spot.split(","))
    x, y = tf.transform(lon, lat)
    ij = (int((x + ox) // T), int((y + oy) // T))
    cache = f"{out_dir}/det_{ij[0]}_{ij[1]}.pkl"
    blds = mc.tile_buildings("praha", meta, {ij})[ij]
    try:
        found = pickle.load(open(cache, "rb")) if "--fresh" not in sys.argv else None
    except OSError:
        found = None
    if found is None or "--redetect" in sys.argv:
        found = mc.detect_windows(meta, ij, blds)
    pickle.dump(found, open(f"{out_dir}/det_{ij[0]}_{ij[1]}{'_new' if '--redetect' in sys.argv else ''}.pkl", "wb"))
    with_windows = sorted(found, key=lambda b: zlib.crc32(blds[b][0].encode()))
    # The same roofs each time: those the first run picked.
    pick_file = f"{out_dir}/pick_{ij[0]}_{ij[1]}.json"
    try:
        picked = json.load(open(pick_file))
    except OSError:
        picked = [blds[b][0] for b in with_windows[:per]]
        json.dump(picked, open(pick_file, "w"))
    index = {bl[0]: k for k, bl in enumerate(blds)}
    for bid in picked:
        b = index[bid]
        t = mc.unpack(blds[b][1], ij, meta)
        lo, hi = t[:, :, :2].reshape(-1, 2).min(0) - 1.5, t[:, :, :2].reshape(-1, 2).max(0) + 1.5
        size = float(max(hi - lo))
        size = min(size, 45.0)
        mesh = mc.load_mesh(meta["crs"], (lo[0], lo[1], lo[0] + size, lo[1] + size), level=FINE, margin=1.0)
        colour, _ = mc.top_view(mesh, lo[0], lo[1], size, FINE_RES)
        img = Image.fromarray(colour).resize((colour.shape[1] * ZOOM, colour.shape[0] * ZOOM), Image.LANCZOS)
        marked = img.copy()
        draw = ImageDraw.Draw(marked)
        wins = found.get(b, [])
        k = ZOOM / FINE_RES
        n = 0
        for w in wins:
            c, e, d = np.array(w[0:3]), np.array(w[3:6]), np.array(w[6:9])
            corners = [c + sa * e * w[9] / 2 + sd * d * w[10] / 2 for sa, sd in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
            px = [((p[0] - lo[0]) * k, (lo[1] + size - p[1]) * k) for p in corners]
            if not all(-20 <= a <= img.width + 20 and -20 <= bb <= img.height + 20 for a, bb in px):
                continue
            n += 1
            draw.line(px + [px[0]], fill=(255, 0, 255), width=4)
            draw.text((max(a for a, _ in px) + 2, min(bb for _, bb in px) - 2), str(n), fill=(255, 255, 0))
        both = Image.new("RGB", (img.width * 2 + 6, img.height), (255, 255, 255))
        both.paste(img, (0, 0)); both.paste(marked, (img.width + 6, 0))
        name = f"{ij[0]}_{ij[1]}_{bid[-8:]}"
        both.save(f"{out_dir}/{'new_' if '--redetect' in sys.argv else ''}{name}.png")
        rows.append((name, n))
        print(name, n, both.size, flush=True)
print(sum(n for _, n in rows), "windows on", len(rows), "roofs")
