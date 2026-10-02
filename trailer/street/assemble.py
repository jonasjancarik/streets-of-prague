#!/usr/bin/env python3
"""Puts a take's filmed stretches together: trailer/clips/street-<take>.mp4 with a frame
for every frame of the route (a stretch that wasn't filmed holds the nearest frame that
was) and street/sound/<take>.wav the route's length (silent where nothing was filmed)."""
import glob, json, os, re, subprocess, sys, wave
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.environ.get('OUT', '/tmp/trailer-frames')
PLAN = json.load(open(os.path.join(HERE, 'plan.json')))
FPS, SR = PLAN['fps'], 48000
take = sys.argv[1]
version = sys.argv[2] if len(sys.argv) > 2 else 'street'   # which version's frames
info = next(t for t in PLAN['takes'] if t['name'] == take)
os.makedirs(os.path.join(HERE, 'sound'), exist_ok=True)
ATMO = json.load(open(os.path.join(HERE, '../atmo/timeline.json')))
length = info['still'] * FPS if info.get('still') else ATMO['filmed'] if info.get('rise') else PLAN['routeFrames']

# The whole mix, and each bus of it (stems/<take>.<bus>.wav), the route's length.
def lay(pattern, target):
    paths = [p for p in glob.glob(f'{OUT}/{take}_*.wav') if re.search(pattern, p)]
    if not paths: return False
    sound = np.zeros((int(length / FPS * SR), 2), dtype='<i2')
    for path in paths:
        first = int(re.search(r'_(\d+)\.', os.path.basename(path)).group(1))
        w = wave.open(path)
        a = np.frombuffer(w.readframes(w.getnframes()), dtype='<i2').reshape(-1, 2)
        i = int(first / FPS * SR)
        sound[i : i + len(a)] = a[: len(sound) - i]
    w = wave.open(target, 'wb')
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes(sound.tobytes()); w.close()
    return True
os.makedirs(os.path.join(HERE, 'sound', 'stems'), exist_ok=True)
lay(r'_\d+\.wav$', os.path.join(HERE, 'sound', take + '.wav'))
for bus in ['engine', 'tyres', 'horns', 'trams', 'city', 'weather', 'bangs']:
    lay(rf'_\d+\.{bus}\.wav$', os.path.join(HERE, 'sound', 'stems', f'{take}.{bus}.wav'))
if info.get('still'):
    print(f'{take}: sound only'); sys.exit()

frames = {}
# (EVERY: the footage has only every so many of the route's frames; the ones between hold the nearest.)
EVERY = int(os.environ.get('EVERY', '1'))
for path in glob.glob(f'{OUT}/{version}-{take}_*-*.png') + glob.glob(f'{OUT}/{version}-{take}_*-*.jpg'):
    first, k = (int(v) for v in re.search(r'_(\d+)-(\d+)\.(?:png|jpg)$', path).groups())
    frames[first + (k - 1) * EVERY] = path
have = sorted(frames)
if not have: sys.exit(f'{take}: no frames of the {version} version (sound only)')
lines = []
for i in range(length):
    j = i if i in frames else min(have, key=lambda h: abs(h - i))
    lines += [f"file '{frames[j]}'", f'duration {1 / FPS:.6f}']
lines.append(f"file '{frames[j]}'")
listing = f'{OUT}/{version}-{take}.txt'
open(listing, 'w').write('\n'.join(lines))
subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listing, '-vf', f'fps={FPS}', '-c:v', 'libx264', '-crf', '15' if EVERY == 1 else '20', '-preset', 'medium' if EVERY == 1 else 'veryfast',
                '-pix_fmt', 'yuv420p', '-g', '1', os.path.join(HERE, f'../clips/{version}-{take}.mp4')], check=True)
print(f'{take}: {len(have)} frames filmed of {length}')
