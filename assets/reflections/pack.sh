#!/bin/sh
# Packs the street strips the cars mirror (plan 037 phase 2, src/reflections.ts) into
# public/reflections.webp: for each kind of area, in the order of KINDS, the image in
# src/<kind>.png (made with image generation from src/<kind>.prompt.txt: a street at eye
# level, the horizon at the middle, a plain white sky) with its sky cut out (flood-filled
# from the top edge, so white walls stay), from the top down to a little below the
# horizon (62 % of the height, the horizon at 0.806 of the strip: CAR_STRIPS in car.ts),
# 512 × 128, then mirrored end to end so it wraps round 360° without a seam.
#
# usage: sh assets/reflections/pack.sh
set -e
cd "$(dirname "$0")"
tmp=$(mktemp -d)
for k in oldtown tenements estate villas river park country; do
  w=$(magick identify -format %w "src/$k.png"); h=$(magick identify -format %h "src/$k.png")
  fill=""
  for x in 0 $((w / 4)) $((w / 2)) $((w * 3 / 4)) $((w - 1)); do fill="$fill -draw \"alpha $x,0 floodfill\""; done
  eval magick "src/$k.png" -alpha set -fuzz 9% -fill none $fill \
    -crop "${w}x$((h * 62 / 100))+0+0" +repage -resize '512x128!' "$tmp/$k-half.png"
  magick "$tmp/$k-half.png" \( +clone -flop \) +append "$tmp/$k.png"
done
magick "$tmp/oldtown.png" "$tmp/tenements.png" "$tmp/estate.png" "$tmp/villas.png" "$tmp/river.png" "$tmp/park.png" "$tmp/country.png" \
  -append -define webp:alpha-quality=90 -quality 82 ../../public/reflections.webp
rm -r "$tmp"
magick identify ../../public/reflections.webp
ls -l ../../public/reflections.webp
