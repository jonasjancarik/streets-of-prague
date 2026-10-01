#!/bin/sh
# Films shots of the atmospheric trailer (names from shots.js; none: all of them) and
# encodes each into trailer/clips/. Needs the dev server and a Full HD scene server:
#   node scripts/scene.mjs serve --graphics ultra --size 1920x1080 --out /tmp/trailer-frames
cd "$(dirname "$0")/../.."
OUT=/tmp/trailer-frames
[ $# -gt 0 ] || set -- $(python3 -c "import json; print(' '.join(s['shot'] for s in json.load(open('trailer/atmo/timeline.json'))['segments'] if 'shot' in s))")
for name in "$@"; do
  rm -f "$OUT/$name"-*.png
  node scripts/scene.mjs eval "const NAME = '$name', TL = $(cat trailer/atmo/timeline.json); $(cat trailer/atmo/lib.js) $(cat trailer/atmo/shots.js)" | grep -v "screenshot:" | tr '\n' ' '
  n=$(ls "$OUT" | grep -c "^$name-")
  [ "$n" -gt 0 ] && ffmpeg -y -loglevel error -framerate 30 -i "$OUT/$name-%04d.png" -c:v libx264 -crf 15 -preset medium -pix_fmt yuv420p -g 1 "trailer/clips/$name.mp4"
  echo "$name: $n frames"
done
