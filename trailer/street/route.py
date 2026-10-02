#!/usr/bin/env python3
"""The car's path for "the same street", worked out from the map's street network rather
than driven: from the plan's start, straight on at every junction, in the
right-hand lane, smoothed, then stepped along at the plan's speed. Writes path.json:
x, y (the map's metres) and heading (radians) at every frame, which every take follows."""
import gzip, json, math, os

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, '../../public/data/praha_now')
PLAN = json.load(open(os.path.join(HERE, 'plan.json')))
START, WAY = tuple(PLAN['start']), PLAN['bearing']
BOX = (START[0] - 1200, START[1] - 1200, START[0] + 1200, START[1] + 1200)
# How far right of the street's middle line traffic drives (laneOffset in src/network.ts).
def lane(e):
    n, w = e.get('lanes') or 0, e.get('width') or 7
    if e.get('oneway'):
        lanes = max(1, n or 1); lw = w / lanes
        return w / 2 - lw * ((lanes - 1) // 2 + 0.5)
    per = max(1, max(2, n or 2) // 2); lw = w / (2 * per)
    return min(max(lw * (per - 0.5), 1.6), w / 2 - 1)

def load(path):
    raw = open(path, 'rb').read()
    return json.loads(gzip.decompress(raw) if raw[:2] == b'\x1f\x8b' else raw)

index = load(os.path.join(DATA, 'index.json'))
edges = {}
for tile in index['tiles']:
    name = tile if isinstance(tile, str) else f'{tile[0]}_{tile[1]}'
    i, j = (int(v) for v in name.split('_'))
    x0, y0 = i * index['tile'] - index['origin'][0], j * index['tile'] - index['origin'][1]
    if x0 > BOX[2] or x0 + 250 < BOX[0] or y0 > BOX[3] or y0 + 250 < BOX[1]: continue
    path = os.path.join(DATA, 'tiles', f'{name}.json')
    if not os.path.exists(path): continue
    for e in load(path).get('drive') or []:
        if e['hw'] in ('service', 'track', 'pedestrian', 'footway', 'cycleway', 'path'): continue
        edges[e['id']] = e
out = {}
for e in edges.values(): out.setdefault(e['u'], []).append(e)

def bearing(a, b): return math.atan2(b[1] - a[1], b[0] - a[0])
def turn(a, b): return abs((b - a + math.pi) % (2 * math.pi) - math.pi)

# The edge to start on: the nearest one to START that heads the plan's way.
def near(e):
    return min(math.hypot(p[0] - START[0], p[1] - START[1]) for p in e['pts']) + 40 * turn(bearing(e['pts'][0], e['pts'][-1]), WAY)
e = min(edges.values(), key=near)
line, names, length, used = [], [], 0.0, set()
need = sum(PLAN['speed']) / PLAN['fps'] + 60
while e and length < need:
    used.add(e['id'])
    pts = e['pts']
    for k, p in enumerate(pts):
        a, b = pts[max(0, k - 1)], pts[min(len(pts) - 1, k + 1)]
        h = bearing(a, b)
        off = lane(e)
        q = (p[0] + math.sin(h) * off, p[1] - math.cos(h) * off)
        if line: length += math.hypot(q[0] - line[-1][0], q[1] - line[-1][1])
        line.append(q)
    if not names or names[-1] != e.get('name'): names.append(e.get('name'))
    here = bearing(pts[-2], pts[-1])
    nexts = [n for n in out.get(e['v'], []) if n['id'] not in used and n['v'] != e['u']]
    e = min(nexts, key=lambda n: turn(here, bearing(n['pts'][0], n['pts'][1]))) if nexts else None
print('streets:', ' → '.join(str(n) for n in names), f'({length:.0f} m)')

# Smoothed: corners cut twice over, then evenly spaced points with a running mean.
def chaikin(p):
    q = [p[0]]
    for a, b in zip(p, p[1:]):
        q += [(0.75 * a[0] + 0.25 * b[0], 0.75 * a[1] + 0.25 * b[1]), (0.25 * a[0] + 0.75 * b[0], 0.25 * a[1] + 0.75 * b[1])]
    return q + [p[-1]]
def resample(p, step):
    q, carry = [p[0]], 0.0
    for a, b in zip(p, p[1:]):
        d = math.hypot(b[0] - a[0], b[1] - a[1])
        s = step - carry
        while s <= d and d > 0:
            q.append((a[0] + (b[0] - a[0]) * s / d, a[1] + (b[1] - a[1]) * s / d)); s += step
        carry = (carry + d) % step
    return q
line = resample(chaikin(chaikin(line)), 0.5)
W = 16   # ±8 m
smooth = [(sum(p[0] for p in line[max(0, i - W):i + W + 1]) / len(line[max(0, i - W):i + W + 1]), sum(p[1] for p in line[max(0, i - W):i + W + 1]) / len(line[max(0, i - W):i + W + 1])) for i in range(len(line))]

path, s = [], 4.0
for v in PLAN['speed']:
    k = min(len(smooth) - 3, int(s / 0.5)); u = s / 0.5 - k
    a, b = smooth[k], smooth[k + 1]
    path.append([round(a[0] + (b[0] - a[0]) * u, 3), round(a[1] + (b[1] - a[1]) * u, 3), round(bearing(smooth[max(0, k - 2)], smooth[k + 3 if k + 3 < len(smooth) else -1]), 4)])
    s += v / PLAN['fps']
json.dump(path, open(os.path.join(HERE, 'path.json'), 'w'))
print(f'{len(path)} frames, {s:.0f} m, from {path[0][:2]} to {path[-1][:2]}')
