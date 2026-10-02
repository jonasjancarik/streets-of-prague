#!/bin/bash
# look.sh <file.js> [tag]: look.mjs on a scene server brought up for it and stopped again
# (a server left running is killed after half an hour by some harnesses, mid-job).
cd "$(dirname "$0")/../../.."
log=$(mktemp)
node scripts/scene.mjs stop > /dev/null 2>&1
node scripts/scene.mjs serve --size 1400x900 > "$log" 2>&1 &
until grep -q "Scene server on port\|ERR_\|Error:" "$log"; do sleep 2; done
node .agents/skills/terrain-steps/look.mjs "$1" "${2:-x}"
node scripts/scene.mjs stop > /dev/null 2>&1
