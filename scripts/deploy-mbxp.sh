#!/usr/bin/env bash
# Deploy to mbxp as https://beta.streetsofprague.com (Cloudflare tunnel urad-ai-poc → 127.0.0.1:3017).
# The built site goes to releases/<commit>/site. The locally built map data (public/data)
# goes to data/<id>, where the id is a fingerprint of its files: a changed map gets a new
# folder and a new address (data/<id>/), so the running game keeps the map it started
# with, browsers never mix files of two maps, and the release remembers which map it
# was deployed with. Files that haven't changed are hard links to the previous map's, so
# a new map only sends and stores what differs.
set -euo pipefail

HOST=${DEPLOY_HOST:-mbxp}
# Off the home network, reach mbxp through Cloudflare Access instead.
if [[ -z ${DEPLOY_HOST:-} ]] && ! ssh -o ConnectTimeout=5 -o BatchMode=yes mbxp true 2>/dev/null; then
  HOST=mbxp-remote
  echo "mbxp isn't reachable on the LAN, using mbxp-remote."
fi
DIR=/home/jonas/deployments/streets-of-prague
PORT=3017

cd "$(dirname "$0")/.."
git diff --quiet HEAD || { echo "Commit your changes first." >&2; exit 1; }
SHA=$(git rev-parse HEAD)

# --cloudflare-map: the beta reads the map production serves (deploy/data-version, from
# data.streetsofprague.com) instead of one sent from here: no map goes to mbxp, which is
# the way to deploy from anywhere after uploading a map. The folder data/<id> on the
# server then only exists to be mounted, and stays empty.
CF_MAP=
[[ ${1:-} == --cloudflare-map ]] && CF_MAP=$(tr -d '\n' < deploy/data-version)

# DATA_ID=<id> deploys with a map already on the server instead of the local one (to go
# back to an earlier map; each release's id is in releases/<commit>/data-id).
if [[ -n $CF_MAP ]]; then
  ID=cloudflare-$CF_MAP
  node scripts/check-data-format.mjs "https://data.streetsofprague.com/$CF_MAP/"
elif [[ -n ${DATA_ID:-} ]]; then
  ID=$DATA_ID
  ssh "$HOST" test -d "$DIR/data/$ID" || { echo "There is no map $ID on $HOST." >&2; exit 1; }
else
  node scripts/check-data-format.mjs public/data
  # Paths, sizes and modification times of every file: what rsync goes by too.
  ID=$(cd public/data && find . -type f ! -name .DS_Store -exec stat -f '%N %z %m' {} + | LC_ALL=C sort | shasum -a 256 | cut -c1-12)
fi
echo "Map data: $ID"

# The beta has no Worker of its own: its signup and feedback forms post to production's
# (worker/index.js lets the beta's address in). Neither form shows until it is set up
# (deploy/newsletter, deploy/feedback).
source deploy/newsletter; source deploy/feedback
if [[ -n ${BREVO_LIST_ID:-} && -n ${BREVO_DOI_TEMPLATE_ID:-} ]]; then export VITE_SUBSCRIBE_URL=https://streetsofprague.com/api/subscribe; fi
if [[ -n ${FEEDBACK_TO:-} ]]; then export VITE_FEEDBACK_URL=https://streetsofprague.com/api/feedback; fi
if [[ -n ${TURNSTILE_SITE_KEY:-} ]]; then export VITE_TURNSTILE_SITE_KEY=$TURNSTILE_SITE_KEY; fi
# Statistics go to production's Worker too; the domain they carry tells the beta apart.
if [[ -n $CF_MAP ]]; then export VITE_DATA_URL=https://data.streetsofprague.com/$CF_MAP/ VITE_DATA_VERSION=$CF_MAP; else export VITE_DATA_URL=data/$ID/; fi
VITE_TELEMETRY_URL=https://streetsofprague.com/api/report node --input-type=module -e "import { build } from 'vite'; await build({ publicDir: false })"
# busybox httpd can't send no-store, so the game asks for it with cache: 'no-store'.
node scripts/write-version-json.mjs dist "${CF_MAP:-$ID}" --fixed

# site/data/<id> is the mountpoint for the map (it can't be created inside a read-only mount).
ssh "$HOST" mkdir -p "$DIR/releases/$SHA/site/data/$ID" "$DIR/data"
rsync -a dist/ "$HOST:$DIR/releases/$SHA/site/"
# The build leaves public/ out (publicDir: false, for the sake of public/data), so the
# committed files in it (figures.glb, cars.glb, facades.webp) go over on their own.
(cd public && git ls-files) | rsync -a --files-from=- public/ "$HOST:$DIR/releases/$SHA/site/"
rsync -a scripts/httpd.conf "$HOST:$DIR/releases/$SHA/httpd.conf"
# The map is sent to <id>.partial and renamed once it's whole, so an interrupted sync is
# never served. Unchanged files are linked from the map in use (or, the first time, from
# shared/data, where the map used to live).
if [[ -n $CF_MAP ]]; then
  ssh "$HOST" mkdir -p "$DIR/data/$ID"
elif ! ssh "$HOST" test -d "$DIR/data/$ID"; then
  LINKS=$(ssh "$HOST" "for d in $DIR/data/\$(cat $DIR/current-data 2>/dev/null) $DIR/shared/data; do [ -d \$d/praha_now ] && echo --link-dest=\$d; done; true")
  # shellcheck disable=SC2086
  rsync -a --exclude .DS_Store $LINKS public/data/ "$HOST:$DIR/data/$ID.partial/"
  ssh "$HOST" mv "$DIR/data/$ID.partial" "$DIR/data/$ID"
fi

ssh "$HOST" bash -s -- "$DIR" "$SHA" "$PORT" "$ID" "$CF_MAP" <<'EOF'
set -euo pipefail
DIR=$1 SHA=$2 PORT=$3 ID=$4 CF_MAP=$5
docker rm -f streets-of-prague >/dev/null 2>&1 || true
docker run -d --name streets-of-prague --restart unless-stopped \
  -p 127.0.0.1:$PORT:80 \
  -v "$DIR/releases/$SHA/site:/www:ro" \
  -v "$DIR/data/$ID:/www/data/$ID:ro" \
  -v "$DIR/releases/$SHA/httpd.conf:/etc/httpd.conf:ro" \
  busybox:latest httpd -f -p 80 -h /www -c /etc/httpd.conf >/dev/null
sleep 1
curl -fsS -o /dev/null -w "index.html: HTTP %{http_code}\n" http://127.0.0.1:$PORT/
# With --cloudflare-map there is no map here: the check of its format ran before the build.
[ -n "$CF_MAP" ] || curl -fsS -o /dev/null -w "praha index: HTTP %{http_code} %{content_type}\n" http://127.0.0.1:$PORT/data/$ID/praha_now/index.json
# Which code and which map are live, and the map this release went out with.
echo "$ID" > "$DIR/releases/$SHA/data-id"
echo "$SHA" > "$DIR/current"
echo "$ID" > "$DIR/current-data"
EOF
