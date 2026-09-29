"""How much a clip still sounds like speech you could follow: the speech band's
(300-3400 Hz) swell and fade at syllable rate (2-8 Hz), against faster flicker
(12-40 Hz). Plain noise is 1; a single crowd recording with voices near the
microphone was 5.6; the walla crowds (six stretches at once) about 2.

    cd pipeline && uv run python ../.claude/skills/sound-levels/speech.py ../public/audio/amb-crowd.m4a [more files…]
"""

import subprocess
import sys

import numpy as np

SR = 44100
for path in sys.argv[1:]:
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-f", "f32le", "-ac", "1", "-ar", str(SR), "-"], capture_output=True, check=True).stdout
    x = np.frombuffer(raw, np.float32).astype(np.float64)
    f = np.fft.rfftfreq(len(x), 1 / SR)
    s = np.fft.rfft(x)
    s[(f < 300) | (f > 3400)] = 0
    b = np.fft.irfft(s, len(x))
    fr = SR // 100
    n = len(b) // fr
    e = np.sqrt((b[:n * fr].reshape(n, fr) ** 2).mean(1))
    E = np.abs(np.fft.rfft(e - e.mean())) ** 2
    m = np.fft.rfftfreq(n, 1 / 100)
    print(f"{path.split('/')[-1]:24} {E[(m >= 2) & (m <= 8)].mean() / E[(m >= 12) & (m <= 40)].mean():.2f}")
