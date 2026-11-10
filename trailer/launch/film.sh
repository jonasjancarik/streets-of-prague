#!/bin/sh
# Films the launch video's shots (names from shots.js; none: all of them) into
# trailer/clips/launch-<shot>.mp4, and their sound into trailer/launch/sound/<shot>.wav.
# Needs the dev server and a Full HD scene server on Ultra:
#   node scripts/scene.mjs serve --graphics ultra --size 1920x1080 --out /tmp/launch-frames
set -e
cd "$(dirname "$0")/../.."
OUT=${OUT:-/tmp/launch-frames}
PORT=${PORT:-5199}
# (The shots of both cuts: see plan.py.)
[ $# -gt 0 ] || set -- castle square getin tram heli mikulas autumn rain chase rise
mkdir -p trailer/launch/sound trailer/clips
for shot in "$@"; do
  frames=$(python3 -c "import json; p=json.load(open('trailer/launch/plan.json')); print(p['filmed'] + 12 if '$shot' == 'rise' else p['shots'].get('$shot') or $((${SECONDS_OF:-3} * 30 + 12)))")
  rm -f "$OUT/$shot"-*.png "$OUT/$shot.wav"
  # (scene.mjs eval loses long answers through a pipe: the answer is short.)
  node scripts/scene.mjs eval --port "$PORT" "const SHOT = '$shot', FRAMES = $frames, PLAN = $(cat trailer/launch/plan.json); $(cat trailer/launch/lib.js trailer/launch/shots.js); return { ...(await SHOTS[SHOT]()), where: t.where().street };" | grep -v "screenshot:" | tr '\n' ' '
  echo
  ffmpeg -y -loglevel error -framerate 30 -i "$OUT/$shot-%04d.png" -c:v libx264 -crf 14 -preset slow -pix_fmt yuv420p -g 1 "trailer/clips/launch-$shot.mp4"
  cp "$OUT/$shot.wav" "trailer/launch/sound/$shot.wav"
  echo "$shot: $(ls "$OUT" | grep -c "^$shot-[0-9]*\.png") frames"
done
