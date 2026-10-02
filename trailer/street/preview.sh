#!/bin/sh
# A quick new version of "the same street" to look at: films every take small and at every
# second frame in two games side by side, builds the sound, renders a half-size draft.
# Usage: street/preview.sh [street|top] (which cameras; street by default). About five minutes.
# The scene servers are started if they are not there (and left running for the next go):
# the dev server must be up (PORT=5193 npm run dev, or DEV=http://localhost:5191/).
cd "$(dirname "$0")/../.."
VARIANT=${1:-street}
DEV=${DEV:-http://localhost:5193/}
OUT=/tmp/trailer-preview
mkdir -p "$OUT"
A=5291; B=5292
ping() { curl -s -m 2 -X POST -H 'content-type: application/json' -d '{"cmd":"ping"}' "http://127.0.0.1:$1/" > /dev/null; }
for port in $A $B; do
  ping $port || nohup node scripts/scene.mjs serve --port $port --url "$DEV" --graphics ultra --size 960x540 --jpeg --out "$OUT" > "$OUT/serve-$port.log" 2>&1 &
done
for port in $A $B; do until ping $port; do sleep 1; done; done
start=$(date +%s)
python3 trailer/street/plan.py > /dev/null && python3 trailer/street/route.py && python3 trailer/street/cut.py > /dev/null
# The takes shared out between the two games; the sound is recorded with the angled version only.
[ "$VARIANT" = street ] || export PICTURE_ONLY=true
export PREVIEW=true VARIANT
PORT=$A trailer/street/film.sh dawn noon golden night snow rise > "$OUT/film-a.log" 2>&1 &
PORT=$B trailer/street/film.sh morning rain dusk storm police $([ -n "$PICTURE_ONLY" ] || echo still) > "$OUT/film-b.log" 2>&1 &
wait
grep -hE "^[a-z]+:|rror" "$OUT/film-a.log" "$OUT/film-b.log"
echo "filmed in $(( $(date +%s) - start )) s"
python3 trailer/street/cut.py sound | tail -1 | cut -c1-80
cd trailer && touch src/lib.rs
flags=""; [ "$VARIANT" = top ] && flags="--top"
cargo run --release --bin street -- render --draft $flags $EXTRA 2>&1 | tail -1
mv out.mp4 "preview-$VARIANT.mp4"
echo "preview-$VARIANT.mp4 in $(( $(date +%s) - start )) s"
