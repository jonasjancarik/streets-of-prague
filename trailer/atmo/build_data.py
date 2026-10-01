#!/usr/bin/env python3
"""Writes ../src/atmo_data.rs for the cut: the timeline's segments, the car's speed, the
engine's revs and gears (engine.json, from engine.js), the camera's height through the
pull back, the map pictures' places and what the map holds (stats.json, from map.py)."""
import json, os

HERE = os.path.dirname(os.path.abspath(__file__))
TL = json.load(open(os.path.join(HERE, 'timeline.json')))
ENGINE = json.load(open(os.path.join(HERE, 'engine.json')))
STATS = json.load(open(os.path.join(HERE, 'stats.json')))
CAPTIONS = {
    'quiet-01': ('05:40', 'PETŘÍN'), 'quiet-02': ('06:20', 'STAROMĚSTSKÉ NÁMĚSTÍ'), 'quiet-03': ('08:00', 'VLTAVA'),
    'quiet-04': ('10:30', 'LETNÁ'), 'quiet-05': ('13:00', 'NÁRODNÍ DIVADLO'), 'quiet-06': ('16:00', 'RUDOLFINUM'),
    'quiet-07': ('18:40', 'MALÁ STRANA'), 'quiet-08': ('19:50', 'OBECNÍ DŮM'), 'quiet-09': ('21:00', 'KARLŮV MOST'),
    'quiet-10': ('22:30', 'STARÉ MĚSTO'),
}
KINDS = ['open', 'quiet', 'engine', 'rush', 'dark', 'rise', 'title']

def arr(name, kind, values, fmt):
    return f'pub const {name}: [{kind}; {len(values)}] = [{", ".join(fmt(v) for v in values)}];\n'

out = '// Made by atmo/build_data.py from timeline.json, engine.json and stats.json: change those, not this.\n\n'
out += f'pub const FRAMES: usize = {TL["frames"]};\npub const FILMED: usize = {TL["filmed"]};\npub const REDLINE: f32 = {ENGINE["redline"]}.0;\n'
out += f'pub const RISE_AT: (f32, f32) = ({TL["rise"]["x"]}, {TL["rise"]["y"]});\n'
out += '/// kind (0 open, 1 quiet, 2 engine, 3 rush, 4 dark, 5 rise, 6 title), first frame, frames, clip, first engine frame, time, place\n'
out += f'pub const SEGMENTS: [(u8, usize, usize, &str, usize, &str, &str); {len(TL["segments"])}] = [\n'
for s in TL['segments']:
    time, place = CAPTIONS.get(s.get('shot', ''), ('', ''))
    clip = f'{s["shot"]}.mp4' if 'shot' in s else ''
    out += f'    ({KINDS.index(s["kind"])}, {s["start"]}, {s["frames"]}, "{clip}", {s.get("engineStart", 0)}, "{time}", "{place}"),\n'
out += '];\n'
out += arr('SPEED', 'f32', TL['speed'], lambda v: f'{v:.2f}')
out += arr('REVS', 'f32', ENGINE['revs'][: TL['engineFrames'] + 1], lambda v: f'{v}.0')
out += arr('GEARS', 'u8', ENGINE['gears'][: TL['engineFrames'] + 1], str)
out += arr('HEIGHT', 'f32', TL['height'], lambda v: f'{v:.2f}')
out += '/// file, left edge and top edge (m), width and height (m)\n'
out += f'pub const MAPS: [(&str, f32, f32, f32, f32); {len(STATS["levels"])}] = [\n'
for l in STATS['levels']:
    out += f'    ("{l["name"]}.png", {l["x0"]:.1f}, {l["y1"]:.1f}, {l["w"] * l["mpp"]:.1f}, {l["h"] * l["mpp"]:.1f}),\n'
out += '];\n'
out += f'pub const LAMPS: f32 = {STATS["lamps"]}.0;\npub const ROAD_KM: f32 = {STATS["roadKm"]}.0;\npub const BUILDINGS: f32 = {STATS["buildings"]}.0;\npub const KM2: f32 = {STATS["km2"]}.0;\npub const STREETS: f32 = {STATS["streets"]}.0;\n'
open(os.path.join(HERE, '../src/atmo_data.rs'), 'w').write(out)
print('atmo_data.rs written')
