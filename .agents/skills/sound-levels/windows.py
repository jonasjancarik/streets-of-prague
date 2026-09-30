"""Where to cut a loop from a recording: its loudness over time, and the steadiest
windows of a given length (the least prominent one-off sounds, as even a level at the
end as at the start, the least low rumble from passing vehicles).

    cd pipeline && uv run python ../.claude/skills/sound-levels/windows.py 212034 --length 50
    (an id looks in .cache/audio/freesound/<id>.ogg; a path works too)

Reading it: "spikes" is how far the loudest moments stand above the median (a crowd
or a garden is fine at ~7-10 dB, a car going by close is 10+ and would be recognised
in a loop); "drift" and "seam" should be near 0; "low" near 1 means passing traffic or
wind. Birdsong is spiky by nature (phrases, then quiet): judge it by drift and seam.
"""

import argparse
import subprocess
from pathlib import Path

import numpy as np

SR = 22050
p = argparse.ArgumentParser()
p.add_argument("source")
p.add_argument("--length", type=float, default=45)
a = p.parse_args()
path = Path(a.source) if Path(a.source).exists() else Path(__file__).parents[3] / "pipeline/.cache/audio/freesound" / f"{a.source}.ogg"
raw = subprocess.run(["ffmpeg", "-v", "error", "-i", str(path), "-f", "f32le", "-ac", "1", "-ar", str(SR), "-"], capture_output=True, check=True).stdout
x = np.frombuffer(raw, np.float32).astype(np.float64)
hop = SR // 10
n = len(x) // hop
db = 10 * np.log10((x[: n * hop].reshape(n, hop) ** 2).mean(1) + 1e-12)
ns = len(x) // SR
lows = []
for i in range(ns):
    f = np.abs(np.fft.rfft(x[i * SR:(i + 1) * SR])) ** 2
    lows.append(f[np.fft.rfftfreq(SR, 1 / SR) < 200].sum() / (f.sum() + 1e-12))
lows = np.array(lows)
print(f"{path.name}: {len(x) / SR:.0f} s, median {np.median(db):.1f} dB")
print("level every 5 s:", " ".join(f"{np.mean(db[i:i + 50]):.0f}" for i in range(0, n, 50)))
print("low share every 5 s:", " ".join(f"{lows[i:i + 5].mean():.2f}" for i in range(0, ns, 5)))
L = int(a.length * 10)
if n < L:
    raise SystemExit("shorter than --length")
res = []
for s in range(0, n - L, 10):
    w = db[s:s + L]
    spike = np.percentile(w, 99.5) - np.median(w)
    drift = abs(w[: L // 2].mean() - w[L // 2:].mean())
    seam = abs(w[:30].mean() - w[-30:].mean())
    low = lows[s // 10:(s + L) // 10].max()
    res.append((spike + drift + seam + 10 * low, s / 10, spike, drift, seam, low))
for r in sorted(res)[:5]:
    print(f"  from {r[1]:5.0f} s: spikes +{r[2]:.1f} dB, drift {r[3]:.1f}, seam {r[4]:.1f}, low {r[5]:.2f}")
