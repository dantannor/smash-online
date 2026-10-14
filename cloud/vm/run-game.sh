#!/bin/bash
# Linux counterpart of game/run-game.sh: same boot settings and roster handling, no macOS window/capture helpers.
# Runs under systemd (smash-game.service), which restarts it when the engine aborts.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd -P)"
BUILD_ROOT="$HOME/Projects/smash-online-build"
GAME_DIR="${SMASH_GAME_DIR:-$BUILD_ROOT/src/BattleShip/build-us}"   # SMASH_GAME_DIR: another build dir (crash-soak.sh uses it for debug builds)
export OPENSMASH_LAUNCHER_INPUT="${OPENSMASH_LAUNCHER_INPUT:?}"
export SSB64_BOOT_SLOTS=hhhh
export SSB64_BOOT_BATTLE=-1,-1,4,0,-1,-1
export SSB64_START_SCENE=28   # nSCKindOpeningRoom: boot into the opening movie and title (16 = straight into the VS character select); the intro hook jumps to the select on a guest's first pick or Start
export SSB64_OPENING_VANILLA=1   # the opening plays with the original fighters: custom ones on its tiles crash it (opening-vanilla.patch)
ROSTER_DIR="${SMASH_ROSTER_DIR:-$BUILD_ROOT/roster}"
if [[ "${SMASH_ROSTER:-custom}" != vanilla && -f "$ROSTER_DIR/roster.txt" ]]; then
  ln -sfn "$ROSTER_DIR/characters" "$GAME_DIR/characters"
  export SSB64_ROSTER_FILE="$ROSTER_DIR/roster.txt" SSB64_ROSTER_PAGE=1
fi
# page jumps for the character select screen: the sidecar writes "<seq> <page>" here (see roster-hooks.patch)
export SSB64_ROSTER_PAGE_FILE="$(dirname "$OPENSMASH_LAUNCHER_INPUT")/roster-page"
[[ -f "$SSB64_ROSTER_PAGE_FILE" ]] || echo "0 1" > "$SSB64_ROSTER_PAGE_FILE"
export SSB64_ROSTER_PICK_FILE="$(dirname "$OPENSMASH_LAUNCHER_INPUT")/roster-pick"
[[ -f "$SSB64_ROSTER_PICK_FILE" ]] || echo "0 0 0" > "$SSB64_ROSTER_PICK_FILE"
export SMASH_AUDIO_BACKEND=sdl
export SMASH_WINDOW_W="${SMASH_VIDEO_W:-640}" SMASH_WINDOW_H="${SMASH_VIDEO_H:-480}"
# the game writes its config on first run; from the next start on, force the small windowed layout
node "$ROOT/game/configure-window.mjs" "$GAME_DIR/BattleShip.cfg.json"
node "$ROOT/game/init-input.mjs" >/dev/null   # writes the OSI1 file in place when it exists (the game reads it through an open fd)
# diagnostic, on by default when built (SMASH_FPS_LOG=0 turns it off): preloads cloud/vm/fps-probe.c (build: gcc -shared -fPIC -o ~/.smash-online/fps-probe.so cloud/vm/fps-probe.c -ldl); it appends the real swap rate to /tmp/fps.log
[[ "${SMASH_FPS_LOG:-1}" != 0 && -f "$HOME/.smash-online/fps-probe.so" ]] && export LD_PRELOAD="$HOME/.smash-online/fps-probe.so"
cd "$GAME_DIR"
exec ./BattleShip
