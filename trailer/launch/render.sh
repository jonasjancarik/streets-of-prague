#!/bin/sh
# Renders one cut of the launch video from the filmed clips, in English and in Czech:
#   trailer/launch/render.sh 1      # the first cut → launch.mp4, launch-cs.mp4
#   trailer/launch/render.sh 2      # the second (plan.py) → launch2.mp4, launch2-cs.mp4
# The plan, the sound and the cut's data are made again for that cut first, so the two
# can be rendered one after the other.
set -e
cd "$(dirname "$0")/.."
CUT=${1:-1}
export CUT
name=launch
[ "$CUT" = 1 ] || name="launch$CUT"
python3 launch/plan.py
python3 launch/soundtrack.py
touch src/lib.rs
cargo run --release --bin launch -- render
street/finish.sh out.mp4 "$name.mp4"
cargo run --release --bin launch -- render --czech
street/finish.sh out.mp4 "$name-cs.mp4"
ls -la "$name.mp4" "$name-cs.mp4"
