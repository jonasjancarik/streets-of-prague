"""Build the walking-sound bank, mono at 24 kHz.

Pass walking.ogg and land.ogg from Kenney's Starter Kit FPS, followed by a folder
containing Kenney's footstep_{grass,snow}_000…004.ogg and TinyWorlds' gravel.ogg.
The original seven quarter-second clips come first, then eleven half-second clips.
"""
import subprocess
import sys
import wave
from pathlib import Path

import numpy as np

RATE = 24000


def decode(path):
    raw = subprocess.check_output(["ffmpeg", "-v", "error", "-i", str(path), "-ac", "1",
                                   "-ar", str(RATE), "-f", "f32le", "-"])
    return np.frombuffer(raw, dtype="<f4")


def padded(samples, size, fade=120):
    out = np.zeros(size)
    n = min(size, len(samples))
    out[:n] = samples[:n]
    out[:24] *= np.linspace(0, 1, 24)
    out[n-fade:n] *= np.linspace(1, 0, fade)
    return out


walk, land = map(decode, sys.argv[1:3])
source = Path(sys.argv[3])
steps = [walk[round(t*RATE):round(t*RATE)+RATE//4] for t in (.36, .73, 1.17, 1.61, 1.99, 2.40)]
bank = []
for clip in [*steps, land]:
    slot = padded(clip, RATE//4)
    bank.append(slot * (.75 / max(.001, np.max(np.abs(slot)))))

# Match contact energy to the walking bank. Grass stays softer than a shoe on stone.
reference = np.median([np.linalg.norm(step) for step in bank[:6]])
for files, level in [([source/f"footstep_grass_{n:03}.ogg" for n in range(5)], .77),
                     ([source/f"footstep_snow_{n:03}.ogg" for n in range(5)], .92),
                     ([source/"gravel.ogg"], .93)]:
    for path in files:
        slot = padded(decode(path), RATE//2, fade=600)
        slot *= min(reference * level / max(.001, np.linalg.norm(slot)), .8 / max(.001, np.max(np.abs(slot))))
        bank.append(slot)

out = Path(__file__).resolve().parents[2] / "public/audio/footfalls.wav"
with wave.open(str(out), "wb") as wav:
    wav.setparams((1, 2, RATE, 0, "NONE", ""))
    for slot in bank:
        wav.writeframes(np.rint(slot * 32767).astype("<i2").tobytes())
