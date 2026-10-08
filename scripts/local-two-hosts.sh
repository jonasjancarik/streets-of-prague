#!/usr/bin/env bash
# The game's Worker on this machine twice over, once as streetsofprague.com and once as
# play.streetsofprague.com, to try the move between the two before anything is deployed
# (scripts/check-two-hosts.mjs runs the checks).
# Builds the game as scripts/deploy-cloudflare.sh does and serves it with `wrangler dev`,
# which tells each copy that it is being asked for at that address. Nothing here logs in
# to Cloudflare or deploys. The map comes from data.streetsofprague.com, as in production.
# Usage: scripts/local-two-hosts.sh [--serve-only]      Ctrl-C stops both
#   --serve-only serves what the last run built.
#   OLD_PORT (5311) answers as streetsofprague.com, PLAY_PORT (5312) as play.streetsofprague.com.
#   GAME_MOVED=yes (the default here) or empty, as in deploy/address.
#   WRANGLER names the wrangler to run (default: npx --yes wrangler@4).
set -euo pipefail
cd "$(dirname "$0")/.."
OLD_PORT=${OLD_PORT:-5311} PLAY_PORT=${PLAY_PORT:-5312} GAME_MOVED=${GAME_MOVED-yes}
WRANGLER=${WRANGLER:-npx --yes wrangler@4}
OUT=.local-hosts
if [[ ${1:-} != --serve-only ]]; then
  if [[ -d $OUT ]]; then trash "$OUT"; fi
  mkdir -p "$OUT"
  VERSION=$(tr -d '\n' < deploy/data-version)
  VITE_SUBSCRIBE_URL=/api/subscribe VITE_FEEDBACK_URL=/api/feedback VITE_TELEMETRY_URL=/api/report \
    VITE_DATA_URL=https://data.streetsofprague.com/$VERSION/ VITE_DATA_VERSION=$VERSION \
    node --input-type=module -e "import { build } from 'vite'; await build({ publicDir: false, logLevel: 'warn', build: { outDir: '$OUT/game' } })"
  (cd public && git ls-files -z) | rsync -a --from0 --files-from=- public/ "$OUT/game/"
  sed -n "/^cat > dist-cf\/_headers <<'HEADERS'$/,/^HEADERS$/p" scripts/deploy-cloudflare.sh | sed '1d;$d' > "$OUT/game/_headers"
  grep -q version.json "$OUT/game/_headers"
  node scripts/write-version-json.mjs "$OUT/game" "$VERSION"
fi
[[ -d $OUT/game ]] || { echo 'Nothing is built yet: run it without --serve-only.' >&2; exit 1; }
# The same settings as wrangler.jsonc, which is what `routes` there would otherwise
# override the address with.
cat > "$OUT/worker.json" <<CONFIG
{
  "name": "streets-of-prague", "compatibility_date": "2026-10-01", "main": "../worker/index.js",
  "assets": { "directory": "./game", "binding": "ASSETS", "run_worker_first": ["/api/*", "/"] },
  "send_email": [{ "name": "EMAIL" }],
  "analytics_engine_datasets": [{ "binding": "TELEMETRY", "dataset": "streets_telemetry" }],
  "ratelimits": [{ "name": "RATE", "namespace_id": "1001", "simple": { "limit": 5, "period": 60 } }],
  "vars": { "GAME_MOVED": "$GAME_MOVED", "FEEDBACK_TO": "author@example.com", "FEEDBACK_FROM": "feedback@example.com" }
}
CONFIG
grep -q '"run_worker_first": \["/api/\*", "/"\]' wrangler.jsonc || { echo 'wrangler.jsonc sends other requests to the Worker than this script does.' >&2; exit 1; }
export WRANGLER_SEND_METRICS=false
trap 'trap - EXIT INT TERM; kill 0' EXIT INT TERM
$WRANGLER dev --config "$OUT/worker.json" --ip 0.0.0.0 --port "$OLD_PORT" --inspector-port 0 --persist-to "$OUT/state-old" --local-upstream streetsofprague.com --upstream-protocol https &
$WRANGLER dev --config "$OUT/worker.json" --ip 0.0.0.0 --port "$PLAY_PORT" --inspector-port 0 --persist-to "$OUT/state-play" --local-upstream play.streetsofprague.com --upstream-protocol https &
echo "As streetsofprague.com: http://localhost:$OLD_PORT   As play.streetsofprague.com: http://localhost:$PLAY_PORT"
wait
