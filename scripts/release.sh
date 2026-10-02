#!/usr/bin/env bash
# Cut a release: tag the committed main, publish it as a GitHub release with notes
# generated from the commits since the last release, then deploy that tag to Cloudflare.
# Usage: scripts/release.sh patch|minor|major|vX.Y.Z [--no-deploy]
# patch, minor and major count up from the latest release: after v0.2.3 they give
# v0.2.4, v0.3.0 and v1.0.0.
set -euo pipefail
cd "$(dirname "$0")/.."
USAGE='Usage: scripts/release.sh patch|minor|major|vX.Y.Z [--no-deploy]'
TAG=${1:?$USAGE}
[[ ${2:---no-deploy} == --no-deploy ]] || { echo "$USAGE" >&2; exit 1; }
[[ $(git branch --show-current) == main ]] || { echo 'Release from main.' >&2; exit 1; }
git diff --quiet HEAD || { echo 'Commit your changes first.' >&2; exit 1; }
git fetch --tags origin
if [[ $TAG =~ ^(patch|minor|major)$ ]]; then
  LAST=$(git tag -l 'v[0-9]*.[0-9]*.[0-9]*' --sort=-v:refname | head -n 1)
  [[ $LAST =~ ^v([0-9]+)\.([0-9]+)\.([0-9]+)$ ]] || { echo 'There is no release to count up from: give the first one as vX.Y.Z.' >&2; exit 1; }
  case $TAG in
    patch) TAG=v${BASH_REMATCH[1]}.${BASH_REMATCH[2]}.$((BASH_REMATCH[3] + 1)) ;;
    minor) TAG=v${BASH_REMATCH[1]}.$((BASH_REMATCH[2] + 1)).0 ;;
    major) TAG=v$((BASH_REMATCH[1] + 1)).0.0 ;;
  esac
  echo "Releasing $TAG (after $LAST)."
fi
[[ $TAG =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo 'The tag must look like v1.2.3.' >&2; exit 1; }
[[ -z $(git tag -l "$TAG") ]] || { echo "$TAG already exists." >&2; exit 1; }
[[ -z $(git tag -l 'v[0-9]*' --points-at HEAD) ]] || { echo "This commit is already released as $(git tag -l 'v[0-9]*' --points-at HEAD | head -n 1)." >&2; exit 1; }
[[ $(git rev-parse HEAD) == $(git rev-parse origin/main) ]] || { echo 'Push main first (or pull).' >&2; exit 1; }
# Everything that could stop the deploy is checked before the tag exists: the code
# typechecks and the map this commit names is on R2 in the format the code reads.
DATA=$(tr -d '\n' < deploy/data-version)
npm run typecheck
node scripts/check-data-format.mjs "https://data.streetsofprague.com/$DATA/"
node scripts/check-data-versions.mjs

# One line of notes on the maps this version works with. "Needs" when the oldest map
# changed since the last release; a release from before deploy/data-oldest existed counts
# as changed only if the map format changed.
OLDEST=$(tr -d '\n' < deploy/data-oldest)
PREV=$(git tag -l 'v[0-9]*.[0-9]*.[0-9]*' --sort=-v:refname | head -n 1)
NEEDS=
if [[ -n $PREV ]]; then
  if PREV_OLDEST=$(git show "$PREV:deploy/data-oldest" 2>/dev/null); then
    [[ $(printf %s "$PREV_OLDEST" | tr -d '\n') == "$OLDEST" ]] || NEEDS=1
  else
    format() { git show "$1:src/data.ts" 2>/dev/null | sed -n 's/^export const DATA_FORMAT = \([0-9]*\);.*/\1/p'; }
    [[ $(format "$PREV") == $(format HEAD) ]] || NEEDS=1
  fi
fi
if [[ -n $NEEDS ]]; then MAPS="Needs map $OLDEST or newer"; else MAPS="Works with maps from $OLDEST"; fi

git tag -a "$TAG" -m "$TAG"
git push origin "$TAG"
gh release create "$TAG" --title "$TAG" --generate-notes --verify-tag --notes "Map data: $DATA. $MAPS."
# Built from the tag, so the settings panel shows exactly this version.
[[ ${2:-} == --no-deploy ]] || scripts/deploy-cloudflare.sh
