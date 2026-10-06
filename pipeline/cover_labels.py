"""Labels for the ground cover classifier, and how well it does against them.

Two kinds of label:

  hand   108 pieces of bare ground round Smíchov, labelled by eye (truth.json and sample.json
         in .cache/cover/, with the pieces and photographs `ground_cover.py fetch` and `sheet`
         left there). Only ever scored against, never trained on.
  weak   what OSM says a surface is: surface= on areas and ways over the whole city (osmium
         export of the extract into .cache/cover/surface.geojsonseq), and railway ballast
         from the tiles. Noisy (parked cars, tree crowns, old tags), but they come by the
         ten thousand and from every district.

    uv run --group cover cover_labels.py index praha            # the weak labels, sorted by tile (1 min)
    uv run --group cover cover_labels.py rows praha --tiles 600 # training rows from the photographs kept
    uv run --group cover cover_labels.py train praha            # fit, cross-validate, write a trial model
    uv run --group cover cover_labels.py score praha --model .cache/cover/weak/trial_model.json

Tried on 6 October 2026 and not kept (no cover_model.json): the model learnt OSM's surfaces
(76 % right on tiles held out, with asphalt, gravel and dirt) but did worse than the rules
on the hand labels (19 % of hard ground against 38 %). See docs/beige-cover-city.md.
"""

import argparse
import json
import pickle
import time
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np

import cover_cells
import ground_cover as G

CACHE = G.CACHE


def kept_fetch(url, kind, area, t, res=G.RES, window=None):
    """The photographs `ground_cover.py fetch` kept for the Smíchov block, in place of photo()."""
    a = np.load(CACHE / "img" / kind / f"{t['i']}_{t['j']}.npy")
    if window:
        r0, r1, c0, c1 = window
        a = a[r0:r1, c0:c1]
    return a


def hand_tiles():
    sample = json.loads((CACHE / "sample.json").read_text())
    truth = json.loads((CACHE / "truth.json").read_text())
    by = defaultdict(list)
    for n, (k, pid) in enumerate(sample):
        want = truth.get(str(n))
        if want and want != "skip":
            by[tuple(map(int, k.split("_")))].append((pid, want))
    return by


def hand_maps(area, meta, model):
    """{tile: (class map, voted class map)} of the labelled tiles, each worked out with its margin."""
    out = {}
    for (i, j) in hand_tiles():
        t = G.tile_json(area, i, j)
        around = {(di, dj): G.tile_json(area, i + di, j + dj) for di in (-1, 0, 1) for dj in (-1, 0, 1) if di or dj}
        P, mask, cls, smooth, ext, _ = G.tile_classes(area, meta, t, around, fetch=kept_fetch, model=model)
        M = round(cover_cells.MARGIN / cover_cells.CELL)
        out[(i, j)] = (cls[M:-M, M:-M], smooth[M:-M, M:-M])
    return out


def tally(rows):
    """The first version's measures (ground_cover.score) for [(wanted, got, area)]."""
    green = {"grass", "trees"}
    share = lambda r, ok: sum(w for a, b, w in r if ok(a, b)) / max(sum(w for *_, w in r), 1e-9)
    hard = [x for x in rows if x[0] not in green and x[0] != "structure"]
    return {"n": len(rows), "exact": share(rows, lambda a, b: a == b),
            "green or not": share(rows, lambda a, b: (a in green) == (b in green)),
            "material on hard ground": share(hard, lambda a, b: a == b),
            "material, of the pieces called hard ground": share([x for x in hard if x[1] in cover_cells.HARD], lambda a, b: a == b),
            "not ground caught": share([x for x in rows if x[0] == "structure"], lambda a, b: b == "structure"),
            "hard pieces": len(hard)}


def hand_rows(area, meta, maps, which=1):
    """[(wanted, got, area)]: each labelled piece gets the class most of its cells were given."""
    rows = []
    for (i, j), wanted in hand_tiles().items():
        a = G.analyse(area, meta, i, j)
        for pid, want in wanted:
            got = maps[(i, j)][which][a["labels"] == pid]
            got = got[got >= 0]
            if not len(got):
                rows.append((want, "structure", a["summ"][pid]["area"]))
                continue
            rows.append((want, cover_cells.CLASSES[np.bincount(got, minlength=len(cover_cells.CLASSES)).argmax()], a["summ"][pid]["area"]))
    return rows


def confusion(rows, classes):
    table = defaultdict(float)
    for a, b, w in rows:
        table[(a, b)] += w
    lines = ["wanted \\ got".ljust(12) + "".join(c[:8].rjust(9) for c in classes)]
    for a in classes:
        if any(table[(a, b)] for b in classes):
            lines.append(a.ljust(12) + "".join(f"{table[(a, b)]:9.0f}" for b in classes))
    return "\n".join(lines)


def score(area, meta, model_path=None):
    model = cover_cells.load_model(model_path) if model_path else cover_cells.load_model()
    results = {}
    first = [(want, G.rules(G.analyse(area, meta, i, j)["summ"][pid]), G.analyse(area, meta, i, j)["summ"][pid]["area"])
             for (i, j), wanted in hand_tiles().items() for pid, want in wanted]
    results["pieces, rules (first version)"] = first
    for name, m in (("cells, rules", None), ("cells, rules + model", model)):
        if name.endswith("model") and not model:
            continue
        maps = hand_maps(area, meta, m)
        results[name + ", before the vote"] = hand_rows(area, meta, maps, 0)
        results[name] = hand_rows(area, meta, maps, 1)
    hard = [x for x in first if x[0] in cover_cells.HARD]
    results["(every hard piece called dirt)"] = [(a, "dirt" if a in cover_cells.HARD else a, w) for a, b, w in first]
    for name, rows in results.items():
        t = tally(rows)
        print(f"{name:42s} n={t['n']}  exact {t['exact'] * 100:3.0f}%  green or not {t['green or not'] * 100:3.0f}%  "
              f"material on hard ground {t['material on hard ground'] * 100:3.0f}% (of {t['hard pieces']})  "
              f"of those called hard {t['material, of the pieces called hard ground'] * 100:3.0f}%  not ground caught {t['not ground caught'] * 100:3.0f}%")
    for name in ("pieces, rules (first version)", "cells, rules", "cells, rules + model"):
        if name in results:
            print(f"\n{name} (m2):\n{confusion(results[name], cover_cells.CLASSES)}")
    return results


# --- Weak labels: what OSM says a surface is ---------------------------------------------------

WEAK = CACHE / "weak"
HELD_OUT = (49, 55, 51, 57)   # the block of tiles round the hand labels: no training rows from here
NARROW = ("track", "path", "footway", "cycleway", "bridleway", "steps", "pedestrian")


def index(area, meta):
    """OSM's surface= areas and ways sorted by tile: {(i, j): [(class, wkb)]} in local metres,
    ways widened to a strip. Bridges, tunnels and anything roofed are left out (the photograph
    shows something else there)."""
    import shapely
    from pyproj import Transformer
    tf = Transformer.from_crs("EPSG:4326", G.local_proj(area), always_xy=True)
    x0, y0, x1, y1 = meta_box(area)
    T = layers_meta(area)["tile"]
    out, kept = defaultdict(list), Counter()
    for line in (CACHE / "surface.geojsonseq").open():
        f = json.loads(line.lstrip("\x1e"))
        p = f["properties"]
        cls = G.SURFACE.get(p.get("surface"))
        if not cls or p.get("tunnel") or p.get("bridge") or p.get("covered") or p.get("indoor") or p.get("layer", "0") != "0":
            continue
        g = shapely.geometry.shape(f["geometry"])
        g = shapely.transform(g, lambda c: np.column_stack(tf.transform(c[:, 0], c[:, 1])))
        if g.geom_type in ("LineString", "MultiLineString"):
            if not p.get("highway"):
                continue
            g = g.buffer(1.0 if p["highway"] in NARROW else 2.5, cap_style="flat")
        elif g.geom_type not in ("Polygon", "MultiPolygon"):
            continue
        g = g.buffer(0)
        if g.is_empty:
            continue
        bx0, by0, bx1, by1 = g.bounds
        raw = shapely.to_wkb(g)
        for i in range(int((bx0 - x0) // T), int((bx1 - x0) // T) + 1):
            for j in range(int((by0 - y0) // T), int((by1 - y0) // T) + 1):
                out[(i, j)].append((cls, raw))
        kept[cls] += 1
    WEAK.mkdir(parents=True, exist_ok=True)
    (WEAK / f"{area}.pkl").write_bytes(pickle.dumps(dict(out)))
    print("labelled areas and ways:", dict(kept), "over", len(out), "tiles")


def layers_meta(area):
    import layers
    return layers.read_meta(area)


def meta_box(area):
    return layers_meta(area)["box"]


def tile_rows(job):
    """Training rows of one tile: the features (cover_cells.FEATURES) of up to `per` cells of
    each labelled class that the rules would call hard ground, each class measured on its own
    labelled ground the way the classifier measures a patch of bare ground."""
    import shapely
    area, meta, i, j, labels, per = job
    t = json.loads((G.OUT / f"{area}_now" / "tiles" / f"{i}_{j}.json").read_text())
    t = {**t, "i": i, "j": j}
    rgb, known = G.joined(G.RGB, "rgb", area, t, {})
    if rgb is None:
        return []
    cir = G.joined(G.CIR, "cir", area, t, {})[0]
    ext = G.wide(t)
    P = cover_cells.measure(rgb, cir, G.ipr_dsm(area, ext, G.RES, cache=False), G.terrain_wide(area, meta, t, ext, G.RES))
    near = G.near_masks(ext, [t])
    seen = (rgb.max(-1) >= G.SEEN) & known
    shape_ = seen.shape
    roofs = G.burn(np.zeros(shape_, bool), ext, G.RES, [b["rings"] for b in t["buildings"]])
    by = defaultdict(list)
    for cls, raw in labels:
        by[cls] += G.rings_of(shapely.from_wkb(raw))
    rails = [G.LineString(r["pts"]).buffer(1.5, cap_style="flat") for r in t.get("rails", []) if r["kind"] == "rail" and len(r["pts"]) > 1]
    if rails:
        by["gravel"] += G.rings_of(G.unary_union(rails))
    by["gravel"] += t["areas"].get("ballast", [])
    masks = {cls: G.burn(np.zeros(shape_, bool), ext, G.RES, rings) & seen & ~roofs for cls, rings in by.items() if rings}
    taken = sum(m.astype(np.int8) for m in masks.values()) if masks else 0
    rng = np.random.default_rng(i * 1000 + j)
    hard = [cover_cells.CLASSES.index(c) for c in cover_cells.HARD]
    rows = []
    for cls, mask in masks.items():
        mask = mask & (taken == 1)
        if mask.sum() * G.RES ** 2 < 20:
            continue
        C, m = cover_cells.cells(P, mask)
        L = cover_cells.local(C, m, near)
        ok = m & np.isin(cover_cells.rules(L), hard) & (L["open"] > 0.15)
        at = np.flatnonzero(ok.ravel())
        if not len(at):
            continue
        pick = rng.choice(at, size=min(per, len(at)), replace=False)
        where = np.zeros(ok.size, bool)
        where[pick] = True
        X = cover_cells.vectors(L, where.reshape(ok.shape))
        rows += [(cls, f"{i}_{j}", x) for x in X]
    return rows


def rows(area, meta, n_tiles, jobs, per=150):
    """Rows from the tiles with most labelled ground of each class (asphalt comes with any of
    them), from the photographs already kept; none from the block round the hand labels."""
    import shapely
    from concurrent.futures import ProcessPoolExecutor
    idx = pickle.loads((WEAK / f"{area}.pkl").read_bytes())
    have = {tuple(map(int, p.stem.split("_"))) for p in (G.PHOTOS / area / "rgb").glob("*.jpg")}
    i0, i1, j0, j1 = HELD_OUT
    area_of = defaultdict(Counter)
    for k, items in idx.items():
        if k in have and not (i0 <= k[0] <= i1 and j0 <= k[1] <= j1) and (G.OUT / f"{area}_now" / "tiles" / f"{k[0]}_{k[1]}.json").exists():
            for cls, raw in items:
                area_of[cls][k] += min(shapely.from_wkb(raw).area, 3000)
    chosen = set()
    rng = np.random.default_rng(7)
    for cls in ("gravel", "dirt", "concrete", "paving", "asphalt"):
        ranked = [k for k, a in area_of[cls].most_common(n_tiles) if a > 100]
        # (not only the very largest: a share drawn at random from the tiles with enough of it)
        pool = [k for k, a in area_of[cls].items() if a > 300]
        extra = [pool[n] for n in rng.choice(len(pool), size=min(len(pool), n_tiles // 10), replace=False)] if pool else []
        chosen |= set(ranked[: n_tiles // 10]) | set(extra)
        print(cls, "tiles with it:", len(area_of[cls]), "chosen so far:", len(chosen), flush=True)
    meta = {**meta}
    out = []
    with ProcessPoolExecutor(jobs) as pool:
        for n, got in enumerate(pool.map(tile_rows, [(area, meta, i, j, idx[(i, j)], per) for i, j in sorted(chosen)], chunksize=2)):
            out += got
            if n % 50 == 49:
                print(f"  {n + 1} tiles, {len(out)} rows", flush=True)
    (WEAK / f"{area}_rows.pkl").write_bytes(pickle.dumps(out))
    print("rows per class:", dict(Counter(c for c, *_ in out)), "from", len({k for _, k, _ in out}), "tiles")


def fit(X, y, classes):
    from sklearn.linear_model import LogisticRegression
    mean, scale = X.mean(0), X.std(0) + 1e-6
    clf = LogisticRegression(C=0.3, class_weight="balanced", max_iter=2000)
    clf.fit((X - mean) / scale, y)
    return {"kind": "logistic", "features": cover_cells.FEATURES, "classes": [classes[k] for k in clf.classes_],
            "mean": mean.tolist(), "scale": scale.tolist(), "coef": clf.coef_.tolist(), "intercept": clf.intercept_.tolist()}


def train(area, out_path, classes=None, drop=()):
    """Fit the material model on the weak rows and say how it does on tiles it has not seen
    (five folds, whole tiles held out), then write it to `out_path`."""
    data = pickle.loads((WEAK / f"{area}_rows.pkl").read_bytes())
    classes = classes or cover_cells.HARD
    data = [r for r in data if r[0] in classes]
    X = np.array([r[2] for r in data])
    y = np.array([classes.index(r[0]) for r in data])
    tiles = sorted({r[1] for r in data})
    fold = {k: n % 5 for n, k in enumerate(np.random.default_rng(3).permutation(tiles))}
    f = np.array([fold[r[1]] for r in data])
    pairs = []
    for k in range(5):
        m = fit(X[f != k], y[f != k], classes)
        got = cover_cells.predict(m, X[f == k])
        pairs += [(classes[a], m["classes"][b], 1.0) for a, b in zip(y[f == k], got)]
    acc = np.mean([a == b for a, b, _ in pairs])
    per = {c: np.mean([a == b for a, b, _ in pairs if a == c]) for c in classes if any(a == c for a, *_ in pairs)}
    print(f"weak labels, tiles held out: {acc * 100:.0f}% of {len(pairs)} cells right; per class " +
          ", ".join(f"{c} {v * 100:.0f}%" for c, v in per.items()))
    print(confusion(pairs, classes))
    model = fit(X, y, classes)
    model["trained_on"] = {"rows": len(data), "tiles": len(tiles), "per_class": dict(Counter(r[0] for r in data)),
                           "held_out_tiles_right": round(float(acc), 3)}
    Path(out_path).write_text(json.dumps(model))
    return model


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["index", "rows", "train", "score"])
    ap.add_argument("--tiles", type=int, default=600, help="rows: about how many tiles to take rows from")
    ap.add_argument("--jobs", type=int, default=6)
    ap.add_argument("--classes", help="train: comma-separated classes to keep (default: all five hard ones)")
    ap.add_argument("--out", help="train: where to write the model (default: a trial file in the cache)")
    ap.add_argument("area")
    ap.add_argument("--model", help="score: a model file other than cover_model.json")
    args = ap.parse_args()
    meta = json.loads((G.OUT / f"{args.area}_now" / "index.json").read_text())
    started = time.time()
    if args.cmd == "score":
        score(args.area, meta, args.model)
    elif args.cmd == "index":
        index(args.area, meta)
    elif args.cmd == "rows":
        rows(args.area, meta, args.tiles, args.jobs)
    elif args.cmd == "train":
        train(args.area, args.out or WEAK / "trial_model.json", args.classes.split(",") if args.classes else None)
    print(f"{args.cmd}: {time.time() - started:.0f} s")


if __name__ == "__main__":
    main()
