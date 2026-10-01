#!/usr/bin/env python3
"""The sound of "one day": the dawn's birds giving way to the garden's by day and the
night's hum, a bell far off at six, noon, six and ten, and a quiet chord that opens
towards the evening. The game's CC0 recordings (public/audio/SOURCES.md) and a chord
made here. Writes ../media/day.wav. The numbers match src/day.rs and day/shot.js."""
import os, subprocess, wave
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
AUDIO = os.path.join(HERE, '../../public/audio')
SR, FILM, TITLE = 48000, 24.0, 5.0
FROM, TO = 4 * 60 + 40, 23 * 60 + 40  # minutes of the day at the film's start and end
N = int((FILM + TITLE) * SR)
t = np.arange(N) / SR
mix = np.zeros((N, 2))

def clip(name):
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', os.path.join(AUDIO, name), '-f', 'f32le', '-ac', '1', '-ar', str(SR), '-'], capture_output=True, check=True).stdout
    return np.frombuffer(raw, dtype=np.float32).astype(np.float64)

def looped(sound, start=0.0):
    return sound[(int(start * SR) + np.arange(N)) % len(sound)]

def ramp(a, b, x):
    return np.clip((x - a) / (b - a), 0, 1)

# The hour of the day at each sample (the title holds the last).
hour = (FROM + (TO - FROM) * np.clip(t / FILM, 0, 1)) / 60
beds = [
    (looped(clip('amb-morning.m4a'), 2), ramp(4.6, 5.5, hour) * (1 - ramp(8.5, 11, hour)), 0.30),
    (looped(clip('amb-blackbird.m4a'), 5), ramp(5, 6, hour) * (1 - ramp(7.5, 9.5, hour)), 0.16),
    (looped(clip('amb-garden.m4a'), 7), ramp(8.5, 11, hour) * (1 - ramp(17.5, 20, hour)), 0.26),
    (looped(clip('amb-night.m4a'), 11), ramp(18, 20.5, hour), 0.34),
]
for sound, gain, level in beds:
    mix += (sound * gain * level)[:, None]

# A bell on the hour, lowered an octave and a half so the tram's bell reads as a far tower's.
bell = clip('bell-1.m4a')
low = np.interp(np.arange(0, len(bell), 0.36), np.arange(len(bell)), bell)
low *= np.exp(-np.arange(len(low)) / SR / 1.6)
for strike, pan in ((6, 0.3), (12, -0.3), (18, 0.2), (22, -0.2)):
    at = int((strike * 60 - FROM) / (TO - FROM) * FILM * SR)
    for k in range(2):
        i = at + int(k * 0.9 * SR)
        s = low[: N - i] * (0.22 - 0.07 * k)
        mix[i : i + len(s), 0] += s * (1 - max(0, pan))
        mix[i : i + len(s), 1] += s * (1 + min(0, pan))

# The chord: there from the afternoon, widest under the title.
swell = ramp(15, 21, hour) ** 1.5 * (0.6 + 0.4 * ramp(FILM, FILM + 1.5, t)) * (1 - ramp(FILM + TITLE - 2.5, FILM + TITLE, t)) ** 1.2
for note, level in ((73.42, 1.0), (110.0, 0.8), (146.83, 0.7), (174.61, 0.5), (220.0, 0.4)):
    for h in range(1, 5):
        for side, detune in ((0, 0.9975), (1, 1.0028)):
            lfo = 1 + 0.12 * np.sin(2 * np.pi * (0.1 + 0.03 * h) * t + note + side)
            mix[:, side] += np.sin(2 * np.pi * note * h * detune * t + side) * level / h ** 1.7 * lfo * swell * 0.03

mix *= (ramp(0, 2.0, t) * (1 - ramp(FILM + TITLE - 1.5, FILM + TITLE, t)))[:, None]
peak = np.abs(mix).max()
out = np.clip(mix / peak * 0.5, -1, 1)
w = wave.open(os.path.join(HERE, '../media/day.wav'), 'wb')
w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes((out * 32767).astype('<i2').tobytes()); w.close()
print(f'day.wav: {N / SR:.1f} s, peak {peak:.2f}')
