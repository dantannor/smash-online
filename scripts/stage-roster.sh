#!/usr/bin/env bash
# Download + stage opensmash's custom fighters (smash.fun catalog) for the native game.
# Output (never committed): ~/Projects/smash-online-build/roster/{roster.txt,characters/}
# usage: scripts/stage-roster.sh            env: SMASH_ROSTER_COUNT=40 (first N catalog entries, or "all" for the whole catalog), SMASH_ROSTER_SLUGS=a,b,c (explicit list)
set -euo pipefail
BUILD_ROOT="$HOME/Projects/smash-online-build"
OPENSMASH="${SMASH_OPENSMASH_DIR:-$BUILD_ROOT/src/opensmash}"
OUT="${SMASH_ROSTER_DIR:-$BUILD_ROOT/roster}"
SITE="${SMASH_ROSTER_SITE:-https://smash.fun}"
COUNT="${SMASH_ROSTER_COUNT:-40}"
[[ -f "$OPENSMASH/targets/characters.py" ]] || { echo "opensmash checkout not found: $OPENSMASH (run game/build.sh first)" >&2; exit 2; }
mkdir -p "$OUT"
catalog="$(mktemp)"; trap 'rm -f "$catalog"' EXIT
curl -fsS -m 60 "$SITE/api/characters" -o "$catalog"
slugs="${SMASH_ROSTER_SLUGS:-$(python3 - "$catalog" "$COUNT" <<'PY'
import json, sys
rows = json.load(open(sys.argv[1]))["characters"]
print(",".join(r["slug"] for r in (rows if sys.argv[2] == "all" else rows[:int(sys.argv[2])])))
PY
)}"
cp "$catalog" "$OUT/catalog.json"   # kept so the cloud host can show smash.fun portrait URLs in the fighter grid
echo "Catalog has $(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1]))["characters"]))' "$catalog") fighters; staging: $slugs"
python3 "$OPENSMASH/targets/characters.py" --target native --output "$OUT" --site "$SITE" --catalog "$catalog" --characters "$slugs"
echo "Roster ready: $OUT/roster.txt"
