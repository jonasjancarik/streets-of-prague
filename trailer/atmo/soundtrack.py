#!/usr/bin/env python3
"""The atmospheric trailer's sound, following timeline.json: the engine (rendered from
the game's own engine sound by engine.js, engine.wav here) cut in and out against the
near silence of birds and the night, a thump on each cut into the engine, a rising
noise through the last rush, then the dark, and a slow chord under the pull back.
The recordings are the game's CC0 ones (public/audio/SOURCES.md); the rest is made here.
Writes ../media/atmo.wav."""
import json, os, subprocess, wave
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
AUDIO = os.path.join(HERE, '../../public/audio')
TL = json.load(open(os.path.join(HERE, 'timeline.json')))
SR, FPS = 48000, TL['fps']
N = int(TL['frames'] / FPS * SR)
rng = np.random.default_rng(7)
mix = np.zeros((N, 2), dtype=np.float64)

def clip(name):
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', os.path.join(AUDIO, name), '-f', 'f32le', '-ac', '1', '-ar', str(SR), '-'], capture_output=True, check=True).stdout
    return np.frombuffer(raw, dtype=np.float32).astype(np.float64)

def put(sound, at, gain=1.0, pan=0.0):
    """Adds a mono (or stereo) sound at `at` seconds."""
    i = int(at * SR)
    if i >= N: return
    s = sound[: N - i]
    if s.ndim == 1: s = np.stack([s * (1 - max(0, pan)), s * (1 + min(0, pan))], axis=1)
    mix[i : i + len(s)] += s * gain

def fade(sound, a=0.01, b=0.01):
    s = sound.copy()
    na, nb = min(len(s), int(a * SR)), min(len(s), int(b * SR))
    if na: s[:na] *= np.linspace(0, 1, na) ** 2
    if nb: s[-nb:] *= np.linspace(1, 0, nb) ** 2
    return s

def band(sound, lo, hi):
    f = np.fft.rfft(sound)
    hz = np.fft.rfftfreq(len(sound), 1 / SR)
    f[(hz < lo) | (hz > hi)] = 0
    return np.fft.irfft(f, len(sound))

def looped(sound, seconds, start=0.0):
    n = int(seconds * SR)
    idx = (int(start * SR) + np.arange(n)) % len(sound)
    return sound[idx]

def thump(strength=1.0):
    t = np.arange(int(0.5 * SR)) / SR
    hz = 38 + 95 * np.exp(-t / 0.035)
    body = np.sin(2 * np.pi * np.cumsum(hz) / SR) * np.exp(-t / 0.16)
    click = band(rng.standard_normal(len(t)), 1500, 6000) * np.exp(-t / 0.004) * 0.25
    return (body + click) * strength

at = lambda seg: seg['start'] / FPS
secs = lambda seg: seg['frames'] / FPS

# ---- The engine, and the road's rush under it, louder as the car gets faster
w = wave.open(os.path.join(HERE, 'engine.wav'))
engine = band(np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float64) / 32768, 28, 16000)
road = band(rng.standard_normal(len(engine)), 180, 2600)
top = max(TL['speed'])
drives = [s for s in TL['segments'] if s['kind'] in ('engine', 'rush')]
for k, seg in enumerate(drives):
    a, n = int(seg['engineStart'] / FPS * SR), int(secs(seg) * SR)
    share = TL['speed'][min(TL['engineFrames'], seg['engineStart'] + seg['frames'])] / top
    piece = engine[a : a + n] * (0.5 + 0.4 * share) + road[a : a + n] * 0.09 * share ** 2
    # (The rush runs on from cut to cut: only its first piece fades in, only its last is cut off.)
    first = seg['kind'] == 'engine' or seg['shot'] == 'rush-01'
    last = seg['kind'] == 'engine' or seg is drives[-1]
    put(fade(piece, 0.004 if first else 0.0, 0.012 if last else 0.0), at(seg))
    put(thump(0.55 + 0.35 * share if first else 0.4), at(seg))

# ---- Near silence: birds at dawn, the garden by day, the night's hum, a bell far off
beds = [clip('amb-morning.m4a'), clip('amb-garden.m4a'), clip('amb-night.m4a')]
blackbird = clip('amb-blackbird.m4a')
quiets = [s for s in TL['segments'] if s['kind'] == 'quiet']
for k, seg in enumerate(quiets):
    bed = beds[0 if k < 3 else 1 if k < 6 else 2]
    # A breath of nothing after the engine stops, then the place.
    gap = 0.05
    put(fade(looped(bed, secs(seg) - gap, 3.0 + 4.1 * k), 0.12, 0.02), at(seg) + gap, 0.2)
    if k < 2: put(fade(looped(blackbird, secs(seg) - gap, 2.0 + 5 * k), 0.3, 0.05), at(seg) + gap, 0.22, pan=0.4)
opening = TL['segments'][0]
put(fade(looped(beds[0], secs(opening), 0.0), 1.6, 0.02), 0, 0.2)
put(fade(looped(blackbird, secs(opening), 9.0), 1.2, 0.05), 0, 0.2, pan=-0.3)
bell = clip('bell-1.m4a')
put(band(bell, 300, 5000), at(quiets[4]) + 0.4, 0.12, pan=0.5)

# ---- The rush: a noise that climbs with it, cut dead at the dark
rush = [s for s in TL['segments'] if s['kind'] == 'rush']
r0, r1 = at(rush[0]), at(rush[-1]) + secs(rush[-1])
n = int((r1 - r0) * SR)
u = np.linspace(0, 1, n)
noise = rng.standard_normal(n)
riser = np.zeros(n)
for b in range(8):
    lo = 300 * 1.55 ** b
    gain = np.clip(1 - np.abs(u * 7 - b) / 1.5, 0, 1)
    riser += band(noise, lo, lo * 1.6) * gain
whine = np.sin(2 * np.pi * np.cumsum(220 * 2 ** (u * 2.6)) / SR) * 0.25
put(fade((riser * 0.5 + whine) * u ** 2.2, 0.01, 0.006), r0, 0.3)

# ---- The dark: the engine ticking as it cools
dark = next(s for s in TL['segments'] if s['kind'] == 'dark')
tick = band(rng.standard_normal(int(0.03 * SR)), 2500, 7000) * np.exp(-np.arange(int(0.03 * SR)) / SR / 0.004)
for j, when in enumerate([0.55, 0.9, 1.33]):
    put(tick, at(dark) + when, 0.05 - 0.012 * j, pan=0.2)

# ---- The pull back: a slow chord opening up, the city's hum, and a bell on the title
rise = next(s for s in TL['segments'] if s['kind'] == 'rise')
title = next(s for s in TL['segments'] if s['kind'] == 'title')
length = secs(rise) + secs(title)
t = np.arange(int(length * SR)) / SR
open_ = np.clip(t / secs(rise), 0, 1)
pad = np.zeros((len(t), 2))
for note, level in [(73.42, 1.0), (110.0, 0.8), (146.83, 0.7), (174.61, 0.5), (220.0, 0.45), (293.66, 0.3)]:  # D2 A2 D3 F3 A3 D4
    for h in range(1, 7):
        # The overtones come in as the view widens.
        bright = np.clip(open_ * 7 - (h - 1), 0, 1) / h ** 1.6
        for side, detune in ((0, 0.9972), (1, 1.0031)):
            lfo = 1 + 0.12 * np.sin(2 * np.pi * (0.11 + 0.03 * h) * t + note + side)
            pad[:, side] += np.sin(2 * np.pi * note * h * detune * t + side * 1.3) * level * bright * lfo
swell = np.clip(t / 5.5, 0, 1) ** 1.5 * np.clip((length - t) / 3.0, 0, 1) ** 1.2
put(pad * swell[:, None], at(rise), 0.045)
put(fade(looped(beds[2], length, 11.0), 3.0, 3.0), at(rise), 0.3)
put(band(bell, 200, 6000), at(title) + 0.25, 0.16, pan=-0.2)
put(thump(0.5), at(title) + 0.2)

peak = np.abs(mix).max()
print(f'peak {peak:.2f}')
# (Left well under full scale: about -15 LUFS over the whole trailer.)
out = np.clip(mix / max(peak, 1e-9) * 0.45, -1, 1)
w = wave.open(os.path.join(HERE, '../media/atmo.wav'), 'wb')
w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
w.writeframes((out * 32767).astype('<i2').tobytes()); w.close()
