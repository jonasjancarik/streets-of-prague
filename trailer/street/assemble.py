#!/usr/bin/env python3
"""Puts a take's filmed stretches together: trailer/clips/street-<take>.mp4 with a frame
for every frame of the route (a stretch that wasn't filmed holds the nearest frame that
was) and street/sound/<take>.wav the route's length (silent where nothing was filmed)."""
import glob, json, os, re, subprocess, sys, wave
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = '/tmp/trailer-frames'
PLAN = json.load(open(os.path.join(HERE, 'plan.json')))
FPS, SR = PLAN['fps'], 48000
take = sys.argv[1]
info = next(t for t in PLAN['takes'] if t['name'] == take)
os.makedirs(os.path.join(HERE, 'sound'), exist_ok=True)
ATMO = json.load(open(os.path.join(HERE, '../atmo/timeline.json')))
length = info['still'] * FPS if info.get('still') else ATMO['filmed'] if info.get('rise') else PLAN['routeFrames']

sound = np.zeros((int(length / FPS * SR), 2), dtype='<i2')
for path in glob.glob(f'{OUT}/{take}_*.wav'):
    first = int(re.search(r'_(\d+)\.wav$', path).group(1))
    w = wave.open(path)
    a = np.frombuffer(w.readframes(w.getnframes()), dtype='<i2').reshape(-1, 2)
    i = int(first / FPS * SR)
    sound[i : i + len(a)] = a[: len(sound) - i]
w = wave.open(os.path.join(HERE, 'sound', take + '.wav'), 'wb')
w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes(sound.tobytes()); w.close()
if info.get('still'):
    print(f'{take}: sound only'); sys.exit()

frames = {}
for path in glob.glob(f'{OUT}/{take}_*-*.png'):
    first, k = (int(v) for v in re.search(r'_(\d+)-(\d+)\.png$', path).groups())
    frames[first + k - 1] = path
have = sorted(frames)
if not have: sys.exit(f'{take}: no frames')
lines = []
for i in range(length):
    j = i if i in frames else min(have, key=lambda h: abs(h - i))
    lines += [f"file '{frames[j]}'", f'duration {1 / FPS:.6f}']
lines.append(f"file '{frames[j]}'")
listing = f'{OUT}/{take}.txt'
open(listing, 'w').write('\n'.join(lines))
subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listing, '-vf', f'fps={FPS}', '-c:v', 'libx264', '-crf', '15', '-preset', 'medium',
                '-pix_fmt', 'yuv420p', '-g', '1', os.path.join(HERE, f'../clips/street-{take}.mp4')], check=True)
print(f'{take}: {len(have)} frames filmed of {length}')
