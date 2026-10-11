#!/usr/bin/env bash
# Stop exactly what scripts/start.sh started (read from its run dir's pids file). Safe when nothing is running.
# Does not read or touch the legacy /tmp/smash-live session; use scripts/stop-live.sh for that.
set -euo pipefail

RUN_BASE="${SMASH_RUN_BASE:-$HOME/.smash-online/run}"
CURRENT="$RUN_BASE/current"
QUIET=0 PURGE=0
for arg in "$@"; do
  case "$arg" in
    --quiet) QUIET=1 ;;
    --purge) PURGE=1 ;; # also delete logs
    *) echo "usage: scripts/stop.sh [--quiet] [--purge]" >&2; exit 64 ;;
  esac
done
say() { ((QUIET)) || echo "$@"; }

if [[ ! -L "$CURRENT" && ! -d "$CURRENT" ]]; then say "Nothing to stop (no run state in $RUN_BASE)."; exit 0; fi
RUN_DIR="$(cd "$CURRENT" 2>/dev/null && pwd -P || true)"
if [[ -z "$RUN_DIR" || ! -r "$RUN_DIR/pids" ]]; then
  rm -f "$CURRENT"; say "Nothing to stop (stale pointer removed)."; exit 0
fi

# Each role was started with setsid, so its pid is also its process group id; signal the whole group
# (e.g. game launcher + game + capture helper) but only if the pid still leads its own group.
group_members() { ps -axo pgid=,stat=,pid= | awk -v g="$1" '$1==g && $2 !~ /^Z/ {print $3}'; }
leads_group() { [[ "$(ps -o pgid= -p "$1" 2>/dev/null | tr -d ' ')" == "$1" ]] || [[ -n "$(group_members "$1")" ]]; }

roles=() pids=()
while read -r role pid; do
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] && { roles+=("$role"); pids+=("$pid"); }
done < "$RUN_DIR/pids"

for ((i=${#pids[@]}-1; i>=0; i--)); do
  role="${roles[i]}" pid="${pids[i]}"
  if [[ -z "$(group_members "$pid")" ]]; then say "$role (pid $pid): already stopped"; continue; fi
  if ! leads_group "$pid"; then say "$role (pid $pid): pid no longer ours, left alone"; continue; fi
  kill -TERM -- "-$pid" 2>/dev/null || true
  for _ in $(seq 1 25); do [[ -z "$(group_members "$pid")" ]] && break; sleep 0.2; done
  if [[ -z "$(group_members "$pid")" ]]; then say "$role (pid $pid): stopped"
  else
    kill -KILL -- "-$pid" 2>/dev/null || true
    sleep 0.3
    say "$role (pid $pid): force-killed after 5s"
  fi
done

rm -f "$CURRENT"
if ((PURGE)); then rm -rf "$RUN_DIR"
else rm -rf "$RUN_DIR/chrome-profile"; rm -f "$RUN_DIR/pids" "$RUN_DIR/host-url" "$RUN_DIR/no-browser"; fi
say "Stopped. State cleaned."
