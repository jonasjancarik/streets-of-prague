"""Cut Kenney's walking.ogg and land.ogg into a mono bank of seven 250 ms slots.

Pass the two files from KenneyNL/Starter-Kit-FPS/sounds as arguments. Each walking
slot contains both heel and toe. The last contains the short landing impact.
"""
import subprocess
import sys
import wave
from pathlib import Path

import numpy as np

RATE = 24000
SAMPLES = RATE // 4

def decode(path):
    raw = subprocess.check_output(["ffmpeg", "-v", "error", "-i", path, "-ac", "1",
                                   "-ar", str(RATE), "-f", "f32le", "-"])
    return np.frombuffer(raw, dtype="<f4")

walk, land = map(decode, sys.argv[1:])
steps = [walk[round(t * RATE):round(t * RATE) + SAMPLES] for t in (0.36, 0.73, 1.17, 1.61, 1.99, 2.40)]
out = Path(__file__).resolve().parents[2] / "public/audio/footfalls.wav"
with wave.open(str(out), "wb") as wav:
    wav.setparams((1, 2, RATE, 0, "NONE", ""))
    for step in [*steps, land]:
        slot = np.zeros(SAMPLES)
        slot[:len(step)] = step
        slot[:24] *= np.linspace(0, 1, 24)
        slot[len(step)-120:len(step)] *= np.linspace(1, 0, 120)
        slot *= 0.75 / max(0.001, np.max(np.abs(slot)))
        wav.writeframes(np.rint(slot * 32767).astype("<i2").tobytes())
