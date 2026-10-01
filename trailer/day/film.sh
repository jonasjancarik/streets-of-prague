#!/bin/sh
# Films "one day": the Old Town Square from one spot while the game's clock runs from
# before dawn to night (24 seconds of film, its last frame held 6 s more for the title), into trailer/clips/day.mp4. Needs the dev
# server and a Full HD scene server on Ultra (see ../README.md).
cd "$(dirname "$0")/../.."
OUT=/tmp/trailer-frames
rm -f "$OUT"/day-*.png
node scripts/scene.mjs eval "$(cat trailer/day/shot.js)" | grep -v "screenshot:"
ffmpeg -y -loglevel error -framerate 30 -i "$OUT/day-%04d.png" -vf tpad=stop_mode=clone:stop_duration=6 -c:v libx264 -crf 15 -preset medium -pix_fmt yuv420p -g 1 trailer/clips/day.mp4
echo "day: $(ls "$OUT" | grep -c '^day-') frames"
