#!/usr/bin/env bash
# The homepage's pictures and videos, cut from the trailer's clips (trailer/README.md
# says how those are filmed). Its output is in git; run this again
# when the clips or the trailer change.
set -euo pipefail
cd "$(dirname "$0")/.."
CLIPS=trailer/clips OUT=site/media
mkdir -p "$OUT"
TMP=$(mktemp -d)

# One frame of a video as WebP (through cwebp; Homebrew's ffmpeg has no WebP encoder).
still() { # video second width quality name
  ffmpeg -v error -y -ss "$2" -i "$1" -frames:v 1 -vf "scale=$3:-2" "$TMP/still.png"
  cwebp -quiet -q "$4" "$TMP/still.png" -o "$OUT/$5.webp"
}

# One still per clip: name, clip, second.
while read -r name clip at; do
  still "$CLIPS/$clip.mp4" "$at" 1600 78 "$name" < /dev/null
done <<'SHOTS'
park clip-day-drive 2.2
square clip-square 2.2
police clip-police 2.2
dusk street-golden 20
snow street-snow 20
SHOTS

# The picture behind the title: four clips one after another, silent, small enough to
# start at once on a phone. Its first frame is also the still shown until it plays.
ffmpeg -v error -y -nostdin -i "$CLIPS/clip-square.mp4" -i "$CLIPS/clip-day-drive.mp4" -i "$CLIPS/clip-police.mp4" -i "$CLIPS/clip-tram.mp4" \
  -filter_complex "[0:v][1:v][2:v][3:v]concat=n=4:v=1:a=0,scale=1280:-2,fps=24[v]" -map "[v]" \
  -c:v libx264 -preset slow -crf 30 -pix_fmt yuv420p -movflags +faststart -an "$OUT/hero.mp4"
still "$CLIPS/clip-square.mp4" 0.5 1280 70 hero

# The trailer, at a size a static host accepts (Cloudflare: 25 MB a file).
ffmpeg -v error -y -i trailer/release.mp4 -vf scale=1280:-2 -c:v libx264 -preset slow -crf 26 -pix_fmt yuv420p \
  -movflags +faststart -c:a aac -b:a 112k "$OUT/trailer.mp4"
