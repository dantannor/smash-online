#!/usr/bin/env bash
# Start a Smash Online host session: game -> sidecar -> local server -> host Chrome.
# Everything runs detached (own session) and is recorded under a run dir so scripts/stop.sh can stop exactly it.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
[[ -r "$HOME/.smash-online/config" ]] && . "$HOME/.smash-online/config"

RUN_BASE="${SMASH_RUN_BASE:-$HOME/.smash-online/run}"
SIDECAR_PORT="${SMASH_SIDECAR_PORT:-8765}" # the host page connects to 8765; change only for tests
SERVER_PORT="${SMASH_SERVER_PORT:-8787}"
WORKER="${SMASH_SIGNAL_ORIGIN:-https://smash-online.reddit-service-site.workers.dev}"
INPUT_FILE="${SMASH_INPUT_FILE:-${OPENSMASH_LAUNCHER_INPUT:-/tmp/smash-online-input.osi1}}"
BINARY="${SMASH_ONLINE_BINARY:-$HOME/Projects/smash-online-build/src/BattleShip/build-us/BattleShip}"
CHROME="${SMASH_CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
CAPTURE_SOURCE="${SMASH_CAPTURE_SOURCE:-BattleShip (Metal)}"
CHROME_DEBUG_PORT="${SMASH_CHROME_DEBUG_PORT:-}" # optional: expose CDP on 127.0.0.1 so tests can click Start capture
SETTLE="${SMASH_GAME_SETTLE:-2}"
GAME_TIMEOUT="${SMASH_GAME_TIMEOUT:-90}"
MODE=worker BROWSER=1

usage() { echo "usage: scripts/start.sh [--no-browser] [--local]"; }
for arg in "$@"; do
  case "$arg" in
    --no-browser) BROWSER=0 ;;
    --local) MODE=local ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; exit 64 ;;
  esac
done
[[ "${SMASH_NO_BROWSER:-}" == 1 ]] && BROWSER=0

CURRENT="$RUN_BASE/current"
RUN_DIR=""

host_url() {
  if [[ "$MODE" == local ]]; then echo "http://127.0.0.1:$SERVER_PORT/host"
  else echo "http://127.0.0.1:$SERVER_PORT/host?signal=$WORKER"; fi
}

summary() {
  echo "Run dir:   $1"
  echo "Host page: $(cat "$1/host-url")"
  echo
  echo "Next:"
  if [[ -f "$1/no-browser" ]]; then echo "  1. Open the host page above in Chrome (foreground; it must stay visible for capture)."
  else echo "  1. In the host Chrome window, click \"Start capture\" (keep that window in the foreground)."; fi
  echo "  2. The P2, P3 and P4 guest links appear on the host page under the guest links; share one per player."
  echo "  3. You play P1 from the host page (keep its tab focused)."
  echo "Stop everything with: scripts/stop.sh"
}

pid_alive() { kill -0 "$1" 2>/dev/null; }
port_busy() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

wait_for() { # desc timeout command...
  local desc="$1" limit="$2"; shift 2
  local end=$((SECONDS + limit))
  until "$@" >/dev/null 2>&1; do
    if ((SECONDS >= end)); then echo "Timed out waiting for $desc" >&2; return 1; fi
    sleep 0.3
  done
}

# Idempotency: refuse if a previous run still has live processes; clear stale state otherwise.
if [[ -L "$CURRENT" || -d "$CURRENT" ]]; then
  prev="$(cd "$CURRENT" 2>/dev/null && pwd -P || true)"
  running=0
  if [[ -n "$prev" && -r "$prev/pids" ]]; then
    while read -r role pid; do
      [[ "$pid" =~ ^[1-9][0-9]*$ ]] && pid_alive "$pid" && running=1
    done < "$prev/pids"
  fi
  if ((running)); then
    echo "Already running (not starting a second copy)."
    [[ -r "$prev/host-url" ]] && summary "$prev"
    exit 0
  fi
  echo "Clearing stale state from a previous run."
  "$ROOT/scripts/stop.sh" --quiet >/dev/null 2>&1 || true
  rm -f "$CURRENT"
fi

# Preflight
fail=0
err() { echo "preflight: $*" >&2; fail=1; }
if [[ -z "${SMASH_GAME_CMD:-}" ]]; then
  [[ -x "$BINARY" ]] || err "game binary not found or not executable: $BINARY (build it with ROM_PATH=... game/build.sh)"
  [[ -f "$(dirname "$BINARY")/BattleShip.o2r" ]] || err "BattleShip.o2r missing next to the binary (rebuild with game/build.sh)"
fi
[[ -z "${SMASH_ROM_PATH:-}" || -f "$SMASH_ROM_PATH" ]] || err "SMASH_ROM_PATH does not exist: $SMASH_ROM_PATH"
command -v node >/dev/null || err "node not found"
command -v perl >/dev/null || err "perl not found"
[[ -d "$ROOT/node_modules/ws" ]] || err "run npm ci first (ws is missing)"
((BROWSER)) && { [[ -x "$CHROME" ]] || err "Chrome not found: $CHROME (set SMASH_CHROME or use --no-browser)"; }
for p in "$SIDECAR_PORT" "$SERVER_PORT"; do port_busy "$p" && err "port $p is already in use"; done
if [[ "$MODE" == worker ]]; then
  curl -fsS -m 8 "$WORKER/healthz" >/dev/null 2>&1 || err "Worker not reachable: $WORKER/healthz (use --local to skip the Worker)"
fi
((fail)) && exit 2

RUN_DIR="$RUN_BASE/$(date +%Y%m%d-%H%M%S)-$$"
mkdir -p "$RUN_DIR"
: > "$RUN_DIR/pids"
ln -sfn "$RUN_DIR" "$CURRENT"
host_url > "$RUN_DIR/host-url"
((BROWSER)) || : > "$RUN_DIR/no-browser"

on_fail() {
  echo "Start failed; rolling back what was started. Logs: $RUN_DIR/*.log" >&2
  "$ROOT/scripts/stop.sh" --quiet >&2 || true
}
trap on_fail ERR

# launch <role> <cmd...>: detached into its own session (survives terminal close); pid == process group id.
launch() {
  local role="$1"; shift
  perl -MPOSIX -e 'POSIX::setsid() or die "setsid: $!"; exec @ARGV or die "exec: $!"' "$@" \
    >"$RUN_DIR/$role.log" 2>&1 </dev/null &
  local pid=$!
  echo "$role $pid" >> "$RUN_DIR/pids"
  disown "$pid" 2>/dev/null || true
  sleep 0.2
  pid_alive "$pid" || { echo "$role exited immediately; see $RUN_DIR/$role.log" >&2; return 1; }
}

export OPENSMASH_LAUNCHER_INPUT="$INPUT_FILE"
export SMASH_RUN_DIR="$RUN_DIR" SMASH_SIDECAR_PORT="$SIDECAR_PORT"
# Restart the game when it exits (engine aborts after a few hours); SMASH_WATCHDOG=0 disables.
WATCHDOG=()
[[ "${SMASH_WATCHDOG:-1}" != 0 ]] && WATCHDOG=("$ROOT/scripts/game-watchdog.sh")
export PATH="$PATH"
cd "$ROOT"

echo "Starting game..."
if [[ -n "${SMASH_GAME_CMD:-}" ]]; then
  launch game "${WATCHDOG[@]}" bash -c "$SMASH_GAME_CMD"
  wait_for "OSI1 input file $INPUT_FILE" "$GAME_TIMEOUT" test -s "$INPUT_FILE"
else
  launch game "${WATCHDOG[@]}" "$ROOT/game/run-game.sh"
  # run-game.sh creates the file before the game opens it; the window_id line means the game is up and holds it.
  wait_for "game window" "$GAME_TIMEOUT" grep -q '^window_id=' "$RUN_DIR/game.log"
  wait_for "OSI1 input file $INPUT_FILE" 10 test -s "$INPUT_FILE"
fi
sleep "$SETTLE"

echo "Starting sidecar (muted) on ws://127.0.0.1:$SIDECAR_PORT..."
launch sidecar node "$ROOT/sidecar/index.js" --file "$INPUT_FILE" --port "$SIDECAR_PORT" --mute
wait_for "sidecar" 15 grep -q 'sidecar listening' "$RUN_DIR/sidecar.log"

echo "Starting local server on port $SERVER_PORT..."
if [[ "$MODE" == local ]]; then server_host="${HOST:-0.0.0.0}"; else server_host=127.0.0.1; fi
launch server env PORT="$SERVER_PORT" HOST="$server_host" node "$ROOT/server/index.js"
wait_for "local server" 15 curl -fsS -m 2 "http://127.0.0.1:$SERVER_PORT/healthz"

if ((BROWSER)); then
  echo "Opening host Chrome..."
  chrome_extra=()
  [[ -n "$CHROME_DEBUG_PORT" ]] && chrome_extra=("--remote-debugging-port=$CHROME_DEBUG_PORT" --remote-debugging-address=127.0.0.1)
  launch chrome "$CHROME" "--user-data-dir=$RUN_DIR/chrome-profile" ${chrome_extra[@]+"${chrome_extra[@]}"} --no-first-run --no-default-browser-check \
    "--auto-select-desktop-capture-source=$CAPTURE_SOURCE" "$(cat "$RUN_DIR/host-url")"
  osascript -e 'tell application "Google Chrome" to activate' >/dev/null 2>&1 || true
fi

trap - ERR
echo
echo "Smash Online is up ($MODE mode, game audio muted)."
summary "$RUN_DIR"
[[ "$MODE" == local ]] && echo "Local mode: for remote guests run ./server/tunnel.sh and share the tunnel's P2 link."
exit 0
