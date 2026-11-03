#!/usr/bin/env python3
"""The launch video: about thirty seconds, every shot from straight above as the game is
played. A morning over the Castle, a car pulling away on Ječná, a tram, a
helicopter over Charles Bridge, St. Nicholas in Malá Strana, a rainy night and a police chase
from the National Theatre onto most Legií; then the dark, the pull back from the car on the bridge to
every street lamp of the city, and the title.

This is the one place the timing lives. Writes plan.json (what film.sh films: each shot's
frames, the camera's height through the rise) and ../src/launch_data.rs (the cut)."""
import json, os

FPS = 30
HERE = os.path.dirname(os.path.abspath(__file__))

# name, seconds on screen, time of day shown, place shown (the same in both languages)
SHOTS = [
    ('castle', 2.8, '09:30', 'PRAŽSKÝ HRAD'),
    ('getin', 2.4, '13:30', 'JEČNÁ'),
    ('tram', 1.8, '19:00', 'MASARYKOVO NÁBŘEŽÍ'),
    ('heli', 2.4, '17:40', 'KARLŮV MOST'),
    ('mikulas', 1.5, '19:20', 'MALÁ STRANA'),
    ('rain', 2.2, '23:20', 'VODIČKOVA'),
    ('chase', 5.0, '01:30', 'MOST LEGIÍ'),
]
DARK, RISE, TITLE = 0.5, 6.0, 3.5
# Filmed a little longer than shown, so a cut can be moved without filming again.
SPARE = 0.4

# The lines: the shot they come in on, seconds into it, seconds shown, English, Czech.
LINES = [
    ('getin', 0.3, 1.6, 'GET IN.', 'NASEDNI.'),
    ('heli', 0.2, 1.7, 'GO ANYWHERE.', 'VYRAŽ KAMKOLI.'),
    ('chase', 0.9, 1.8, 'LOSE THEM.', 'SETŘES JE.'),
]

def frames(s):
    return round(s * FPS)

# The pull back starts on most Legií, where the chase ends, over the river: the same spot as
# the atmospheric trailer's, so its map pictures (atmo/map.py) fit.
RISE_AT = {'lat': 50.08135, 'lon': 14.4122, 'x': -3824.0, 'y': 2412.0}
# The camera's height through the rise, from just over the car to where the whole city fits:
# the game films it as far as FILMED m up, the map pictures take over from there.
LOW, HIGH, FILMED = 22.0, 37000.0, 900.0
n = frames(RISE)
def ease(u):
    return u * u * u * (u * (6 * u - 15) + 10)
height = [LOW * (HIGH / LOW) ** ease(min(1, i / (n * 0.88))) for i in range(n + 1)]
filmed = next(i for i, h in enumerate(height) if h > FILMED)

segs, at = [], 0
for name, seconds, time, place in SHOTS:
    segs.append({'kind': 'shot', 'name': name, 'start': at, 'frames': frames(seconds), 'film': frames(seconds + SPARE), 'time': time, 'place': place})
    at += frames(seconds)
for kind, seconds in [('dark', DARK), ('rise', RISE), ('title', TITLE)]:
    segs.append({'kind': kind, 'name': kind, 'start': at, 'frames': frames(seconds)})
    at += frames(seconds)
TOTAL = at
start = {s['name']: s['start'] for s in segs}
lines = [(start[shot] + frames(after), start[shot] + frames(after + seconds), en, cs) for shot, after, seconds, en, cs in LINES]

# What the map holds, counted by atmo/map.py (stats.json), for the numbers of the pull back.
stats = json.load(open(os.path.join(HERE, '../atmo/stats.json')))

json.dump({'fps': FPS, 'rise': RISE_AT, 'height': [round(h, 2) for h in height], 'filmed': filmed, 'frames': TOTAL,
           'shots': {s['name']: s['film'] for s in segs if s['kind'] == 'shot'}},
          open(os.path.join(HERE, 'plan.json'), 'w'), indent=1)

KIND = {'shot': 0, 'dark': 1, 'rise': 2, 'title': 3}
rs = ['// Made by launch/plan.py: change that, not this.', '',
      f'pub const FRAMES: usize = {TOTAL};',
      f'pub const FILMED: usize = {filmed};',
      f'pub const RISE_AT: (f32, f32) = ({RISE_AT["x"]:.1f}, {RISE_AT["y"]:.1f});',
      '/// kind (0 shot, 1 dark, 2 rise, 3 title), first frame, frames, clip, time, place',
      f'pub const SEGMENTS: [(u8, usize, usize, &str, &str, &str); {len(segs)}] = [']
for s in segs:
    clip = f'launch-{s["name"]}.mp4' if s['kind'] in ('shot', 'rise') else ''
    rs.append(f'    ({KIND[s["kind"]]}, {s["start"]}, {s["frames"]}, "{clip}", "{s.get("time", "")}", "{s.get("place", "")}"),')
rs += ['];', '/// first frame, the frame after its last, English, Czech',
       f'pub const LINES: [(usize, usize, &str, &str); {len(lines)}] = [']
rs += [f'    ({a}, {b}, "{en}", "{cs}"),' for a, b, en, cs in lines]
rs += ['];', f'pub const HEIGHT: [f32; {len(height)}] = [{", ".join(f"{h:.2f}" for h in height)}];',
       f'pub const LAMPS: f32 = {stats["lamps"]:.1f};', f'pub const TREES: f32 = {stats["trees"]:.1f};', f'pub const BUILDINGS: f32 = {stats["buildings"]:.1f};',
       f'pub const ROAD_KM: f32 = {stats["roadKm"]:.1f};', f'pub const KM2: f32 = {stats["km2"]:.1f};', '']
open(os.path.join(HERE, '../src/launch_data.rs'), 'w').write('\n'.join(rs))
print(f'{TOTAL} frames ({TOTAL / FPS:.1f} s), rise filmed for {filmed} frames')
