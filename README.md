# Smash Online

Local Smash 64 streaming/input prototype with game, sidecar, signaling server, host, guest, and browser harness. Phase 2 is **blocked**: mock tests pass, but the real-browser harness times out after opening the host canvas and guest page, before the guest reports a connected WebRTC session. See [Phase 2 evidence](docs/evidence/phase2-status.json).

## Local setup

1. Build the native game using the absolute local ROM path: `ROM_PATH='/Users/danieltannor/Downloads/Super Smash Bros. (USA).z64' ./game/build.sh`. The ROM and generated assets stay outside this repository.
2. Start `./game/run-game.sh` for a windowed 640×480 game.
3. Start the input sidecar in another terminal: `node sidecar/index.js --file /tmp/smash-online-input.osi1 --port 8765`.
4. Start signaling: `npm start` (port 8787).
5. Open the host page, create a room, and share each guest's own link. The host and friends need network reachability to the signaling server; the sidecar stays on the host Mac at loopback.
6. For remote friends, use `server/tunnel.sh` to create a temporary Cloudflare quick tunnel, then share the guest link. The URL changes when the tunnel stops. Phase 0 has public STUN only, no TURN, so some NATs may prevent peer connections.

## Controls and current limits

Guests use keyboard or a standard gamepad; the guest input hook is available for tests. P1 is intended to use the game-window keyboard (kind 2); keep the game window focused. Mapping is documented in [game/README.md](game/README.md). Daniel still needs to manually verify P1 controls in VS character select. No host-page Gamepad-to-P1 path is currently implemented.

Audio capture has not been verified on macOS. The host requests audio from `getDisplayMedia`, but window-capture audio support varies by Chrome/macOS capture source. Do not assume BattleShip audio is streamed. If the manual test confirms silence, the next option is a separate ScreenCaptureKit audio capture track (no install/paid tools), then retest synchronization. See [docs/LATENCY.md](docs/LATENCY.md) for mock-only numbers and pending real measurements, and [docs/PHONE-TEST.md](docs/PHONE-TEST.md) for the later cellular test.

## Tests

`npm test` runs the project suite with a 30-second per-test timeout. Real-mode browser testing uses `SMASH_E2E_REAL=1`, but currently stops at the missing host page.
