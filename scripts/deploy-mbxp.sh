#!/usr/bin/env bash
# Deploy to mbxp as https://streets-beta.jonasjancarik.cz (Cloudflare tunnel urad-ai-poc → 127.0.0.1:3017).
# The built site goes to releases/<commit>/site; the locally built map data (public/data)
# is synced to shared/data and mounted over /www/data, so a code release doesn't copy it.
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

node --input-type=module -e "import { build } from 'vite'; await build({ publicDir: false })"

# site/data is the mountpoint for shared/data (it can't be created inside a read-only mount).
ssh "$HOST" mkdir -p "$DIR/releases/$SHA/site/data" "$DIR/shared/data"
rsync -a dist/ "$HOST:$DIR/releases/$SHA/site/"
# The build leaves public/ out (publicDir: false, for the sake of public/data), so the
# committed files in it (figures.glb, cars.glb, facades.webp) go over on their own.
(cd public && git ls-files) | rsync -a --files-from=- public/ "$HOST:$DIR/releases/$SHA/site/"
rsync -a scripts/httpd.conf "$HOST:$DIR/releases/$SHA/httpd.conf"
rsync -a public/data/ "$HOST:$DIR/shared/data/"

ssh "$HOST" bash -s -- "$DIR" "$SHA" "$PORT" <<'EOF'
set -euo pipefail
DIR=$1 SHA=$2 PORT=$3
docker rm -f streets-of-prague >/dev/null 2>&1 || true
docker run -d --name streets-of-prague --restart unless-stopped \
  -p 127.0.0.1:$PORT:80 \
  -v "$DIR/releases/$SHA/site:/www:ro" \
  -v "$DIR/shared/data:/www/data:ro" \
  -v "$DIR/releases/$SHA/httpd.conf:/etc/httpd.conf:ro" \
  busybox:latest httpd -f -p 80 -h /www -c /etc/httpd.conf >/dev/null
sleep 1
curl -fsS -o /dev/null -w "index.html: HTTP %{http_code}\n" http://127.0.0.1:$PORT/
curl -fsS -o /dev/null -w "praha index: HTTP %{http_code} %{content_type}\n" http://127.0.0.1:$PORT/data/praha_now/index.json
echo "$SHA" > "$DIR/current"
EOF
