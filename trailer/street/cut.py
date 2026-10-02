#!/usr/bin/env python3
"""The cut of "the same street": which take shows at each frame, the lines of text and
when, then the dark, the pull back and the title. Writes ../src/street_data.rs for the
picture and, with the takes' sound in sound/, ../media/street.wav: the game's own sound
of whichever take is on screen, cut where the picture cuts."""
import json, os, sys, wave
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
PLAN = json.load(open(os.path.join(HERE, 'plan.json')))
ATMO = json.load(open(os.path.join(HERE, '../atmo/timeline.json')))
FPS = PLAN['fps']
TAKES = [t for t in PLAN['takes'] if not t.get('still') and not t.get('rise')]
NAMES = [t['name'] for t in TAKES]
LABELS = {'mist': 'MIST', 'clear': 'CLEAR', 'rain': 'RAIN', 'cloudy': 'OVERCAST', 'storm': 'STORM', 'snow': 'SNOW'}
f = lambda s: round(s * FPS)

# ---- The drive: (from second, takes shown). One take fills the picture; five stand side by side.
cut = [(0, ['dawn']), (11.5, ['morning']), (15.5, ['noon']), (18.5, ['rain']), (21, ['golden']), (23, ['snow']),
       (24.5, ['dusk']), (26, ['night']), (27, ['storm']), (28, ['police'])]
s = 29.0
for name in ['dawn', 'rain', 'night', 'snow', 'golden', 'storm']:
    cut.append((s, [name])); s += 0.5
cut.append((s, ['morning', 'rain', 'golden', 'night', 'snow'])); s += 2.5      # 32 to 34.5
order = ['dusk', 'storm', 'noon', 'police', 'dawn', 'rain', 'night', 'snow', 'golden', 'morning']
k = 0
while s < 37.0 - 1e-6: cut.append((s, [order[k % 10]])); s += 8 / FPS; k += 1
while s < 39.2 - 1e-6: cut.append((s, [order[k % 10]])); s += 4 / FPS; k += 1
while s < 40.0 - 1e-6: cut.append((s, [order[k % 10]])); s += 2 / FPS; k += 1
DRIVE = PLAN['routeFrames']
DARK, RISE, TITLE = f(2.6), len(ATMO['height']) - 1, f(5.5)
segments = [(f(a), (f(cut[i + 1][0]) if i + 1 < len(cut) else DRIVE), takes) for i, (a, takes) in enumerate(cut)]
segments = [seg for seg in segments if seg[1] > seg[0]]

# ---- The lines: from, to (seconds of the trailer), English, Czech.
LINES = [
    (0.7, 3.6, 'You know this street.', 'Tuhle ulici znáš.'),
    (12.0, 15.2, 'You’ve driven it a thousand times.', 'Jezdíš tudy pořád.'),
    (18.8, 20.8, 'In the rain.', 'V dešti.'),
    (23.1, 24.4, 'In the snow.', 'Ve sněhu.'),
    (26.05, 26.95, 'Late.', 'Pozdě.'),
    (28.05, 29.4, 'With someone behind you.', 'S někým v zádech.'),
    (40.5, 42.4, 'It was never the same street twice.', 'Nikdy to nebyla stejná ulice.'),
]

# What of each take the cut uses: the stretches of route frames to film (with a little to spare each side).
def needs():
    out = {}
    for a, b, names in segments:
        for n in names: out.setdefault(n, []).append([max(0, a - 20), min(DRIVE, b + 20)])
    for n, spans in out.items():
        spans.sort()
        merged = [spans[0]]
        for a, b in spans[1:]:
            if a - merged[-1][1] < 75: merged[-1][1] = max(merged[-1][1], b)
            else: merged.append([a, b])
        out[n] = merged
    json.dump(out, open(os.path.join(HERE, 'needs.json'), 'w'))
    print('to film:', sum(b - a for v in out.values() for a, b in v), 'frames;', {n: v for n, v in out.items()})

def rust():
    out = '// Made by street/cut.py from plan.json: change those, not this.\n\n'
    # The pull back starts where the route ends: the closest map picture is drawn round that point (atmo/map.py).
    end = json.load(open(os.path.join(HERE, 'path.json')))[-1]
    import subprocess
    near = json.loads(subprocess.run([sys.executable, os.path.join(HERE, '../atmo/map.py'), 'map-street', str(end[0]), str(end[1])], capture_output=True, text=True, check=True).stdout.strip().splitlines()[-1])
    out += f'pub const RISE_AT: (f32, f32) = ({end[0]}, {end[1]});\n'
    out += f'/// The closest map picture: file, left edge and top edge (m), width and height (m)\npub const NEAR: (&str, f32, f32, f32, f32) = ("map-street.png", {near["x0"]:.1f}, {near["y1"]:.1f}, {near["w"] * near["mpp"]:.1f}, {near["h"] * near["mpp"]:.1f});\n'
    out += f'pub const DRIVE: usize = {DRIVE};\npub const DARK: usize = {DARK};\npub const RISE: usize = {RISE};\npub const TITLE: usize = {TITLE};\n'
    out += '/// name (its clip is <version>-<name>.mp4), time of day, weather\n'
    out += f'pub const TAKES: [(&str, &str, &str); {len(TAKES)}] = [\n' + ''.join(f'    ("{t["name"]}", "{t["time"]}", "{LABELS[t["weather"]]}"),\n' for t in TAKES) + '];\n'
    out += '/// first frame, the frame after its last, the takes shown (one, or five side by side; unused slots repeat the first)\n'
    out += f'pub const CUT: [(usize, usize, usize, [usize; 5]); {len(segments)}] = [\n'
    for a, b, takes in segments:
        ids = [NAMES.index(n) for n in takes]
        out += f'    ({a}, {b}, {len(ids)}, [{", ".join(str(i) for i in (ids + ids[:1] * 5)[:5])}]),\n'
    out += '];\n/// first frame, the frame after its last, English, Czech\n'
    out += f'pub const LINES: [(usize, usize, &str, &str); {len(LINES)}] = [\n' + ''.join(f'    ({f(a)}, {f(b)}, "{en}", "{cs}"),\n' for a, b, en, cs in LINES) + '];\n'
    open(os.path.join(HERE, '../src/street_data.rs'), 'w').write(out)
    print(f'street_data.rs: {len(segments)} cuts, {(DRIVE + DARK + RISE + TITLE) / FPS:.1f} s')

BUSES = ['engine', 'tyres', 'horns', 'trams', 'city', 'weather', 'bangs']

def sound():
    """The mix, and the same cut of each bus on its own (export/street/stems), all the
    trailer's length, so the sound can be mixed again elsewhere."""
    SR = 48000
    def read(path):
        if not os.path.exists(path): return None
        w = wave.open(path)
        return np.frombuffer(w.readframes(w.getnframes()), dtype='<i2').astype(np.float64).reshape(-1, 2) / 32768
    whole = {n: read(os.path.join(HERE, 'sound', n + '.wav')) for n in NAMES}
    # Each take evened towards the same loudness first (snow and the dead of night are quieter
    # than rain), though not all the way: the quiet ones stay a little quieter.
    rms = {n: np.sqrt(np.mean(a[np.abs(a).sum(axis=1) > 0] ** 2)) + 1e-9 for n, a in whole.items()}
    mid = np.exp(np.mean([np.log(v) for v in rms.values()]))
    gain = {n: (mid / rms[n]) ** 0.7 for n in NAMES}
    still_whole = read(os.path.join(HERE, 'sound', 'still.wav'))
    still_gain = (mid / (np.sqrt(np.mean(still_whole ** 2)) + 1e-9)) ** 0.7 * 1.3
    total = DRIVE + DARK + RISE + TITLE
    N = int(total / FPS * SR)
    t = np.arange(N) / SR
    X = int(0.006 * SR)   # a short crossfade at each cut, so it doesn't click
    def lay(takes, still):
        mix = np.zeros((N, 2))
        for a, b, names in segments:
            i0, i1 = int(a / FPS * SR), int(b / FPS * SR)
            lead = i0 - max(0, i0 - X)
            piece = sum(takes[n][i0 - lead : i1 + X] * gain[n] for n in names if takes.get(n) is not None) / len(names) ** 0.5
            if isinstance(piece, (int, float)): continue
            env = np.ones(len(piece))
            if lead: env[: 2 * lead] = np.linspace(0, 1, 2 * lead)
            env[-2 * X :] = np.minimum(env[-2 * X :], np.linspace(1, 0, 2 * X))
            mix[i0 - lead : i0 - lead + len(piece)] += piece * env[:, None]
        # The sound swells through the last ten seconds of the drive, then nothing.
        mix *= (1 + 0.9 * np.clip((t - (DRIVE / FPS - 10)) / 10, 0, 1) ** 2)[:, None]
        mix[: int(2.5 * SR)] *= (np.linspace(0, 1, int(2.5 * SR)) ** 1.5)[:, None]
        # Under the pull back and the title: the car standing in the night, coming up slowly.
        if still is not None:
            i0 = int((DRIVE + DARK * 0.5) / FPS * SR)
            n = min(len(still), N - i0)
            env = np.clip(np.arange(n) / (4.0 * SR), 0, 1) * np.clip((n - np.arange(n)) / (3.0 * SR), 0, 1)
            mix[i0 : i0 + n] += still[:n] * env[:, None] * still_gain
        return mix
    def write(path, a):
        w = wave.open(path, 'wb')
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes((np.clip(a, -1, 1) * 32767).astype('<i2').tobytes()); w.close()
    mix = lay(whole, still_whole)
    peak = np.abs(mix).max()
    write(os.path.join(HERE, '../media/street.wav'), np.tanh(mix / peak * 1.6) / np.tanh(1.6) * 0.7)   # gently squeezed, well under full scale
    stems = os.path.join(HERE, '../export/street/stems')
    os.makedirs(stems, exist_ok=True)
    for bus in BUSES:
        takes = {n: read(os.path.join(HERE, 'sound', 'stems', f'{n}.{bus}.wav')) for n in NAMES}
        write(os.path.join(stems, bus + '.wav'), lay(takes, read(os.path.join(HERE, 'sound', 'stems', f'still.{bus}.wav'))) / peak * 1.1)
    write(os.path.join(stems, '_mix.wav'), np.tanh(mix / peak * 1.6) / np.tanh(1.6) * 0.7)
    print(f'street.wav and {len(BUSES)} stems: {N / SR:.1f} s, peak {peak:.3f}, takes {", ".join(f"{n} {20 * np.log10(rms[n]):.0f} dB" for n in NAMES)}')

rust()
needs()
if 'sound' in sys.argv: sound()
