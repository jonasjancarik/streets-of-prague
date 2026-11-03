#!/usr/bin/env python3
"""The launch video's sound, following plan.py: under each shot the game's own sound of
that shot (rendered as it was filmed, sound/<shot>.wav), evened out and cut with the
picture; a thump under each line, a rising noise into the end of the chase, then the
dark, a slow chord under the pull back and a far bell on the title. The recordings are
the game's CC0 ones (public/audio/SOURCES.md); the rest is made here. Writes
../media/launch.wav."""
import json, os, subprocess, wave
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
AUDIO = os.path.join(HERE, '../../public/audio')
PLAN = json.load(open(os.path.join(HERE, 'plan.json')))
SR, FPS = 48000, PLAN['fps']
N = int(PLAN['frames'] / FPS * SR)
rng = np.random.default_rng(11)
mix = np.zeros((N, 2), dtype=np.float64)

# The cut's segments and lines, as plan.py works them out (it writes its files again, the same).
import contextlib, importlib.util, io
spec = importlib.util.spec_from_file_location('plan', os.path.join(HERE, 'plan.py'))
plan = importlib.util.module_from_spec(spec)
with contextlib.redirect_stdout(io.StringIO()): spec.loader.exec_module(plan)
SEGS, LINES = plan.segs, plan.lines

def read(path):
    w = wave.open(path)
    return np.frombuffer(w.readframes(w.getnframes()), dtype='<i2').reshape(-1, 2).astype(np.float64) / 32768

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
    shape = (lambda x: x) if s.ndim == 1 else (lambda x: x[:, None])
    if na: s[:na] *= shape(np.linspace(0, 1, na) ** 2)
    if nb: s[-nb:] *= shape(np.linspace(1, 0, nb) ** 2)
    return s

def band(sound, lo, hi):
    f = np.fft.rfft(sound, axis=0)
    hz = np.fft.rfftfreq(len(sound), 1 / SR)
    f[(hz < lo) | (hz > hi)] = 0
    return np.fft.irfft(f, len(sound), axis=0)

def thump(strength=1.0):
    t = np.arange(int(0.6 * SR)) / SR
    hz = 36 + 100 * np.exp(-t / 0.03)
    body = np.sin(2 * np.pi * np.cumsum(hz) / SR) * np.exp(-t / 0.2)
    click = band(rng.standard_normal(len(t)), 1500, 6000) * np.exp(-t / 0.004) * 0.25
    return (body + click) * strength

at = lambda seg: seg['start'] / FPS
secs = lambda seg: seg['frames'] / FPS
rms = lambda s: np.sqrt(np.mean(s ** 2)) + 1e-9

# ---- The shots: each one's own sound, about as loud as the others (the quiet ones a little
# quieter still), in quickly at the cut and out a little after the next one.
shots = [s for s in SEGS if s['kind'] == 'shot']
sound = {s['name']: read(os.path.join(HERE, 'sound', s['name'] + '.wav')) for s in shots}
# (How loud each shot sits against the others: the wide still places stay calm.)
LEVEL = {'castle': 0.55, 'getin': 1.0, 'tram': 0.85, 'heli': 1.0, 'mikulas': 0.5, 'rain': 0.9, 'chase': 1.15}
mid = np.median([rms(v) for v in sound.values()])
for seg in shots:
    s = sound[seg['name']][: int((secs(seg) + 0.08) * SR)]
    gain = (mid / rms(s)) ** 0.75 * LEVEL[seg['name']]
    put(fade(s, 0.006 if seg is not shots[0] else 0.6, 0.07), at(seg), gain)

# ---- A thump under each line, and one on the first cut into the chase.
for a, b, en, cs in LINES:
    put(thump(0.8), a / FPS)
chase = next(s for s in SEGS if s['name'] == 'chase')
put(thump(0.6), at(chase))

# ---- A rising noise through the last two seconds of the chase, cut off at the dark.
n = int(2.0 * SR)
u = np.linspace(0, 1, n)
noise = rng.standard_normal(n)
riser = np.zeros(n)
for b in range(8):
    lo = 300 * 1.55 ** b
    riser += band(noise, lo, lo * 1.6) * np.clip(1 - np.abs(u * 7 - b) / 1.5, 0, 1)
put(fade(riser * u ** 2.4, 0.01, 0.005), at(chase) + secs(chase) - 2.0, 0.22)
dark = next(s for s in SEGS if s['kind'] == 'dark')
put(thump(1.0), at(dark))

# ---- The pull back: the car on the bridge and the city at night, then a slow chord
# opening up as the view widens, and a bell far off on the title.
rise = next(s for s in SEGS if s['kind'] == 'rise')
title = next(s for s in SEGS if s['kind'] == 'title')
length = secs(rise) + secs(title)
city = read(os.path.join(HERE, 'sound', 'rise.wav'))
night = clip('amb-night.m4a')
bed = night[int(11.0 * SR): int(11.0 * SR) + int(length * SR)]
put(fade(city[: int(length * SR)], 0.3, 2.0), at(rise), (mid / rms(city)) ** 0.75 * 0.6)
put(fade(bed, 1.5, 2.5), at(rise), 0.3)
t = np.arange(int(length * SR)) / SR
open_ = np.clip(t / secs(rise), 0, 1)
pad = np.zeros((len(t), 2))
for note, level in [(73.42, 1.0), (110.0, 0.8), (146.83, 0.7), (174.61, 0.5), (220.0, 0.45), (293.66, 0.3)]:  # D2 A2 D3 F3 A3 D4
    for h in range(1, 7):
        bright = np.clip(open_ * 7 - (h - 1), 0, 1) / h ** 1.6
        for side, detune in ((0, 0.9972), (1, 1.0031)):
            lfo = 1 + 0.12 * np.sin(2 * np.pi * (0.11 + 0.03 * h) * t + note + side)
            pad[:, side] += np.sin(2 * np.pi * note * h * detune * t + side * 1.3) * level * bright * lfo
swell = np.clip(t / 3.5, 0, 1) ** 1.5 * np.clip((length - t) / 2.0, 0, 1) ** 1.2
put(pad * swell[:, None], at(rise), 0.05)
# The tram's bell an octave and a half lower stands in for a tower's.
bell = clip('bell-1.m4a')
low = np.interp(np.arange(0, len(bell), 2 ** (-1.5)), np.arange(len(bell)), bell)
put(band(low, 150, 6000), at(title) + 0.15, 0.18, pan=-0.2)
put(thump(0.55), at(title) + 0.1)

peak = np.abs(mix).max()
out = np.clip(mix / max(peak, 1e-9) * 0.9, -1, 1)
raw = os.path.join(HERE, 'sound', 'mix.wav')
w = wave.open(raw, 'wb')
w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
w.writeframes((out * 32767).astype('<i2').tobytes()); w.close()
# As loud as video on the web usually is (-16 LUFS), the peaks held under -1.5 dB.
subprocess.run(['ffmpeg', '-y', '-v', 'error', '-i', raw, '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11', '-ar', str(SR), '-c:a', 'pcm_s16le', os.path.join(HERE, '../media/launch.wav')], check=True)
print(f'peak {peak:.2f}, shots at {mid:.3f} rms')
