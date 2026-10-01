#!/usr/bin/env python3
"""The one place the atmospheric trailer's timing lives: quiet shots and bursts of the
engine taking turns, each pair shorter than the last, then darkness and the pull back
to the whole city. Writes timeline.json, which the shots, the sound and the cut read."""
import json, math, os

FPS = 30
HERE = os.path.dirname(os.path.abspath(__file__))

# (quiet seconds, engine seconds): the quiet shrinks faster than the engine does.
PAIRS = [(3.6, 1.7), (3.0, 1.5), (2.6, 1.3), (2.2, 1.2), (1.8, 1.0), (1.4, 0.9), (1.0, 0.8), (0.7, 0.7), (0.5, 0.6), (0.3, 0.6)]
# Then the engine alone, cut between angles: seconds each.
RUSH = [0.5, 0.5, 0.4, 0.4, 0.3, 0.3, 0.3, 0.2, 0.2, 0.2, 0.2, 0.9]
OPEN, DARK, RISE, TITLE = 2.4, 1.6, 9.5, 5.0
TOP = 172 / 3.6  # m/s at the end of the rush

def frames(s):
    return round(s * FPS)

segs, at, engine = [], 0, 0
def add(kind, seconds, **more):
    global at, engine
    n = frames(seconds)
    seg = {'kind': kind, 'start': at, 'frames': n, **more}
    if kind in ('engine', 'rush'):
        seg['engineStart'] = engine
        engine += n
    segs.append(seg)
    at += n

add('open', OPEN)
for i, (q, e) in enumerate(PAIRS):
    add('quiet', q, shot=f'quiet-{i + 1:02d}')
    add('engine', e, shot=f'engine-{i + 1:02d}')
for i, r in enumerate(RUSH):
    add('rush', r, shot=f'rush-{i + 1:02d}')
add('dark', DARK)
add('rise', RISE, shot='rise')
add('title', TITLE)

# The car's speed through all the engine's frames laid end to end: quick off the line,
# then the long pull of the higher gears (m/s, one value a frame).
total = engine
speed = [TOP * (1 - math.exp(-(i / FPS) / 20)) / (1 - math.exp(-(total / FPS) / 20)) for i in range(total + 1)]

# Where the pull back starts: on most Legií, over the river (the map's metres).
RISE_AT = {'lat': 50.08135, 'lon': 14.4122, 'x': -3824.0, 'y': 2412.0}

# The pull back: how high the camera is at each frame of the rise, from just over the car to
# where the whole city fits, slow to start and to settle. The game films the first part
# (as far as FILMED m up), the map pictures take over from there.
LOW, HIGH, FILMED = 22.0, 37000.0, 900.0
n = frames(RISE_SECONDS := RISE)
def ease(u):
    return u * u * u * (u * (6 * u - 15) + 10)
height = [LOW * (HIGH / LOW) ** ease(min(1, i / (n * 0.9))) for i in range(n + 1)]
filmed = next(i for i, h in enumerate(height) if h > FILMED)

json.dump({'fps': FPS, 'rise': RISE_AT, 'height': [round(h, 2) for h in height], 'filmed': filmed, 'frames': at, 'engineFrames': total, 'segments': segs, 'speed': [round(v, 3) for v in speed]},
          open(os.path.join(HERE, 'timeline.json'), 'w'), indent=1)
print(f'{at} frames ({at / FPS:.1f} s), engine {total} frames ({total / FPS:.1f} s), {len(segs)} segments')
