#!/bin/sh
# Prints the --eval code for scripts/cull-ab.js; $1 is hidden-draws.js's ARGS (keep is added).
dir=$(dirname "$0")
printf '(async () => { const t = window.__test, __drive = window.__drive, ARGS = { keep: true, ...(%s) }; const res = await (async () => { %s\n})(); %s\nconst { kinds, ...out } = res; return out; })()' "${1:-{\}}" "$(cat "$dir/hidden-draws.js")" "$(cat "$dir/cull-ab.js")"
