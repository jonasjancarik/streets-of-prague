#!/usr/bin/env bash
# Publish the app as a Worker: the game's static files, and deploy/worker.js, which takes
# in the anonymous statistics (docs/telemetry.md). Map data is uploaded to R2 separately.
# Usage: scripts/deploy-cloudflare.sh [--dry-run]   (--dry-run builds and checks, deploys nothing)
set -euo pipefail
cd "$(dirname "$0")/.."
if ! git diff --quiet HEAD; then
  echo 'Commit source changes before deploying.' >&2
  exit 1
fi
VERSION=$(tr -d '\n' < deploy/data-version)
DATA_URL=https://streets-data.jonasjancarik.cz/$VERSION/
# The map must be there and in the format this code reads.
node scripts/check-data-format.mjs "$DATA_URL"
npm run typecheck
# Cloudflare Web Analytics counts visits when its site token is in this file (optional).
BEACON=
if [[ -f deploy/web-analytics-token ]]; then BEACON=$(tr -d '\n' < deploy/web-analytics-token); fi
VITE_TELEMETRY_URL=/t VITE_CF_BEACON_TOKEN=$BEACON VITE_DATA_URL=$DATA_URL VITE_DATA_VERSION=$VERSION node --input-type=module -e "import { build } from 'vite'; await build({ publicDir: false, build: { outDir: 'dist-cf' } })"
(cd public && git ls-files -z) | rsync -a --from0 --files-from=- public/ dist-cf/
cat > dist-cf/_headers <<'HEADERS'
/assets/*
  Cache-Control: public, max-age=31536000, immutable
HEADERS

# cf's Build Output keeps the deployment byte-for-byte equal to this build.
if [[ -d .cloudflare/output ]]; then trash .cloudflare/output; fi
OUTPUT=.cloudflare/output/v0
mkdir -p "$OUTPUT/workers/default/assets" "$OUTPUT/workers/default/bundle"
cat > "$OUTPUT/config.json" <<'CONFIG'
{"accountId":"7756b12931ecfb3900a31049e157d706","buildContext":{"isPreview":false}}
CONFIG
cat > "$OUTPUT/workers/default/worker.config.json" <<'CONFIG'
{"name":"streets-of-prague","compatibilityDate":"2026-10-01","workersDev":true,"domains":["streets.jonasjancarik.cz","streets-cf.jonasjancarik.cz"],"assets":{},"env":{"TELEMETRY":{"type":"analytics-engine-dataset","name":"streets_telemetry"}},"manifest":{"type":"complete","mainModule":"worker.js","modules":{"worker.js":{"type":"esm"}}}}
CONFIG
rsync -a dist-cf/ "$OUTPUT/workers/default/assets/"
cp deploy/worker.js "$OUTPUT/workers/default/bundle/worker.js"
printf 'Cloudflare app data: %s\n' "$DATA_URL"
export CLOUDFLARE_ACCOUNT_ID=7756b12931ecfb3900a31049e157d706
cf deploy --prebuilt --dry-run
[[ ${1:-} == --dry-run ]] || cf deploy --prebuilt
