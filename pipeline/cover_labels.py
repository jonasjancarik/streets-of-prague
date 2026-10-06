"""How well the ground cover classifier does against the labels made by hand.

108 pieces of bare ground round Smíchov were labelled by eye (truth.json and sample.json in
.cache/cover/, with the pieces and photographs `ground_cover.py fetch` and `sheet` left
there). They are only ever scored against, never trained on or tuned to after 28 September.

    uv run --group cover cover_labels.py score praha    # the first version's pieces, and the cells

Still to write (plan 014, "What is left"): weak labels from OSM's surface= tags over the
whole city (.cache/cover/surface.geojsonseq is the osmium export they would come from) and
railway ballast, a material model trained on them and kept as plain numbers in
cover_model.json (cover_cells.material reads it when it is there), and its score here.
"""

import argparse
import json
import time
from collections import defaultdict

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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["score"])
    ap.add_argument("area")
    ap.add_argument("--model", help="score: a model file other than cover_model.json")
    args = ap.parse_args()
    meta = json.loads((G.OUT / f"{args.area}_now" / "index.json").read_text())
    started = time.time()
    if args.cmd == "score":
        score(args.area, meta, args.model)
    print(f"{args.cmd}: {time.time() - started:.0f} s")


if __name__ == "__main__":
    main()
