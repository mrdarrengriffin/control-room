#!/usr/bin/env bash
set -euo pipefail

# Seed the data directory on first run.
#
# When Control Room is run from the published image, ./data is an empty
# bind-mount from the host, so the example registry baked into the image is
# hidden underneath it. Without this the first run reports "No data/sites.json
# found. Copy data/sites.example.json" — naming a file that isn't there.
#
# Only ever creates what is missing. Nothing here overwrites an existing file,
# so an update can never clobber a real registry, tokens or the password hash.
DATA_DIR="${CONTROL_ROOM_DATA_DIR:-/workspace/data}"
SEED_DIR="/opt/control-room/seed"

mkdir -p "$DATA_DIR"

if [ -d "$SEED_DIR" ]; then
  for seed in "$SEED_DIR"/*; do
    [ -e "$seed" ] || continue
    target="$DATA_DIR/$(basename "$seed")"
    if [ ! -e "$target" ]; then
      cp "$seed" "$target"
      echo "control-room: seeded $(basename "$seed")"
    fi
  done
fi

exec "$@"
