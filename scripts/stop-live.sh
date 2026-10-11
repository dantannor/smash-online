#!/usr/bin/env bash
set -euo pipefail

PID_FILE=/tmp/smash-live/pids
if [[ ! -r "$PID_FILE" ]]; then
  printf 'Cannot read %s\n' "$PID_FILE" >&2
  exit 1
fi

expected_for() {
  case "$1" in
    game_launcher) printf '%s' 'game/run-game.sh' ;;
    game) printf '%s' 'BattleShip' ;;
    sidecar) printf '%s' 'sidecar/index.js' ;;
    server_npm) printf '%s' 'npm start' ;;
    server_child) printf '%s' 'node server/index.js' ;;
    tunnel) printf '%s' 'cloudflared tunnel' ;;
    host_chrome) printf '%s' '--user-data-dir=/tmp/smash-live/chrome-profile' ;;
    *) return 1 ;;
  esac
}

process_matches() {
  local pid="$1" expected="$2" command
  command="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  [[ -n "$command" && "$command" == *"$expected"* ]]
}

signal_recorded_pids() {
  local signal="$1" role pid extra expected
  while IFS=' ' read -r role pid extra; do
    [[ -z "${role:-}" || "$role" == \#* ]] && continue
    if [[ -n "${extra:-}" || ! "${pid:-}" =~ ^[1-9][0-9]*$ ]]; then
      printf 'Skipping malformed PID record: %s %s %s\n' "$role" "${pid:-}" "${extra:-}" >&2
      continue
    fi
    if ! expected="$(expected_for "$role")"; then
      printf 'Skipping unknown PID role: %s\n' "$role" >&2
      continue
    fi
    if process_matches "$pid" "$expected"; then
      kill -"$signal" "$pid" 2>/dev/null || true
    fi
  done < "$PID_FILE"
}

signal_recorded_pids TERM
for _ in $(seq 1 50); do
  alive=0
  while IFS=' ' read -r role pid extra; do
    [[ -z "${role:-}" || "$role" == \#* || -n "${extra:-}" || ! "${pid:-}" =~ ^[1-9][0-9]*$ ]] && continue
    expected="$(expected_for "$role" 2>/dev/null || true)"
    [[ -n "$expected" ]] || continue
    if process_matches "$pid" "$expected"; then
      state="$(ps -p "$pid" -o stat= 2>/dev/null | awk '{print $1}')"
      [[ "$state" == Z* ]] || alive=1
    fi
  done < "$PID_FILE"
  [[ "$alive" -eq 0 ]] && break
  sleep 0.2
done

signal_recorded_pids KILL
printf 'Stopped the live-session PIDs listed in %s (unmatched or already-exited PIDs were left alone).\n' "$PID_FILE"
