"""Replay the normal pipeline offline against a private raw-source snapshot."""
import importlib
import json
import os
from pathlib import Path
import sys
import urllib.request
import requests

ROOT = Path('/Users/janca/.codex/worktrees/overnight-city-integration/streets-of-prague')
sys.path.insert(0, str(ROOT / 'pipeline'))
import dtm

for relative in ['pipeline/.cache', 'public/data/centrum_now', 'pipeline/.venv']:
    folder = ROOT / relative
    if folder.is_symlink() or not folder.resolve().is_relative_to(ROOT):
        raise RuntimeError(f'Private writable input required: {folder}')
if len(list(dtm.PACKAGES.glob('*.zip'))) != 57 or len(list((dtm.CACHE / 'ZPS_KR').glob('*.zip'))) != 57:
    raise RuntimeError('Expected the recorded 57 surface and 57 line packages')
for relative in ['public/data/centrum_parking.json', 'pipeline/.cache/osm/combined-input.osm.pbf', 'pipeline/.cache/trees/trees.json', 'pipeline/.cache/mesh_colours/centrum.json.gz']:
    if not (ROOT / relative).is_file():
        raise RuntimeError(f'Missing recorded validation input: {relative}')

def no_network(*args, **kwargs):
    raise RuntimeError('Combined validation uses only the cloned source snapshot; network acquisition is disabled')

# Refresh/download is not geometry processing. Freeze the supplied source snapshot
# rather than fetching a new district release or deleting cached source packages.
def supplied_dtm():
    print(f'OFFLINE: using {len(list(dtm.PACKAGES.glob("*.zip")))} supplied DTM packages', flush=True)

dtm.download = supplied_dtm
urllib.request.urlopen = no_network
requests.sessions.Session.request = no_network
os.environ['OSM_PBF'] = str(ROOT / 'pipeline/.cache/osm/combined-input.osm.pbf')

if __name__ == '__main__':
    stage = sys.argv[1]
    sys.argv = [stage, *sys.argv[2:]]
    if stage == 'layers':
        import layers
        layers.assemble('centrum', strict=True)
    else:
        importlib.import_module(stage).main()
