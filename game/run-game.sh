#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
BUILD_ROOT="$HOME/Projects/smash-online-build"
GAME_DIR="$BUILD_ROOT/src/BattleShip/build-us"
BINARY="${SMASH_ONLINE_BINARY:-$GAME_DIR/BattleShip}"
INPUT_FILE="${OPENSMASH_LAUNCHER_INPUT:-/tmp/smash-online-input.osi1}"

if [[ ! -x "$BINARY" ]]; then
  echo "Game binary not found or not executable: $BINARY" >&2
  echo "Build it with ROM_PATH='/absolute/path/to/rom.z64' $ROOT/game/build.sh" >&2
  exit 2
fi
export OPENSMASH_LAUNCHER_INPUT="$INPUT_FILE"
export SSB64_BOOT_SLOTS=hhhh
export SSB64_BOOT_BATTLE=-1,-1,4,0,-1,-1
export SSB64_START_SCENE=16
node "$ROOT/game/configure-window.mjs" "$GAME_DIR/BattleShip.cfg.json"
mkdir -p "$BUILD_ROOT/bin"
if [[ ! -x "$BUILD_ROOT/bin/sck-capture" || "$ROOT/game/capture/sck-capture.swift" -nt "$BUILD_ROOT/bin/sck-capture" ]]; then
  swiftc -parse-as-library -O -framework AppKit -framework ScreenCaptureKit \
    -o "$BUILD_ROOT/bin/sck-capture" "$ROOT/game/capture/sck-capture.swift"
fi
node "$ROOT/game/init-input.mjs"

cd "$GAME_DIR"
"$BINARY" "$@" &
pid=$!
printf 'game_pid=%s\n' "$pid"
for _ in $(seq 1 100); do
  window_info="$(swift "$ROOT/game/window-id.swift" "$pid" 2>/dev/null || true)"
  if [[ -n "$window_info" ]]; then
    window_id="$(node -e 'console.log(JSON.parse(process.argv[1]).windowId)' "$window_info")"
    printf 'window_id=%s\n' "$window_id"
    break
  fi
  kill -0 "$pid" 2>/dev/null || break
  sleep 0.2
done
wait "$pid"
