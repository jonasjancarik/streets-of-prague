#!/usr/bin/env python3
"""The city as a night map, for the pull back at the end of the atmospheric trailer:
three pictures, each wider and coarser than the last, of the streets, the water, the
parks and (in the closest) the buildings, with every street lamp of the utility map as
a point of light. Also counts what the map holds (stats.json), for the closing numbers.
Reads public/data/praha_now; takes a minute or two."""
import gzip, json, os, struct, sys
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, '../../public/data/praha_now')
OUT = os.path.join(HERE, '../media')
TL = json.load(open(os.path.join(HERE, 'timeline.json')))
CX, CY = TL['rise']['x'], TL['rise']['y']

# name, centre (m), size (m), metres a pixel, with buildings
LEVELS = [
    ('map-near', (CX, CY), (2800, 1700), 0.5, True),
    ('map-mid', (-2000, 1500), (21000, 12600), 4.0, False),
    ('map-city', (-42, 28), (36000, 27000), 8.0, False),
]
SS = 2  # drawn this many times larger, then scaled down

BG, WATER, PARK, BLOCK, EDGE = (9, 11, 16), (16, 25, 42), (14, 24, 18), (24, 26, 33), (38, 41, 50)
ROAD = {'motorway': 78, 'trunk': 78, 'primary': 70, 'secondary': 62, 'tertiary': 54}
WIDTH = {'motorway': 14, 'trunk': 12, 'primary': 11, 'secondary': 9, 'tertiary': 8}

def load(path):
    raw = open(path, 'rb').read()
    return json.loads(gzip.decompress(raw) if raw[:2] == b'\x1f\x8b' else raw)

index = load(os.path.join(DATA, 'index.json'))
tiles = index['tiles']
print(f'{len(tiles)} tiles', file=sys.stderr)

class Canvas:
    def __init__(self, name, centre, size, mpp, buildings):
        self.name, self.mpp, self.buildings = name, mpp, buildings
        self.w, self.h = round(size[0] / mpp), round(size[1] / mpp)
        self.x0, self.y1 = centre[0] - size[0] / 2, centre[1] + size[1] / 2
        self.box = (self.x0, centre[1] - size[1] / 2, centre[0] + size[0] / 2, self.y1)
        self.img = Image.new('RGB', (self.w * SS, self.h * SS), BG)
        self.d = ImageDraw.Draw(self.img)
        self.k = SS / mpp
    def pt(self, p):
        return ((p[0] - self.x0) * self.k, (self.y1 - p[1]) * self.k)
    def hits(self, box):
        return box[0] < self.box[2] and box[2] > self.box[0] and box[1] < self.box[3] and box[3] > self.box[1]
    def poly(self, rings, fill, outline=None):
        if len(rings[0]) >= 3:
            self.d.polygon([self.pt(p) for p in rings[0]], fill=fill, outline=outline)
        for hole in rings[1:]:
            if len(hole) >= 3: self.d.polygon([self.pt(p) for p in hole], fill=BG)
    def line(self, pts, grey, metres):
        w = max(1, round(max(metres * self.k, 1.1 * SS)))
        self.d.line([self.pt(p) for p in pts], fill=(grey, grey + 2, grey + 8), width=w, joint='curve')

# With a name and a point (map.py map-street -3682 2156): only the closest picture, round that
# point, under that name (for another trailer's pull back), and its place printed instead of the counts.
ONLY = sys.argv[1:4] if len(sys.argv) >= 4 else None
if ONLY: LEVELS = [(ONLY[0], (float(ONLY[1]), float(ONLY[2])), (2800, 1700), 0.5, True)]
canvases = [Canvas(*l) for l in LEVELS]
seen, km, named, built, trees = set(), 0.0, set(), set(), 0
roads = [[] for _ in canvases]
WATERS = ('water', 'river', 'riverbank', 'basin', 'reservoir')
PARKS = ('park', 'wood', 'garden', 'pitch', 'orchard', 'dtm_green', 'dtm_wood', 'dtm_garden', 'dtm_pitch')
kinds = set()

for n, tile in enumerate(tiles):
    name = tile if isinstance(tile, str) else f'{tile[0]}_{tile[1]}'
    path = os.path.join(DATA, 'tiles', f'{name}.json')
    if not os.path.exists(path): continue
    t = load(path)
    box = t['box']
    use = [c for c in canvases if c.hits(box)]
    trees += len(t.get('trees') or [])
    for b in t.get('buildings') or []: built.add(b.get('id') or id(b))
    for kind, polys in (t.get('areas') or {}).items():
        kinds.add(kind)
        fill = WATER if kind in WATERS else PARK if kind in PARKS else None
        if fill:
            for c in use:
                for rings in polys: c.poly(rings, fill)
    for c in use:
        if c.buildings:
            for b in t.get('buildings') or []:
                c.poly(b['rings'], BLOCK, EDGE)
    for e in t.get('drive') or []:
        pts = e['pts']
        # (A two-way street is an edge each way: counted once.)
        key = (min(e['u'], e['v']), max(e['u'], e['v']), e['id'].split('>')[-1])
        if key not in seen:
            seen.add(key)
            km += sum(((pts[i][0] - pts[i - 1][0]) ** 2 + (pts[i][1] - pts[i - 1][1]) ** 2) ** 0.5 for i in range(1, len(pts))) / 1000
            if e.get('name'): named.add(e['name'])
        for i, c in enumerate(use):
            roads[canvases.index(c)].append((e['hw'], pts, e.get('width') or 7))
    if n % 2000 == 0: print(n, file=sys.stderr)

print('area kinds:', sorted(kinds), file=sys.stderr)
# Roads over everything else, the main ones last and lightest.
for c, list_ in zip(canvases, roads):
    list_.sort(key=lambda r: ROAD.get(r[0], 44))
    for hw, pts, width in list_:
        if c.mpp >= 8 and hw not in ROAD and hw not in ('residential', 'unclassified', 'living_street'): continue
        c.line(pts, ROAD.get(hw, 44), WIDTH.get(hw, width) if c.mpp > 1 else width)

# The lamps: light added up in a float picture, blurred a little, laid over the map.
raw = gzip.decompress(open(os.path.join(DATA, 'lamps.bin.gz'), 'rb').read())
count = struct.unpack('<I', raw[:4])[0]
xy = np.frombuffer(raw, dtype='<f4', count=count * 2, offset=4).reshape(-1, 2)
WARM = np.array([255, 196, 128], dtype=np.float32)
for c in canvases:
    base = c.img.resize((c.w, c.h), Image.LANCZOS)
    px = ((xy[:, 0] - c.x0) / c.mpp).astype(np.int32)
    py = ((c.y1 - xy[:, 1]) / c.mpp).astype(np.int32)
    ok = (px >= 0) & (px < c.w) & (py >= 0) & (py < c.h)
    light = np.zeros((c.h, c.w), dtype=np.float32)
    np.add.at(light, (py[ok], px[ok]), 1.0)
    # A lamp is a couple of metres of glow close up, a point from far away, with a faint
    # halo round it. (Blurred as numbers: 8 bits lose a single lamp spread over many pixels.)
    def blur(sigma):
        r = max(1, int(sigma * 3 + 0.5))
        k = np.exp(-0.5 * (np.arange(-r, r + 1) / sigma) ** 2)
        k /= k.sum()
        a = np.apply_along_axis(lambda m: np.convolve(m, k, mode='same'), 1, light)
        a = np.apply_along_axis(lambda m: np.convolve(m, k, mode='same'), 0, a)
        return a * (2 * np.pi * sigma * sigma)  # one lamp alone peaks at 1
    core, halo = max(0.55, 1.3 / c.mpp), max(1.5, 7.0 / c.mpp)
    glow = np.clip(blur(core), 0, 1.3) * 0.85 + np.clip(blur(halo), 0, 2.5) * 0.16
    out = np.asarray(base, dtype=np.float32) + glow[:, :, None] * WARM[None, None, :]
    # The widest picture ends in the dark: its edges fade into the background over 1.5 km.
    if c is canvases[-1]:
        edge = 1500 / c.mpp
        fx = np.clip(np.minimum(np.arange(c.w), c.w - 1 - np.arange(c.w)) / edge, 0, 1)
        fy = np.clip(np.minimum(np.arange(c.h), c.h - 1 - np.arange(c.h)) / edge, 0, 1)
        f = (fy[:, None] * fx[None, :]) ** 1.5
        out = np.array(BG, dtype=np.float32)[None, None, :] * (1 - f[:, :, None]) + out * f[:, :, None]
    Image.fromarray(np.clip(out, 0, 255).astype(np.uint8)).save(os.path.join(OUT, c.name + '.png'), optimize=True)
    print(c.name, c.w, c.h, int(ok.sum()), 'lamps', file=sys.stderr)

if ONLY:
    c = canvases[0]
    print(json.dumps({'name': c.name, 'x0': c.x0, 'y1': c.y1, 'w': c.w, 'h': c.h, 'mpp': c.mpp}))
    sys.exit()
names = json.load(open(os.path.join(DATA, 'names.json')))
stats = {
    'tiles': len(tiles), 'km2': round(len(tiles) * (index['tile'] / 1000) ** 2), 'roadKm': round(km), 'streets': len(names),
    'lamps': int(count), 'buildings': len(built), 'trees': trees,
    'levels': [{'name': c.name, 'x0': c.x0, 'y1': c.y1, 'w': c.w, 'h': c.h, 'mpp': c.mpp} for c in canvases],
}
json.dump(stats, open(os.path.join(HERE, 'stats.json'), 'w'), indent=1)
print(json.dumps({k: v for k, v in stats.items() if k != 'levels'}))
