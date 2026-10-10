# Lane F: browser harness

The default `harness/e2e.test.js` run starts a local mock signaling service and mock sidecar on ephemeral ports, then opens one canvas host and three guest pages in headless Chromium. It never needs a ROM. The mock guest resends input at 60 Hz like the real client, and the E2E deliberately drops its first active data-channel packet to cover the unreliable no-retransmit channel. Timestamped E2E reports are ignored; `harness/reports/e2e-sample.json` is the checked-in mock run.

```sh
node --test harness/e2e.test.js
SMASH_E2E_REAL=1 node --test harness/e2e.test.js
SMASH_DEBUG=1 node server/index.js
node harness/debug-handshake.mjs
node harness/latency-probe.mjs --url http://127.0.0.1:8787 --seconds 10 --label local --mode local
node harness/latency-probe.mjs --url https://<current-tunnel-url> --seconds 10 --label tunnel --mode tunnel
```

Real mode starts `server/index.js` and `sidecar/index.js` on ephemeral ports, points `OPENSMASH_LAUNCHER_INPUT` at a temporary OSI1 file, and reads that file with `shared/protocol.js`'s `decodeOSI1`. It waits for the sidecar's initial OSI1 snapshot before launching the browser. It expects the real host and guest pages under `/host` and `/play`. The harness seeds `window.__SMASH_E2E_ROOM__ = { room, roomToken }` before the host scripts run so a test-created room can be used without putting its credential in the URL. The host should consume that seed only in the test harness flow; room credentials must not be logged.

## Page hooks and media barcode

Lane C/D should expose these hooks for the harness and diagnostics:

- Host: `window.__smashHostStats()`, returning host/video diagnostics and peer `rtcStats` when available.
- Guest: `window.__smashGuest = { state, stats(), lastInput, setVirtualInput(input) }`. `state.connected` and `state.port` identify the live guest; `stats()` should include WebRTC stats records when available. `setVirtualInput` sends the supplied buttons and axes through the normal input path.
- Host `?source=canvas` captures a deterministic canvas stream. Its top 12 pixel rows encode a 96-bit barcode: frame counter as uint32 big-endian, followed by the capture timestamp (`performance.timeOrigin + performance.now()`) as float64 big-endian. Each bit is black or white in a 4-pixel-wide bar, so the clock survives a 2× downscale; the latency probe scales its sample coordinates to the received video dimensions. The guest uses that timestamp and its local clock for the glass-to-glass estimate.

These hooks are test/diagnostic seams, not protocol changes. `harness/debug-handshake.mjs` runs one real host and P2 guest, records browser console/page/network errors and safe server WS message metadata, and redacts guest/room credentials in URLs. `SMASH_DEBUG=1` logs WS direction, role, message type, port, and connection ID, never tokens or SDP. `?testHooks=1` exposes a host-side P1 port-1 input hook for the visible DW4 run. If the lane implementations use a different stats shape, auth seed, or barcode encoding, reconcile them here and in the harness before enabling real-mode CI.

## Latency metrics

`latency-probe.mjs` measures selected candidate-pair RTT, average inbound jitter-buffer delay (`jitterBufferDelay / jitterBufferEmittedCount`), inbound frames-per-second/dropped/decoded, and barcode-based glass-to-glass delay. It writes `harness/reports/latency-<label>.json` and refreshes `harness/LATENCY.md`. Missing browser stats are reported as `n/a`, not treated as a test failure. The probe can target a local origin or a tunnel; both endpoints still need to expose the host/guest hooks and media barcode above.
