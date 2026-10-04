#!/usr/bin/env python3
"""Samples what TSK measured against the buildings round it, for check-parking-demand.mjs.

For every paid-parking section with both occupancies (day and night) and at least 4
spaces, writes its sample points (vertices of its polygons, 25 m apart at least) and the
buildings within 200 m of them, from the built tiles in public/data/praha_now/tiles
(each building once, by the tile that owns it).

    python3 scripts/parking-demand-sample.py [out.json]      (default $TMPDIR/parking-demand.json)
    node scripts/check-parking-demand.mjs [out.json]
"""
import json, math, os, sys, tempfile

AREA = 'public/data/praha_now'
ORIGIN = json.load(open(f'{AREA}/index.json'))['origin']
T = 250.0
cache = {}


def tile(i, j):
    if (i, j) not in cache:
        bs = []
        try:
            d = json.load(open(f'{AREA}/tiles/{i}_{j}.json'))
        except OSError:
            d = None
        for b in (d or {}).get('buildings', []):
            if not b.get('own'):
                continue
            r = b['rings'][0]
            a = cx = cy = 0.0
            for q in range(len(r)):
                x0, y0 = r[q]
                x1, y1 = r[(q + 1) % len(r)]
                c = x0 * y1 - x1 * y0
                a += c; cx += (x0 + x1) * c; cy += (y0 + y1) * c
            a /= 2
            if abs(a) > 1e-6:
                bs.append((cx / (6 * a), cy / (6 * a), abs(a), b['h'], b['kind']))
        cache[(i, j)] = bs
    return cache[(i, j)]


def near(x, y, radius):
    for i in range(int((x - radius + ORIGIN[0]) // T), int((x + radius + ORIGIN[0]) // T) + 1):
        for j in range(int((y - radius + ORIGIN[1]) // T), int((y + radius + ORIGIN[1]) // T) + 1):
            for b in tile(i, j):
                if math.hypot(b[0] - x, b[1] - y) < radius:
                    yield b


out = []
for s in json.load(open('public/data/praha_parking.json'))['sections']:
    if s.get('occDay') is None or s.get('occNight') is None or s['spaces'] < 4:
        continue
    pts = [pt for poly in s['polys'] for pt in poly[0]]
    samples = []
    for x, y in pts:
        if all(math.hypot(x - a, y - b) >= 25 for a, b in samples):
            samples.append((x, y))
    samples = samples[:40]
    seen = {}
    for x, y in samples:
        for b in near(x, y, 200):
            seen[(b[0], b[1])] = b
    out.append(dict(
        code=s['code'], cat=s['category'], spaces=s['spaces'], day=s['occDay'], night=s['occNight'],
        x=sum(a for a, _ in pts) / len(pts), y=sum(b for _, b in pts) / len(pts),
        samp=[[round(a, 1), round(b, 1)] for a, b in samples],
        b=[[round(v[0], 1), round(v[1], 1), round(v[2], 1), round(v[3], 1), v[4]] for v in seen.values()]))
dest = sys.argv[1] if len(sys.argv) > 1 else os.path.join(tempfile.gettempdir(), 'parking-demand.json')
json.dump(out, open(dest, 'w'))
print(f'{len(out)} sections -> {dest}')
