#!/bin/bash
# Runs on the VM as the smash user: fetch the pinned game sources and build the Release binary.
# Same layout and pins as game/build.sh, so scripts/stage-roster.sh and the run scripts work unchanged.
# The ROM must already be at ~/rom.z64 (uploaded over the SSH tunnel; it never leaves the VM).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"   # absolute: the patches are applied with git -C
BUILD_ROOT="$HOME/Projects/smash-online-build"; SRC="$BUILD_ROOT/src"; ROM="${ROM_PATH:-$HOME/rom.z64}"
OPENSMASH_SHA=2a171e5dfadd6bff19adc9d80075eba233a7bc75
BATTLESHIP_SHA=81489fae817fc08cd4dbad43a61713db8339491e
DECOMP_SHA=eddd0c9ba8ce0b9e80a225929ce466adc2e999fe
LIBULTRASHIP_SHA=eb96ccd1059ce6a905b16e1f9884c51b22e85f35
TORCH_SHA=296f8abf1c543ebef936a6d3d661947b5ead30dd
[[ -f "$ROM" ]] || { echo "ROM missing: $ROM" >&2; exit 2; }
mkdir -p "$SRC"
[[ -d "$SRC/opensmash/.git" ]] || git clone -q https://github.com/turtlesoupy/opensmash "$SRC/opensmash"
[[ -d "$SRC/BattleShip/.git" ]] || git clone -q https://github.com/turtlesoupy/BattleShip "$SRC/BattleShip"
git -C "$SRC/opensmash" checkout -q --detach "$OPENSMASH_SHA"
git -C "$SRC/BattleShip" checkout -q --detach "$BATTLESHIP_SHA"
git -C "$SRC/BattleShip" submodule update --init --recursive 2>&1 | tail -2
for pair in "decomp:$DECOMP_SHA" "libultraship:$LIBULTRASHIP_SHA" "torch:$TORCH_SHA"; do
  [[ "$(git -C "$SRC/BattleShip/${pair%%:*}" rev-parse HEAD)" == "${pair#*:}" ]] || { echo "${pair%%:*} pin mismatch" >&2; exit 2; }
done
BS="$SRC/BattleShip"; OS="$SRC/opensmash"
if [[ ! -f "$BS/.smash-online-patches-applied" ]]; then
  git -C "$BS" apply "$OS/engines/ssb64/native/launcher.patch"
  git -C "$BS" apply "$OS/engines/ssb64/native/embedded.patch"
  python3 - "$BS/CMakeLists.txt" "$OS" <<'PY'
from pathlib import Path
import sys
cmake, opensmash = map(Path, sys.argv[1:])
text = cmake.read_text()
text = f'include_directories("{opensmash / "desktop/native"}")\n' + text
text += f'\ntarget_include_directories(${{PROJECT_NAME}} PRIVATE "{opensmash / "engines/ssb64/native"}" "{opensmash / "desktop/native"}")\n'
old = '        COMMENT "Extracting ${SSB64_VERSION} assets from ${SSB64_BASEROM} -> ${SSB64_O2R}"\n    )'
new = '        COMMENT "Extracting ${SSB64_VERSION} assets from ${SSB64_BASEROM} -> ${SSB64_O2R}"\n        VERBATIM\n    )'
assert old in text
cmake.write_text(text.replace(old, new, 1))
PY
  : > "$BS/.smash-online-patches-applied"
fi
# Native roster page jump (the web shell's search dialog has no native equivalent): see roster-hooks.patch. It lives in the decomp submodule.
if [[ ! -f "$BS/decomp/.smash-online-roster-hooks-applied" ]]; then
  git -C "$BS/decomp" apply "$HERE/roster-hooks.patch"
  : > "$BS/decomp/.smash-online-roster-hooks-applied"
fi
# Play vs CPU (guest page button): a solo-hook.patch request in the same pick file starts a match against CPUs. Applies on top of the roster hooks.
if [[ ! -f "$BS/decomp/.smash-online-solo-hook-applied" ]]; then
  git -C "$BS/decomp" apply "$HERE/solo-hook.patch"
  : > "$BS/decomp/.smash-online-solo-hook-applied"
fi
# Intro for an idle game (intro-hook.patch): guest requests made during the opening or title jump to the VS character select, and a
# first guest arriving in an idle game restarts the opening. Applies on top of the two patches above.
if [[ ! -f "$BS/decomp/.smash-online-intro-hook-applied" ]]; then
  git -C "$BS/decomp" apply "$HERE/intro-hook.patch"
  : > "$BS/decomp/.smash-online-intro-hook-applied"
fi
# Opening with the original fighters (opening-vanilla.patch, on when run-game.sh sets SSB64_OPENING_VANILLA=1): custom fighters on the
# opening's montage tiles crashed the idle game about 38 s after boot. Applies on top of the patches above.
if [[ ! -f "$BS/decomp/.smash-online-opening-vanilla-applied" ]]; then
  git -C "$BS/decomp" apply "$HERE/opening-vanilla.patch"
  : > "$BS/decomp/.smash-online-opening-vanilla-applied"
fi
# Custom-fighter mesh owner (osb5-owner-serial.patch): the saved owner GObj counted as alive whenever the scene KIND matched, so
# character select -> stage select -> character select dereferenced a recycled arena (SIGSEGV in osb5_release_owner under menu
# mashing). A per-recycle arena serial replaces the kind. Applies on top of the patches above.
if [[ ! -f "$BS/decomp/.smash-online-osb5-owner-serial-applied" ]]; then
  git -C "$BS/decomp" apply "$HERE/osb5-owner-serial.patch"
  : > "$BS/decomp/.smash-online-osb5-owner-serial-applied"
fi
# RelocPointerTable: re-registering a live pointer reuses its slot instead of leaking one per scene change (the table aborted after a few
# hours), plus one RELOCSTAT log line per scene change for crash-soak.sh (reloc-dedup.patch, in the BattleShip repo itself).
if [[ ! -f "$BS/.smash-online-reloc-dedup-applied" ]]; then
  git -C "$BS" apply "$HERE/reloc-dedup.patch"
  : > "$BS/.smash-online-reloc-dedup-applied"
fi
# Particle banks: a freed bank's buffers lived outside the scene arena, so their reloc slots stayed live and kept resolving to freed
# memory; the bank eviction now invalidates them too (particle-bank-reloc.patch, BattleShip repo).
if [[ ! -f "$BS/.smash-online-particle-bank-reloc-applied" ]]; then
  git -C "$BS" apply "$HERE/particle-bank-reloc.patch"
  : > "$BS/.smash-online-particle-bank-reloc-applied"
fi
VENV="$BUILD_ROOT/venv"
[[ -x "$VENV/bin/python" ]] || { python3 -m venv "$VENV"; "$VENV/bin/pip" install -q Pillow; }
cmake -S "$BS" -B "$BS/build-us" -GNinja -DCMAKE_BUILD_TYPE=Release -DSSB64_VERSION=us -DSSB64_BASEROM="$ROM" -DPython3_EXECUTABLE="$VENV/bin/python"
cmake --build "$BS/build-us"
ls -la "$BS/build-us/BattleShip" "$BS/build-us/BattleShip.o2r"
mkdir -p "$HOME/.smash-online" && gcc -shared -fPIC -o "$HOME/.smash-online/fps-probe.so" "$HERE/fps-probe.c" -ldl   # real swap rate -> /tmp/fps.log
echo BUILD-DONE
