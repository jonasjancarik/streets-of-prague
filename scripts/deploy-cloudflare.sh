#!/usr/bin/env bash
# Publish the app as a static-assets Worker. Map data is uploaded to R2 separately.
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
VITE_DATA_URL=$DATA_URL VITE_DATA_VERSION=$VERSION node --input-type=module -e "import { build } from 'vite'; await build({ publicDir: false, build: { outDir: 'dist-cf' } })"
(cd public && git ls-files -z) | rsync -a --from0 --files-from=- public/ dist-cf/
cat > dist-cf/_headers <<'HEADERS'
/assets/*
  Cache-Control: public, max-age=31536000, immutable
HEADERS

# cf's Build Output keeps the deployment byte-for-byte equal to this build.
if [[ -d .cloudflare/output ]]; then trash .cloudflare/output; fi
OUTPUT=.cloudflare/output/v0
mkdir -p "$OUTPUT/workers/default/assets"
cat > "$OUTPUT/config.json" <<'CONFIG'
{"accountId":"7756b12931ecfb3900a31049e157d706","buildContext":{"isPreview":false}}
CONFIG
cat > "$OUTPUT/workers/default/worker.config.json" <<'CONFIG'
{"name":"streets-of-prague","compatibilityDate":"2026-10-01","workersDev":true,"domains":["streetsofprague.com","streets.jonasjancarik.cz","streets-cf.jonasjancarik.cz"],"assets":{}}
CONFIG
rsync -a dist-cf/ "$OUTPUT/workers/default/assets/"
printf 'Cloudflare app data: %s\n' "$DATA_URL"
export CLOUDFLARE_ACCOUNT_ID=7756b12931ecfb3900a31049e157d706
cf deploy --prebuilt --dry-run
cf deploy --prebuilt
