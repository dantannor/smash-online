#!/usr/bin/env bash
# Run the game command and restart it whenever it exits (the engine aborts after a few hours with
# "RelocPointerTable: token index capacity exhausted"). If the game recreates the OSI1 file (new inode),
# the sidecar still holds the old one, so restart the sidecar too. Stopped by stop.sh via SIGTERM to the group.
# usage: game-watchdog.sh <game command...>   env: SMASH_RUN_DIR, OPENSMASH_LAUNCHER_INPUT, SMASH_SIDECAR_PORT
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
RUN_DIR="${SMASH_RUN_DIR:?}"
INPUT="${OPENSMASH_LAUNCHER_INPUT:?}"
LOG="$RUN_DIR/restarts.log"
child=""
note() { echo "[watchdog $(date '+%F %T')] $*" | tee -a "$LOG"; }
trap '[[ -n "$child" ]] && kill -TERM "$child" 2>/dev/null; exit 0' TERM INT
inode() { stat -f %i "$INPUT" 2>/dev/null || stat -c %i "$INPUT" 2>/dev/null || echo none; }

restart_sidecar() {
  local old; old="$(awk '$1=="sidecar"{print $2}' "$RUN_DIR/pids")"
  [[ -n "$old" ]] && kill -TERM -- "-$old" 2>/dev/null
  sleep 1
  perl -MPOSIX -e 'POSIX::setsid() or die; exec @ARGV or die' node "$ROOT/sidecar/index.js" \
    --file "$INPUT" --port "${SMASH_SIDECAR_PORT:-8765}" --mute >>"$RUN_DIR/sidecar.log" 2>&1 </dev/null &
  local pid=$!; disown "$pid" 2>/dev/null || true
  sed -i.bak "s/^sidecar .*/sidecar $pid/" "$RUN_DIR/pids" && rm -f "$RUN_DIR/pids.bak"
  note "sidecar restarted (pid $pid); the host page must reconnect"
}

recent=()
while :; do
  before="$(inode)"
  "$@" & child=$!
  wait "$child"; code=$?; child=""
  now=$SECONDS; recent+=("$now"); recent=($(for t in "${recent[@]}"; do ((now - t < 120)) && echo "$t"; done))
  note "game exited (code $code); restart #${#recent[@]} in the last 2 min"
  if ((${#recent[@]} > 5)); then note "crash loop, giving up"; exit 1; fi
  sleep 3
  ( for _ in $(seq 1 60); do [[ -s "$INPUT" ]] && break; sleep 1; done
    sleep 3
    [[ "$(inode)" != "$before" ]] && restart_sidecar ) &
done
