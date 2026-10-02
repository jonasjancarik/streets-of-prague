#!/usr/bin/env bash
# Upload and verify an immutable public/data version with an R2 S3 remote.
# A version is uploaded once and never added to: a name that already exists is refused,
# unless --resume says this is the same upload being finished after it was interrupted.
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION=${1:-}
if [[ ! $VERSION =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]*$ || ${2:---resume} != --resume ]]; then
  echo 'Usage: scripts/upload-data.sh <version> [--resume]' >&2
  exit 1
fi
REMOTE=${R2_REMOTE:-streets:streets-of-prague-data}
TARGET=$REMOTE/$VERSION
node scripts/check-data-format.mjs public/data
rclone lsd "$REMOTE" >/dev/null
if [[ ${2:-} != --resume && -n $(rclone lsf "$TARGET" --max-depth 1 2>/dev/null | head -n 1) ]]; then
  echo "Version $VERSION is already on R2. Pick a new name, or pass --resume to finish an interrupted upload of the same files." >&2
  exit 1
fi
# --immutable permits safe resume: existing files must have identical checksums.
rclone copy public/data/ "$TARGET" --checksum --immutable --transfers 32 --checkers 32 \
  --header-upload 'Cache-Control: public, max-age=31536000, immutable' \
  --stats 20s --stats-one-line --log-level INFO
rclone check public/data/ "$TARGET" --checksum --checkers 32
printf '%s\n' "$VERSION" > deploy/data-version
# The order maps were uploaded in (oldest first), which deploy/data-oldest is read against.
# --resume finishes a version that may already be recorded.
grep -qxF "$VERSION" deploy/data-history || printf '%s\n' "$VERSION" >> deploy/data-history
printf 'Verified R2 data version: %s\n' "$VERSION"
