#!/usr/bin/env bash
# Publish the app as a Worker: the game's files as static assets, and worker/index.js
# for the newsletter signup, the feedback form and the anonymous statistics (/api/*).
# Map data is uploaded to R2 separately.
# Production only runs released versions: the commit must be a release tag, which is
# what scripts/release.sh makes before it calls this, and what a rollback checks out.
# --untagged deploys any commit all the same, for an emergency.
# --dry-run builds and checks any commit and deploys nothing.
set -euo pipefail
cd "$(dirname "$0")/.."
[[ ${1:---untagged} == --untagged || ${1:-} == --dry-run ]] || { echo 'Usage: scripts/deploy-cloudflare.sh [--untagged | --dry-run]' >&2; exit 1; }
if ! git diff --quiet HEAD; then
  echo 'Commit source changes before deploying.' >&2
  exit 1
fi
RELEASE=$(git tag -l 'v[0-9]*.[0-9]*.[0-9]*' --points-at HEAD | head -n 1)
if [[ -z $RELEASE && ${1:-} != --untagged && ${1:-} != --dry-run ]]; then
  echo 'This commit is not a release. Run scripts/release.sh patch (or minor, major) to release and deploy it; try it out on the beta with scripts/deploy-mbxp.sh.' >&2
  exit 1
fi
echo "Deploying ${RELEASE:-$(git describe --tags --always), which is not a release}."
VERSION=$(tr -d '\n' < deploy/data-version)
DATA_URL=https://data.streetsofprague.com/$VERSION/
# The map must be there and in the format this code reads.
node scripts/check-data-format.mjs "$DATA_URL"
node scripts/check-data-versions.mjs
npm run typecheck
node scripts/check-worker.mjs
# The newsletter and feedback (deploy/newsletter, deploy/feedback): the game shows each
# form once it is set up.
set -a; source deploy/newsletter; source deploy/feedback; source deploy/address; set +a
if [[ -n ${BREVO_LIST_ID:-} && -n ${BREVO_DOI_TEMPLATE_ID:-} ]]; then export VITE_SUBSCRIBE_URL=/api/subscribe; fi
if [[ -n ${FEEDBACK_TO:-} ]]; then export VITE_FEEDBACK_URL=/api/feedback; fi
if [[ -n ${TURNSTILE_SITE_KEY:-} ]]; then export VITE_TURNSTILE_SITE_KEY=$TURNSTILE_SITE_KEY; fi
# Cloudflare Web Analytics counts visits when its site token is in this file (optional).
BEACON=
if [[ -f deploy/web-analytics-token ]]; then BEACON=$(tr -d '\n' < deploy/web-analytics-token); fi
VITE_TELEMETRY_URL=/api/report VITE_CF_BEACON_TOKEN=$BEACON VITE_DATA_URL=$DATA_URL VITE_DATA_VERSION=$VERSION node --input-type=module -e "import { build } from 'vite'; await build({ publicDir: false, build: { outDir: 'dist-cf' } })"
(cd public && git ls-files -z) | rsync -a --from0 --files-from=- public/ dist-cf/
# version.json says what is current (src/update.ts reads it in open tabs), so it is
# never cached.
cat > dist-cf/_headers <<'HEADERS'
/assets/*
  Cache-Control: public, max-age=31536000, immutable
/version.json
  Cache-Control: no-store
HEADERS
node scripts/write-version-json.mjs dist-cf "$VERSION"

# cf's Build Output keeps the deployment byte-for-byte equal to this build.
if [[ -d .cloudflare/output ]]; then trash .cloudflare/output; fi
OUTPUT=.cloudflare/output/v0
mkdir -p "$OUTPUT/workers/default/assets"
cat > "$OUTPUT/config.json" <<'CONFIG'
{"accountId":"7756b12931ecfb3900a31049e157d706","buildContext":{"isPreview":false}}
CONFIG
mkdir -p "$OUTPUT/workers/default/bundle"
cp worker/index.js worker/stats.js "$OUTPUT/workers/default/bundle/"
# Only /api/* and the page itself (/) run the Worker, the page so that the game's old
# address can send people on to the new one (deploy/address); every other request is
# answered from the assets directly, at every address, and doesn't count as a Worker request.
# BREVO_API_KEY and TURNSTILE_SECRET_KEY are secrets set on the Worker once (the
# player-forms skill), not here. Feedback can only be emailed to the one address named in deploy/feedback.
node -e '
const e = process.env, text = (value) => ({ type: "text", value: value ?? "" });
console.log(JSON.stringify({
  name: "streets-of-prague", compatibilityDate: "2026-10-01", workersDev: true,
  domains: ["streetsofprague.com", "play.streetsofprague.com", "streets.jonasjancarik.cz"],
  assets: { runWorkerFirst: ["/api/*", "/"] },
  manifest: { type: "partial", mainModule: "index.js", modules: {} },
  env: {
    ASSETS: { type: "assets" },
    BREVO_API_KEY: { type: "secret" },
    BREVO_LIST_ID: text(e.BREVO_LIST_ID),
    BREVO_DOI_TEMPLATE_ID: text(e.BREVO_DOI_TEMPLATE_ID),
    BREVO_DOI_TEMPLATE_ID_CS: text(e.BREVO_DOI_TEMPLATE_ID_CS),
    BREVO_LANGUAGE_ATTRIBUTE: text(e.BREVO_LANGUAGE_ATTRIBUTE),
    TURNSTILE_SITE_KEY: text(e.TURNSTILE_SITE_KEY),
    ...(e.TURNSTILE_SITE_KEY ? { TURNSTILE_SECRET_KEY: { type: "secret" } } : {}),
    GAME_MOVED: text(e.GAME_MOVED),
    FEEDBACK_TO: text(e.FEEDBACK_TO),
    FEEDBACK_FROM: text(e.FEEDBACK_FROM),
    ...(e.FEEDBACK_TO ? { EMAIL: { type: "send-email", destinationAddress: e.FEEDBACK_TO } } : {}),
    FEEDBACK_ARCHIVE: { type: "r2", name: "streets-of-prague-mail" },
    TELEMETRY: { type: "analytics-engine-dataset", name: "streets_telemetry" },
    RATE: { type: "rate-limit", namespace: "1001", simple: { limit: 5, period: 60 } },
  },
}))' > "$OUTPUT/workers/default/worker.config.json"
rsync -a dist-cf/ "$OUTPUT/workers/default/assets/"
printf 'Cloudflare app data: %s\n' "$DATA_URL"
export CLOUDFLARE_ACCOUNT_ID=7756b12931ecfb3900a31049e157d706
cf deploy --prebuilt --dry-run
[[ ${1:-} == --dry-run ]] || cf deploy --prebuilt
