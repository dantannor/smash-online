# Lane A: native game integration

The build consumes the local US ROM only by its absolute `ROM_PATH`. It never copies it into the repo. Source clones, extracted `.o2r` assets, Python dependencies, and all build output live under `~/Projects/smash-online-build/`.

## Build and launch

```sh
ROM_PATH='/Users/danieltannor/Downloads/Super Smash Bros. (USA).z64' ./game/build.sh
./game/run-game.sh
```

`build.sh` pins OpenSmash `2a171e5dfadd6bff19adc9d80075eba233a7bc75`, BattleShip `81489fae817fc08cd4dbad43a61713db8339491e`, and submodules recorded in the script. It initializes a local Pillow venv, applies the OpenSmash launcher and embedded-frame patches to the isolated BattleShip clone, and configures `build-us` with the absolute ROM path. `run-game.sh` launches the resulting `BattleShip` binary from its build directory with `OPENSMASH_LAUNCHER_INPUT` (default `/tmp/smash-online-input.osi1`), mute byte 0, `SSB64_BOOT_SLOTS=hhhh`, and `SSB64_START_SCENE=16`. It seeds P1 as kind-2 keyboard input and P2–P4 as neutral kind-3 pads so VS character select exposes four human slots at boot. It prints the process and window IDs when available. Set `SMASH_ONLINE_BINARY` to override the binary path.

The generated native executable uses the ROM-derived `.o2r` assets made during build; ROM path is a build input, not a runtime input-file path. Do not place ROMs or generated assets in this repository.

## P1 controls and pad decision

While the OSI1 file is active, P1 defaults to kind 2, BattleShip window keyboard input. Keep the game window focused and use **W/A/S/D** (or arrows) to move, **J** A, **K** B, **L** Z, **Space/Return** Start, **I/O** L/R, and **T/G/F/H/U** for D-pad down/up/left/right and C-up. These are SDL keyboard-state reads from the game window. No synthetic key event was sent, because doing so could steal focus; Daniel should verify the mapping manually in VS character select.

A physical pad needs a separate native reader because the active OSI1 file supplies all four ports and kind 2 intentionally selects keyboard state. Lane B should implement an optional local pad helper (SDL GameController API is a suitable native source) that emits JSON Lines on stdout:

```json
{"type":"p1-input","seq":1,"t":12.5,"buttons":0,"sx":0,"sy":0}
```

Emit at 60 Hz and immediately on change; `seq` is uint32, `t` is monotonic milliseconds, `buttons` uses the shared 16-bit mask, and axes are clamped to ±80. The sidecar should consume that stream, write P1 as kind 3 using `shared/protocol.js` `encodeOSI1`, advance the OSI1 byte sequence on every frame, and update the existing file in place. The native reader keeps the file descriptor open, so atomic rename swaps the path but leaves the game reading a stale inode. Neutralize P1 on helper disconnect. No native pad helper is included in lane A.

## Four-port input proof

`run-game.sh` starts directly at US-build VS character select. Pass its game PID to the proof runner:

```sh
node game/proof-inputs.mjs --pid <pid>
```

The proof holds one kind-3 port at a time (P1 up, P2 right, P3 down, P4 left), updates the existing OSI1 file in place at 16 ms intervals, and captures the BattleShip-owned window through ScreenCaptureKit (with fresh `screencapture -l` fallback), without changing focus. PNGs and `report.json` go to `game/proof/`. Check every screenshot for independent cursor movement.
