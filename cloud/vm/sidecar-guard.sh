#!/bin/bash
# Run the sidecar and exit (so systemd restarts it) if the OSI1 file gets a new inode: the sidecar holds the
# old file open, so it would keep writing somewhere the game no longer reads. Same rule as game-watchdog.sh.
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd -P)"
FILE="${OPENSMASH_LAUNCHER_INPUT:?}"
for _ in $(seq 1 60); do [[ -s "$FILE" ]] && break; sleep 1; done
ino="$(stat -c %i "$FILE")"
node "$ROOT/sidecar/index.js" --file "$FILE" --port 8765 --mute &
pid=$!
trap 'kill "$pid" 2>/dev/null; wait "$pid"; exit 0' TERM INT
while kill -0 "$pid" 2>/dev/null; do
  sleep 2
  if [[ "$(stat -c %i "$FILE" 2>/dev/null || echo none)" != "$ino" ]]; then
    echo "OSI1 inode changed; restarting sidecar"; kill "$pid"; wait "$pid"; exit 1
  fi
done
wait "$pid"
