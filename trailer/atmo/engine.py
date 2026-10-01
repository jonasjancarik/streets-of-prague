#!/usr/bin/env python3
"""Renders the engine with the game's own engine sound (engine.js, run in the game through
the scene server) and writes engine.wav and engine.json (revs and gear at each frame)."""
import base64, json, os, subprocess, wave

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, '../..')
code = f"const TL = {open(os.path.join(HERE, 'timeline.json')).read()}; {open(os.path.join(HERE, 'engine.js')).read()}"
# (Into a file: the runner exits before a pipe has taken all of a long answer.)
tmp = os.path.join(HERE, 'engine.out')
with open(tmp, 'w') as f: subprocess.run(['node', 'scripts/scene.mjs', 'eval', code], cwd=ROOT, stdout=f)
raw = open(tmp).read()
os.remove(tmp)
j = json.loads(raw[raw.index('{') : raw.rindex('}') + 1])
w = wave.open(os.path.join(HERE, 'engine.wav'), 'wb')
w.setnchannels(1); w.setsampwidth(2); w.setframerate(j['sr']); w.writeframes(base64.b64decode(j.pop('pcm'))); w.close()
json.dump(j, open(os.path.join(HERE, 'engine.json'), 'w'))
print(f"engine: {len(j['revs'])} frames, gears {sorted(set(j['gears']))}, peak {j['peak']:.2f}")
