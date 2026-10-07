"""Does the ground's light bring a wall seen in shade to its colour in the sun?
Tried on buildings seen both ways; errors are ΔE (CIELAB) against the wall measured in the sun.
usage (from pipeline/): shade_fit.py shade.pkl"""
import pickle, sys
sys.path.insert(0, ".")
import numpy as np
import mesh_colours as mc
rows = pickle.load(open(sys.argv[1], "rb"))
LUMA = mc.LUMA
by = {(r["tile"], r["b"]): r for r in rows}
lit_n = sum(r["lit_sure"] for r in rows)
print(f"{len(rows)} buildings with wall samples on {len({r['tile'] for r in rows})} tiles; walls sure in the sun {lit_n} ({100*lit_n/len(rows):.0f} %), "
      f"sure only in the shade {sum((not r['lit_sure']) and r['shade_sure'] for r in rows)}")

def gmed(g, key, least=30):
    if not g or g[key][0] is None or g[key][1] < least:
        return None
    return np.asarray(g[key][0])

both = []
for r in rows:
    if not (r["lit_sure"] and r["shade_sure"]):
        continue
    gs = gmed(r["ground"], "shade")
    gl = gmed(r["ground"], "lit")
    gl = gl if gl is not None else gmed(r["tile_ground"], "lit", 200)
    r["gs"], r["gl"] = gs, gl
    both.append(r)
print(f"seen both ways: {len(both)}; of them with shaded ground beside and sunlit ground to compare: {sum(r['gs'] is not None and r['gl'] is not None for r in both)}")
use = [r for r in both if r["gs"] is not None and r["gl"] is not None]
lit = np.array([r["lit"] for r in use])
sh_lin = mc.labs_linear(np.array([r["shade"] for r in use]))
gs = np.array([r["gs"] for r in use]); gl = np.array([r["gl"] for r in use])
lit_lin = mc.labs_linear(lit)
tiles = np.array([hash(r["tile"]) % 5 for r in use])

def de(est):
    return np.linalg.norm(est - lit, axis=1)

def show(name, e, sel=None):
    e = e if sel is None else e[sel]
    print(f"  {name:58s} {np.median(e):5.1f}  ({np.percentile(e, 25):.1f}-{np.percentile(e, 75):.1f})  n={len(e)}")

res = {}
# A. the citywide rule already in mesh_colours.py
res["A"] = de(np.array([mc.from_shade(r["shade"]) for r in use]))
# B. per channel: wall in shade x (sunlit ground / shaded ground) x k, k fitted on the other tiles
estB = np.zeros_like(lit); estC = np.zeros_like(lit); estD = np.zeros_like(lit)
ratio = gl / np.maximum(gs, 1e-4)
ys, yl = sh_lin @ LUMA, lit_lin @ LUMA
gr = np.log(np.maximum(gl @ LUMA, 1e-4) / np.maximum(gs @ LUMA, 1e-4))
coefs = []
for f in range(5):
    tr, te = tiles != f, tiles == f
    k = np.median(lit_lin[tr] / np.maximum(sh_lin[tr] * ratio[tr], 1e-5), axis=0)
    estB[te] = mc.linear_lab(sh_lin[te] * ratio[te] * k)
    # C. brightness by a fit in logs on the wall's own darkness and the ground's ratio; hue from the shade, tint fitted
    A = np.column_stack((np.ones(tr.sum()), np.log(np.maximum(ys[tr], 1e-4)), gr[tr]))
    coef, *_ = np.linalg.lstsq(A, np.log(yl[tr]), rcond=None)
    coefs.append(coef)
    tint = np.median((lit_lin[tr] / yl[tr, None]) / np.maximum(sh_lin[tr] / np.maximum(ys[tr, None], 1e-5), 1e-5), axis=0)
    y_est = np.exp(np.column_stack((np.ones(te.sum()), np.log(np.maximum(ys[te], 1e-4)), gr[te])) @ coef)
    hue = sh_lin[te] * tint; hue /= np.maximum(hue @ LUMA, 1e-6)[:, None]
    estC[te] = mc.linear_lab(hue * y_est[:, None])
    # D. the same without the ground: only the wall's own darkness
    A2 = A[:, :2]; coef2, *_ = np.linalg.lstsq(A2, np.log(yl[tr]), rcond=None)
    y2 = np.exp(np.column_stack((np.ones(te.sum()), np.log(np.maximum(ys[te], 1e-4)))) @ coef2)
    estD[te] = mc.linear_lab(hue * y2[:, None])
res["B"], res["C"], res["D"] = de(estB), de(estC), de(estD)
# E. a neighbour sharing a wall, measured in the sun (what the map does now)
nb = np.full(len(use), np.nan); has = np.zeros(len(use), bool); estN = np.zeros_like(lit)
for i, r in enumerate(use):
    cands = [by[(r["tile"], k)] for k in r["touching"] if (r["tile"], k) in by and by[(r["tile"], k)]["lit_sure"]]
    if cands:
        c = min(cands, key=lambda o: np.hypot(o["centre"][0] - r["centre"][0], o["centre"][1] - r["centre"][1]))
        estN[i] = c["lit"]; has[i] = True
res["N"] = de(estN)
rng = np.random.default_rng(1)
res["R"] = de(lit[rng.permutation(len(lit))])
mid = np.median(lit, axis=0)
res["M"] = de(np.tile(mid, (len(lit), 1)))
print("error of each guess, ΔE median (quartiles):")
show("A  citywide shade rule (from_shade, as before)", res["A"])
show("B  shade x sunlit/shaded ground x k, per channel", res["B"])
show("C  brightness fitted on the wall and the ground's ratio", res["C"])
show("D  the same fit without the ground", res["D"])
show("R  another building's colour", res["R"])
show("M  the sample's median wall", res["M"])
print("where a measured neighbour shares a wall:")
for k, name in (("N", "N  the neighbour's colour (what the map does now)"), ("B", "B"), ("C", "C"), ("D", "D"), ("R", "R")):
    show(name, res[k], has)
print("fit C, log Y_sun = a + b log Y_shade + c log(ground sun/shade):", np.round(np.mean(coefs, axis=0), 3).tolist())
print("lightness and colour apart (median |ΔL*|, median Δ(a*,b*)):")
for name, est in (("B", estB), ("C", estC), ("N (where there is one)", estN)):
    sel = has if name.startswith("N") else slice(None)
    print(f"  {name:24s} {np.median(np.abs(est[sel, 0] - lit[sel, 0])):5.1f}  {np.median(np.linalg.norm(est[sel, 1:] - lit[sel, 1:], axis=1)):5.1f}")
# How much the ground explains: the wall's sun/shade ratio against the ground's
print("correlation of log(wall sun/shade) with log(ground sun/shade):", round(float(np.corrcoef(np.log(yl / np.maximum(ys, 1e-4)), gr)[0, 1]), 2))
