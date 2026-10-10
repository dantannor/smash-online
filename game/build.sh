#!/usr/bin/env bash
set -euo pipefail

ROM_PATH="${ROM_PATH:-}"
if [[ -z "$ROM_PATH" || "$ROM_PATH" != /* || ! -f "$ROM_PATH" ]]; then
  echo 'Set ROM_PATH to the absolute path of the US ROM file.' >&2
  exit 2
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
BUILD_ROOT="$HOME/Projects/smash-online-build"
SOURCE_ROOT="$BUILD_ROOT/src"
OPENSMASH_SHA=2a171e5dfadd6bff19adc9d80075eba233a7bc75
BATTLESHIP_SHA=81489fae817fc08cd4dbad43a61713db8339491e
DECOMP_SHA=eddd0c9ba8ce0b9e80a225929ce466adc2e999fe
LIBULTRASHIP_SHA=eb96ccd1059ce6a905b16e1f9884c51b22e85f35
TORCH_SHA=296f8abf1c543ebef936a6d3d661947b5ead30dd
REF_ROOT="$HOME/Projects/smash-online-ref"
OPENSMASH="$SOURCE_ROOT/opensmash"
BATTLESHIP="$SOURCE_ROOT/BattleShip"
OUTPUT="$BATTLESHIP/build-us"
VENV="$BUILD_ROOT/venv"

for tool in git cmake ninja python3; do
  command -v "$tool" >/dev/null || { echo "Missing required tool: $tool" >&2; exit 2; }
done
mkdir -p "$SOURCE_ROOT" "$BUILD_ROOT"

clone_pinned() {
  local name="$1" source="$2" path="$3" revision="$4"
  if [[ ! -d "$path/.git" ]]; then
    git clone "$source" "$path"
  fi
  local actual
  actual="$(git -C "$path" rev-parse HEAD)"
  if [[ "$actual" != "$revision" ]]; then
    git -C "$path" fetch origin "$revision"
    git -C "$path" checkout --detach "$revision"
  fi
  actual="$(git -C "$path" rev-parse HEAD)"
  [[ "$actual" == "$revision" ]] || { echo "$name pin mismatch: $actual" >&2; exit 2; }
}

clone_pinned OpenSmash "$REF_ROOT/opensmash" "$OPENSMASH" "$OPENSMASH_SHA"
clone_pinned BattleShip "$REF_ROOT/BattleShip" "$BATTLESHIP" "$BATTLESHIP_SHA"
git -C "$BATTLESHIP" submodule update --init --recursive
for pair in "decomp:$DECOMP_SHA" "libultraship:$LIBULTRASHIP_SHA" "torch:$TORCH_SHA"; do
  name="${pair%%:*}"; expected="${pair#*:}"
  actual="$(git -C "$BATTLESHIP/$name" rev-parse HEAD)"
  [[ "$actual" == "$expected" ]] || { echo "$name pin mismatch: $actual" >&2; exit 2; }
done

# OpenSmash's desktop helper applies these two engine patches. Apply them
# directly to this isolated build clone and add the helper-header include paths.
PATCH_MARKER="$BATTLESHIP/.smash-online-patches-applied"
if [[ ! -f "$PATCH_MARKER" ]]; then
  git -C "$BATTLESHIP" apply "$OPENSMASH/engines/ssb64/native/launcher.patch"
  git -C "$BATTLESHIP" apply "$OPENSMASH/engines/ssb64/native/embedded.patch"
  python3 - "$BATTLESHIP/CMakeLists.txt" "$OPENSMASH" <<'PY'
from pathlib import Path
import sys
cmake, opensmash = map(Path, sys.argv[1:])
text = cmake.read_text()
text = f'include_directories("{opensmash / "desktop/native"}")\n' + text
text += f'\ntarget_include_directories(${{PROJECT_NAME}} PRIVATE "{opensmash / "engines/ssb64/native"}" "{opensmash / "desktop/native"}")\n'
old = '        COMMENT "Extracting ${SSB64_VERSION} assets from ${SSB64_BASEROM} -> ${SSB64_O2R}"\n    )'
new = '        COMMENT "Extracting ${SSB64_VERSION} assets from ${SSB64_BASEROM} -> ${SSB64_O2R}"\n        VERBATIM\n    )'
if old not in text:
    raise SystemExit('Expected ROM extraction command not found; cannot quote ROM path safely.')
text = text.replace(old, new, 1)
cmake.write_text(text)
PY
  : > "$PATCH_MARKER"
fi

if [[ ! -x "$VENV/bin/python" ]] || ! "$VENV/bin/python" -c 'import PIL' >/dev/null 2>&1; then
  python3 -m venv "$VENV"
  "$VENV/bin/python" -m pip install Pillow
fi

cmake -S "$BATTLESHIP" -B "$OUTPUT" -GNinja \
  -DSSB64_VERSION=us \
  -DSSB64_BASEROM="$ROM_PATH" \
  -DPython3_EXECUTABLE="$VENV/bin/python"
cmake --build "$OUTPUT"
printf '\nBuilt executable: %s/BattleShip\n' "$OUTPUT"
printf 'OpenSmash pin: %s\nBattleShip pin: %s\n' "$OPENSMASH_SHA" "$BATTLESHIP_SHA"
