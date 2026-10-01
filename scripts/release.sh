#!/usr/bin/env bash
# Cut a release: tag the committed main, publish it as a GitHub release with notes
# generated from the commits since the last release, then deploy that tag to Cloudflare.
# Usage: scripts/release.sh v0.2.0 [--no-deploy]
set -euo pipefail
cd "$(dirname "$0")/.."
TAG=${1:?Usage: scripts/release.sh vX.Y.Z [--no-deploy]}
[[ $TAG =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo 'The tag must look like v1.2.3.' >&2; exit 1; }
[[ $(git branch --show-current) == main ]] || { echo 'Release from main.' >&2; exit 1; }
git diff --quiet HEAD || { echo 'Commit your changes first.' >&2; exit 1; }
git fetch --tags origin
[[ $(git rev-parse HEAD) == $(git rev-parse origin/main) ]] || { echo 'Push main first (or pull).' >&2; exit 1; }
# Everything that could stop the deploy is checked before the tag exists: the code
# typechecks and the map this commit names is on R2 in the format the code reads.
DATA=$(tr -d '\n' < deploy/data-version)
npm run typecheck
node scripts/check-data-format.mjs "https://streets-data.jonasjancarik.cz/$DATA/"

git tag -a "$TAG" -m "$TAG"
git push origin "$TAG"
gh release create "$TAG" --title "$TAG" --generate-notes --verify-tag --notes "Map data: $DATA"
# Built from the tag, so the settings panel shows exactly this version.
[[ ${2:-} == --no-deploy ]] || scripts/deploy-cloudflare.sh
