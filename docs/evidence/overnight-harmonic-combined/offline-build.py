"""Reuse the recorded offline inputs; capture only current harmonic source profiles."""
import importlib
import importlib.util
import json
from pathlib import Path
import runpy
import sys
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
OUT = Path(__file__).resolve().parent
runpy.run_path(str(ROOT / 'docs/evidence/overnight-combined/offline-build.py'), run_name='offline_setup')

if __name__ == '__main__':
    stage = sys.argv[1]
    sys.argv = [stage, *sys.argv[2:]]
    if stage == 'layers':
        import layers
        layers.assemble('centrum', strict=True)
    elif stage == 'ipr_terrain':
        import structures
        spec = importlib.util.spec_from_file_location('profile_capture', ROOT / 'docs/evidence/overnight-bridges/offline-profile-build.py')
        capture = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(capture)
        original = structures.build
        def traced(*args, **kwargs):
            with patch.object(structures, 'build', original):
                result, frame = capture.capture(structures, 'harmonic-current', args, kwargs)
            (OUT / 'source-profiles-current.json').write_text(json.dumps(frame, indent=2, allow_nan=False) + '\n')
            return result
        structures.build = traced
        importlib.import_module(stage).main()
    else:
        importlib.import_module(stage).main()
