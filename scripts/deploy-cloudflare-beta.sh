#!/usr/bin/env bash
# Deploy the current commit to the beta on Cloudflare (https://beta.streetsofprague.com),
# the way production is deployed but with the local map: no release needed.
# The map (public/data) goes to R2 as beta-<id>, where the id is a fingerprint of its
# files, the same as on mbxp: a changed map gets a new name, so open tabs keep the map
# they started with. An unchanged map isn't sent again, and an interrupted upload is
# finished by running this again (nothing is deployed before the upload is checked).
# The game's files are static assets of their own Worker, streets-of-prague-beta; the
# forms and statistics go to production's Worker, as they did from mbxp.
# --dry-run builds and checks everything and deploys nothing (the map is still uploaded).
set -euo pipefail
cd "$(dirname "$0")/.."
[[ -z ${1:-} || ${1:-} == --dry-run ]] || { echo 'Usage: scripts/deploy-cloudflare-beta.sh [--dry-run]' >&2; exit 1; }
git diff --quiet HEAD || { echo 'Commit your changes first.' >&2; exit 1; }
echo "Deploying $(git describe --tags --always) to the beta on Cloudflare."

node scripts/check-data-format.mjs public/data
npm run typecheck
# Paths, sizes and modification times of every file, as scripts/deploy-mbxp.sh has it.
ID=$(cd public/data && find . -type f ! -name .DS_Store -exec stat -f '%N %z %m' {} + | LC_ALL=C sort | shasum -a 256 | cut -c1-12)
VERSION=beta-$ID
DATA_URL=https://data.streetsofprague.com/$VERSION/
REMOTE=${R2_REMOTE:-streets:streets-of-prague-data}
echo "Map data: $VERSION"
# --immutable: files already there must be the same, so a rerun only sends what's missing.
rclone copy public/data/ "$REMOTE/$VERSION" --exclude .DS_Store --checksum --immutable --transfers 32 --checkers 32 \
  --header-upload 'Cache-Control: public, max-age=31536000, immutable' \
  --stats 20s --stats-one-line --log-level NOTICE
rclone check public/data/ "$REMOTE/$VERSION" --exclude .DS_Store --checksum --checkers 32
node scripts/check-data-format.mjs "$DATA_URL"

source deploy/newsletter; source deploy/feedback; source deploy/address
API=https://${GAME_MOVED:+play.}streetsofprague.com/api
if [[ -n ${BREVO_LIST_ID:-} && -n ${BREVO_DOI_TEMPLATE_ID:-} ]]; then export VITE_SUBSCRIBE_URL=$API/subscribe; fi
if [[ -n ${FEEDBACK_TO:-} ]]; then export VITE_FEEDBACK_URL=$API/feedback; fi
if [[ -n ${TURNSTILE_SITE_KEY:-} ]]; then export VITE_TURNSTILE_SITE_KEY=$TURNSTILE_SITE_KEY; fi
OUT=dist-cf-beta
VITE_TELEMETRY_URL=$API/report VITE_DATA_URL=$DATA_URL VITE_DATA_VERSION=$VERSION node --input-type=module -e "import { build } from 'vite'; await build({ publicDir: false, build: { outDir: '$OUT' } })"
(cd public && git ls-files -z) | rsync -a --from0 --files-from=- public/ "$OUT/"
cat > "$OUT/_headers" <<'HEADERS'
/assets/*
  Cache-Control: public, max-age=31536000, immutable
/version.json
  Cache-Control: no-store
HEADERS
node scripts/write-version-json.mjs "$OUT" "$VERSION"

if [[ -d .cloudflare/output ]]; then trash .cloudflare/output; fi
OUTPUT=.cloudflare/output/v0
mkdir -p "$OUTPUT/workers/default/assets"
cat > "$OUTPUT/config.json" <<'CONFIG'
{"accountId":"7756b12931ecfb3900a31049e157d706","buildContext":{"isPreview":false}}
CONFIG
# Assets only: no Worker code runs.
cat > "$OUTPUT/workers/default/worker.config.json" <<'CONFIG'
{"name":"streets-of-prague-beta","compatibilityDate":"2026-10-01","workersDev":true,"domains":["beta.streetsofprague.com"],"env":{"ASSETS":{"type":"assets"}}}
CONFIG
rsync -a "$OUT/" "$OUTPUT/workers/default/assets/"
export CLOUDFLARE_ACCOUNT_ID=7756b12931ecfb3900a31049e157d706
cf deploy --prebuilt --dry-run
[[ ${1:-} == --dry-run ]] || cf deploy --prebuilt
