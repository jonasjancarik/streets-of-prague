#!/usr/bin/env bash
# Upload and verify an immutable public/data version with an R2 S3 remote.
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION=${1:-}
if [[ ! $VERSION =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]*$ ]]; then
  echo 'Usage: scripts/upload-data.sh <version>' >&2
  exit 1
fi
REMOTE=${R2_REMOTE:-streets:streets-of-prague-data}
TARGET=$REMOTE/$VERSION
rclone lsd "$REMOTE" >/dev/null
# --immutable permits safe resume: existing files must have identical checksums.
rclone copy public/data/ "$TARGET" --checksum --immutable --transfers 32 --checkers 32 \
  --header-upload 'Cache-Control: public, max-age=31536000, immutable' \
  --stats 20s --stats-one-line --log-level INFO
rclone check public/data/ "$TARGET" --checksum --checkers 32
printf '%s\n' "$VERSION" > deploy/data-version
printf 'Verified R2 data version: %s\n' "$VERSION"
