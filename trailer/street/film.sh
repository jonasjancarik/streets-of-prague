#!/bin/sh
# Films takes of "the same street" (names from plan.py; none: all of them), the stretches
# of each that the cut uses (needs.json, from cut.py), and puts each take together
# (assemble.py): trailer/clips/street-<take>.mp4 and trailer/street/sound/<take>.wav.
# VARIANT=top ./film.sh films the straight-down version (clips/top-<take>.mp4).
# SOUND_ONLY=true ./film.sh records the takes' sound again without filming them;
# PICTURE_ONLY=true films without the sound (it is the same in both versions).
# Needs the dev server and a Full HD scene server on Ultra:
#   node scripts/scene.mjs serve --graphics ultra --size 1920x1080 --out /tmp/trailer-frames
cd "$(dirname "$0")/../.."
OUT=/tmp/trailer-frames
VARIANT=${VARIANT:-street}
[ $# -gt 0 ] || set -- $(python3 -c "import json; print(' '.join(t['name'] for t in json.load(open('trailer/street/plan.json'))['takes']))")
heights=$(python3 -c "import json; t=json.load(open('trailer/atmo/timeline.json')); print(json.dumps({'height': t['height'], 'filmed': t['filmed']}))")
for take in "$@"; do
  [ -n "$PICTURE_ONLY" ] || rm -f "$OUT/$take"_*.wav
  [ -n "$SOUND_ONLY" ] || rm -f "$OUT/$VARIANT-$take"_*.png
  ranges=$(python3 -c "import json; print(json.dumps(json.load(open('trailer/street/needs.json')).get('$take')))")
  [ "$ranges" = "null" ] && ranges="undefined"
  node scripts/scene.mjs eval "const TAKE = '$take', VARIANT = '$VARIANT', PICTURE_ONLY = ${PICTURE_ONLY:-false}, SOUND_ONLY = ${SOUND_ONLY:-false}, HEIGHTS = $heights, RANGES = $ranges, PLAN = $(cat trailer/street/plan.json), PATH = $(cat trailer/street/path.json); $(cat trailer/street/lib.js)" | grep -v "screenshot:" | tr '\n' ' '
  echo
  python3 trailer/street/assemble.py "$take" "$VARIANT"
done
