#!/bin/bash
# Crash soak for the engine: run the game with the menu masher (scripts/mash-menus.mjs) for a fixed time, restart it the way
# systemd does whenever it exits, and count the exits. Runs on the VM as the smash user and takes the production game and sidecar
# down for the duration (they are started again at the end), so it refuses to run while a guest is connected.
# usage: crash-soak.sh <seconds> [seed] [label]    env: SMASH_GAME_DIR (build dir, default build-us), SOAK_ARGS (extra masher flags)
# Output: /tmp/soak/<label>/{game.log,crashes.txt,summary.txt}; summary.txt has the crash count and the RELOCSTAT growth.
# Exit status is the regression check: 0 only with no crash and a flat reloc table (live slots grew by at most SOAK_RELOC_GROWTH,
# default 2000, over the second half of the run; the leak fixed by reloc-dedup.patch added about 500 per scene change).
# SOAK_MASH=0 soaks the idle game instead (opening, title, attract demo; the opening crash fixed by opening-vanilla.patch).
set -u
SECS="${1:?seconds}"; SEED="${2:-1}"; LABEL="${3:-run}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd -P)"
STATE="$HOME/.smash-online"; OUT="/tmp/soak/$LABEL"
guests="$(python3 -c 'import json; print(json.load(open("'"$STATE"'/status.json"))["guests"])' 2>/dev/null || echo 0)"
[[ "$guests" == 0 ]] || { echo "a guest is connected ($guests); not touching the services" >&2; exit 3; }
mkdir -p "$OUT"; : > "$OUT/game.log"; : > "$OUT/crashes.txt"
sudo systemctl stop smash-sidecar smash-game
export DISPLAY=:99 OPENSMASH_LAUNCHER_INPUT="$OUT/input.osi1" SMASH_WINDOW_X=0 SMASH_WINDOW_Y=0
export LIBGL_ALWAYS_SOFTWARE=1 GALLIUM_DRIVER=llvmpipe SDL_AUDIODRIVER=pulseaudio PULSE_SERVER=unix:/run/smash-pulse/native
set -a; . /etc/smash-online.env; set +a
rm -f "$OPENSMASH_LAUNCHER_INPUT" "$OUT/roster-page" "$OUT/roster-pick"
ulimit -c 0
mgr=""; game=""
stop_game() { [[ -n "$game" ]] && kill -KILL "$game" 2>/dev/null; wait "$game" 2>/dev/null; true; }   # run-game.sh execs the engine, so $game is the engine
cleanup() { [[ -n "$mgr" ]] && kill "$mgr" 2>/dev/null; stop_game; sudo systemctl start smash-game smash-sidecar; }
trap cleanup EXIT
start=$SECONDS; crashes=0; runs=0
while ((SECONDS - start < SECS)); do
  runs=$((runs + 1)); t0=$SECONDS
  "$ROOT/cloud/vm/run-game.sh" >>"$OUT/game.log" 2>&1 & game=$!
  for _ in $(seq 1 60); do [[ -s "$OPENSMASH_LAUNCHER_INPUT" ]] && break; sleep 1; done
  sleep 8   # scene 28 opening: let the engine boot before the first input
  remaining=$((SECS - (SECONDS - start)))
  mgr=""
  if [[ "${SOAK_MASH:-1}" != 0 ]]; then   # SOAK_MASH=0: no input at all, the idle game (opening, title, attract demo)
    node "$ROOT/scripts/mash-menus.mjs" --file "$OPENSMASH_LAUNCHER_INPUT" --seconds "$remaining" --seed "$((SEED + runs))" ${SOAK_ARGS:-} >>"$OUT/mash.log" 2>&1 & mgr=$!
  fi
  while kill -0 "$game" 2>/dev/null && ((SECONDS - start < SECS)); do sleep 1; done
  if kill -0 "$game" 2>/dev/null; then stop_game; [[ -n "$mgr" ]] && kill "$mgr" 2>/dev/null; mgr=""; break; fi
  wait "$game"; code=$?
  [[ -n "$mgr" ]] && { kill "$mgr" 2>/dev/null; wait "$mgr" 2>/dev/null; mgr=""; }
  crashes=$((crashes + 1))
  echo "run $runs exit=$code after $((SECONDS - t0))s (t=$((SECONDS - start))s): $(grep -E 'CRASH SIG|capacity exhausted|terminate called' "$OUT/game.log" | tail -1)" | tee -a "$OUT/crashes.txt"
  sleep 3
done
{
  echo "seconds=$((SECONDS - start)) runs=$runs crashes=$crashes"
  echo "reloc scene-change samples=$(grep -c RELOCSTAT "$OUT/game.log")"
  grep RELOCSTAT "$OUT/game.log" | awk 'NR%25==1' | tail -12
} | tee "$OUT/summary.txt"
growth="$(grep -o 'RELOCSTAT scene-change next=[0-9]* live=[0-9]*' "$OUT/game.log" | sed 's/.*live=//' \
  | awk '{v[NR]=$1} END {if (NR < 4) print "none"; else print v[NR] - v[int(NR/2)]}')"
if ((crashes == 0)) && [[ "$growth" != none ]] && ((growth <= ${SOAK_RELOC_GROWTH:-2000})); then
  echo "PASS: 0 crashes, live reloc slots +$growth over the second half" | tee -a "$OUT/summary.txt"
else
  echo "FAIL: crashes=$crashes, live reloc slots growth over the second half=$growth" | tee -a "$OUT/summary.txt"; exit 1
fi
