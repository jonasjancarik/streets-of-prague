#!/bin/sh
# Films the trailer's clips from the running game, frame by frame, and encodes them into trailer/clips/ (not in git; the cut reads them when it runs).
# Needs the dev server and a Full HD scene server on Ultra:
#   node scripts/scene.mjs serve --graphics ultra --size 1920x1080 --out /tmp/trailer-frames
# Usage: trailer/record.sh [shot …] (names from trailer/shots, without the number: day-drive, square, …)
set -e
cd "$(dirname "$0")/.."
OUT=/tmp/trailer-frames
for f in trailer/shots/[0-9]*.js; do
  name=$(basename "$f" .js | cut -d- -f2-)
  if [ $# -gt 0 ] && ! echo " $* " | grep -q " $name "; then continue; fi
  rm -f "$OUT/$name"-*.png
  # (A console error in the page makes the runner exit 1 with the frames already saved: show it and carry on.)
  node scripts/scene.mjs eval "$(cat trailer/shots/_lib.js "$f")" | grep -v "screenshot:" || true
  ffmpeg -y -loglevel error -framerate 30 -i "$OUT/$name-%04d.png" -c:v libx264 -crf 14 -preset slow -pix_fmt yuv420p -g 1 "trailer/clips/clip-$name.mp4"
  echo "$name: $(ls "$OUT" | grep -c "^$name-") frames"
done
