# Smash Online

Local Smash 64 streaming/input prototype with game, sidecar, signaling server, host, guest, and browser harness. DW3 now passes on the real local stack. Phase 2 is **blocked** at DW4: `game/run-game.sh` fails compiling its ScreenCaptureKit helper because the `swiftc` command passes a stray backslash. See [Phase 2 evidence](docs/evidence/phase2-status.json).

## Local setup

1. Build the native game using the absolute local ROM path: `ROM_PATH='/Users/danieltannor/Downloads/Super Smash Bros. (USA).z64' ./game/build.sh`. The ROM and generated assets stay outside this repository.
2. Start `./game/run-game.sh` for a windowed 640×480 game.
3. Start the input sidecar in another terminal: `node sidecar/index.js --file /tmp/smash-online-input.osi1 --port 8765`.
4. Start signaling: `npm start` (port 8787).
5. Open the host page, create a room, and share each guest's own link. The host and friends need network reachability to the signaling server; the sidecar stays on the host Mac at loopback.
6. For remote friends, use `server/tunnel.sh` to create a temporary Cloudflare quick tunnel, then share the guest link. The URL changes when the tunnel stops. Phase 0 has public STUN only, no TURN, so some NATs may prevent peer connections.

## Controls and current limits

Guests use keyboard or a standard gamepad; the guest input hook is available for tests. P1 is intended to use the game-window keyboard (kind 2); keep the game window focused. Mapping is documented in [game/README.md](game/README.md). Daniel still needs to manually verify P1 controls in VS character select. No host-page Gamepad-to-P1 path is currently implemented.

Audio capture from the BattleShip window was not reached because DW4 stopped at the game helper build. Canvas mode's generated audio is only a synthetic test tone and does not prove game audio. If the later macOS window-capture test has no game audio, the next option is a separate ScreenCaptureKit audio track (no install/paid tools), followed by a sync retest. See [docs/LATENCY.md](docs/LATENCY.md) for mock-only numbers and pending real measurements, and [docs/PHONE-TEST.md](docs/PHONE-TEST.md) for the later cellular test.

## Tests

`npm test` runs the project suite with a 30-second per-test timeout. Real-mode browser testing uses `SMASH_E2E_REAL=1`, but currently stops at the missing host page.
