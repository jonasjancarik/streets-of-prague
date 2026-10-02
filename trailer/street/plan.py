#!/usr/bin/env python3
"""The plan of "the same street": one drive along the embankment, filmed again and again
at other hours and in other weather, and cut between them. This writes plan.json: the
route (where it starts, how fast the car goes at each frame), which camera films which
stretch, the takes, and the cut (which take shows at each frame of the trailer)."""
import json, os

FPS = 30
HERE = os.path.dirname(os.path.abspath(__file__))
WAIT = 3.0   # s the car stands before it pulls away (the picture comes up over them)
ROUTE_SECONDS = 37.0 + WAIT
N = round(ROUTE_SECONDS * FPS)

# The car: away gently, town speed by the theatre, faster and faster along the river (m/s).
def speed(i):
    s = i / FPS - WAIT
    if s <= 0: return 0.0
    if s < 6: return 11.5 * (s / 6) ** 1.3
    if s < 20: return 11.5 + 4.0 * (s - 6) / 14
    return 15.5 + 9.5 * ((s - 20) / (ROUTE_SECONDS - WAIT - 20)) ** 1.5

plan = {
    'fps': FPS, 'routeFrames': N,
    # Where the drive starts (the map's metres) and which way (radians, 0 east, counter-clockwise):
    # from Újezd south through Smíchov, towards Anděl. route.py goes straight on from there.
    'start': [-4374.0, 2510.0], 'bearing': -1.5708, 'street': 'ÚJEZD — ŠTEFÁNIKOVA',
    'speed': [round(speed(i), 3) for i in range(N)],
}
# Which camera films which stretch of the route (from this second on).
# Two versions of the same drive: `street` with the camera at an angle, `top` straight down throughout.
plan['cameras'] = {
    'street': [(0, 'wide'), (8.5, 'behind'), (14, 'side'), (19, 'top'), (24, 'front'), (29, 'high'), (34, 'chase')],
    'top': [(0, 'drop'), (8.5, 'follow'), (14, 'cross'), (19, 'spin'), (24, 'lead'), (29, 'river'), (34, 'tight')],
}
# The takes: the same drive at another hour, in other weather (and once with the police behind).
plan['takes'] = [
    {'name': 'dawn', 'time': '05:20', 'weather': 'mist'},
    {'name': 'morning', 'time': '08:30', 'weather': 'clear'},
    {'name': 'noon', 'time': '13:00', 'weather': 'clear'},
    {'name': 'rain', 'time': '16:30', 'weather': 'rain'},
    {'name': 'golden', 'time': '17:50', 'weather': 'clear'},
    {'name': 'dusk', 'time': '18:55', 'weather': 'cloudy'},
    {'name': 'night', 'time': '22:30', 'weather': 'clear'},
    {'name': 'storm', 'time': '23:40', 'weather': 'storm'},
    {'name': 'snow', 'time': '10:00', 'weather': 'snow'},
    {'name': 'police', 'time': '01:30', 'weather': 'clear', 'stars': 3},
    # Sound only: the car standing at night, for under the pull back and the title.
    {'name': 'still', 'time': '23:30', 'weather': 'clear', 'still': 17},
    # The start of the pull back: the car standing where the route ends, the camera rising from it.
    {'name': 'rise', 'time': '23:30', 'weather': 'clear', 'rise': True},
]
json.dump(plan, open(os.path.join(HERE, 'plan.json'), 'w'))
print(f'route {N} frames, top {max(plan["speed"]) * 3.6:.0f} km/h, {sum(plan["speed"]) / FPS:.0f} m')
