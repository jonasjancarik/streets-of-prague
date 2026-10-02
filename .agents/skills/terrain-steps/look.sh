#!/bin/bash
# look.sh <file.js> [tag]: look.mjs on a scene server brought up for it and stopped again
# (a server left running is killed after half an hour by some harnesses, mid-job).
# GAME_URL: this checkout's dev server if it isn't on 5191. Check it first: another
# checkout's server on 5191 shows another map, and every picture is then of the wrong game
# (curl $GAME_URL/data/praha_now/index.json must show this checkout's "built").
cd "$(dirname "$0")/../../.."
log=$(mktemp)
port=${SCENE_PORT:-5197}  # (not the default 5199: another session may have a scene server there)
node scripts/scene.mjs stop --port $port > /dev/null 2>&1
node scripts/scene.mjs serve --port $port --size 1400x900 --url "${GAME_URL:-http://localhost:5191/}" > "$log" 2>&1 &
until grep -q "Scene server on port\|ERR_\|Error:" "$log"; do sleep 2; done
node .agents/skills/terrain-steps/look.mjs "$1" "${2:-x}" --port $port
node scripts/scene.mjs stop --port $port > /dev/null 2>&1
