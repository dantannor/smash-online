#!/bin/bash
# Linux counterpart of game/run-game.sh: same boot settings and roster handling, no macOS window/capture helpers.
# Runs under systemd (smash-game.service), which restarts it when the engine aborts.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd -P)"
BUILD_ROOT="$HOME/Projects/smash-online-build"
GAME_DIR="$BUILD_ROOT/src/BattleShip/build-us"
export OPENSMASH_LAUNCHER_INPUT="${OPENSMASH_LAUNCHER_INPUT:?}"
export SSB64_BOOT_SLOTS=hhhh
export SSB64_BOOT_BATTLE=-1,-1,4,0,-1,-1
export SSB64_START_SCENE=16
ROSTER_DIR="${SMASH_ROSTER_DIR:-$BUILD_ROOT/roster}"
if [[ "${SMASH_ROSTER:-custom}" != vanilla && -f "$ROSTER_DIR/roster.txt" ]]; then
  ln -sfn "$ROSTER_DIR/characters" "$GAME_DIR/characters"
  export SSB64_ROSTER_FILE="$ROSTER_DIR/roster.txt" SSB64_ROSTER_PAGE=1
fi
# the game writes its config on first run; from the next start on, force the small windowed layout
[[ -f "$GAME_DIR/BattleShip.cfg.json" ]] && node "$ROOT/game/configure-window.mjs" "$GAME_DIR/BattleShip.cfg.json"
node "$ROOT/game/init-input.mjs" >/dev/null   # writes the OSI1 file in place when it exists (the game reads it through an open fd)
cd "$GAME_DIR"
exec ./BattleShip
