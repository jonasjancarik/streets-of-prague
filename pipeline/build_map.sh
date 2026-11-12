#!/usr/bin/env bash
# Build one area's map, from nothing or on top of an earlier build, into
# public/data/<area>_now. Every step in order; see "Building the map" in
# docs/handbook.md for what each does.
#
#   pipeline/build_map.sh ujezd            # a few streets under Petřín: start here
#   pipeline/build_map.sh centrum          # the historic centre
#   pipeline/build_map.sh praha            # the whole city (hours, tens of GB)
#   pipeline/build_map.sh ujezd --quick    # without the photo mesh's colours and the landmarks
#
# --quick leaves out the two steps that read IPR's photorealistic mesh: the roof and
# wall colours (mesh_colours.py; for praha a night's run and many GB) and the
# landmarks (landmarks.py; needs Blender). The map then differs from the public one
# in those colours and has no landmarks.
set -euo pipefail

area=${1:-}
quick=0
[[ ${2:-} == --quick ]] && quick=1
case $area in
  ujezd|centrum|praha) ;;
  *) echo "usage: $0 ujezd|centrum|praha [--quick]" >&2; exit 2 ;;
esac
cd "$(dirname "$0")"

started=$SECONDS
run() {
  echo
  echo "==> $*"
  local t=$SECONDS
  "$@"
  echo "    done in $((SECONDS - t)) s"
}

run uv run fetch_sources.py
run uv run build_parking.py "$area"

# The layers, kept in .cache/layers/<area>/; --resume skips what is already up to date.
run uv run build_tiles.py "$area" --resume --no-assemble
run uv run ipr_buildings.py "$area" --resume --no-assemble
if (( !quick )); then
  # (Reads the sheets ipr_buildings.py has just parsed; ipr_buildings.py then runs
  # again to put the colours in.)
  run uv run mesh_colours.py "$area" --resume
  run uv run ipr_buildings.py "$area" --resume --no-assemble
fi
run uv run ipr_terrain.py "$area" --resume --no-assemble
run uv run --group cover ground_cover.py build "$area" --no-assemble
run uv run ipr_greenery.py build "$area" --no-assemble
run uv run ipr_utility.py build "$area" --no-assemble
if [[ $area == praha ]]; then
  run uv run --group cover young_woods.py build "$area" --no-assemble
  # The tree sizes are measured on the assembled tiles, so assemble once before them.
  run uv run layers.py "$area"
  run uv run --group cover tree_sizes.py build "$area" --no-assemble
fi
# Puts the tiles together and refuses if any layer is out of date.
run uv run layers.py "$area" --strict

# The area's other files.
for step in build_signals build_river build_lines build_metro build_buses build_footfall \
            build_lamps build_bikes build_terraces build_districts; do
  run uv run "$step.py" "$area"
done
if (( !quick )); then
  run uv run landmarks.py "$area"
fi

echo
echo "Built $area in $(( (SECONDS - started) / 60 )) min: public/data/${area}_now"
echo "Check it:  node scripts/check-data-format.mjs public/data"
echo "Play it:   npm run dev, then http://localhost:5191/?area=$area"
