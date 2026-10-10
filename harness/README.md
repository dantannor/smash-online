# Lane F: browser harness

The default `harness/e2e.test.js` run starts a local mock signaling service and mock sidecar, then opens one canvas host and three guest pages in headless Chromium. It never needs a ROM. Timestamped E2E reports are ignored; `harness/reports/e2e-sample.json` is the checked-in mock run.

```sh
node --test harness/e2e.test.js
SMASH_E2E_REAL=1 node --test harness/e2e.test.js
node harness/latency-probe.mjs --seconds 10 --label local
node harness/latency-probe.mjs --url https://your-tunnel.example --seconds 30 --label tunnel
```

Real mode starts `server/index.js` and `sidecar/index.js`, points `OPENSMASH_LAUNCHER_INPUT` at a temporary OSI1 file, and reads that file with `shared/protocol.js`'s `decodeOSI1`. It expects the real host and guest pages under `/host` and `/play`. The harness seeds `window.__SMASH_E2E_ROOM__ = { room, roomToken }` before the host scripts run so a test-created room can be used without putting its credential in the URL. The host should consume that seed only in the test harness flow; room credentials must not be logged.

## Page hooks and media barcode

Lane C/D should expose these hooks for the harness and diagnostics:

- Host: `window.__smashHostStats()`, returning host/video diagnostics and peer `rtcStats` when available.
- Guest: `window.__smashGuest = { state, stats(), lastInput, setVirtualInput(input) }`. `state.connected` and `state.port` identify the live guest; `stats()` should include WebRTC stats records when available. `setVirtualInput` sends the supplied buttons and axes through the normal input path.
- Host `?source=canvas` captures a deterministic canvas stream. Its top 12 pixel rows encode a 96-bit barcode: frame counter as uint32 big-endian, followed by the capture timestamp (`performance.timeOrigin + performance.now()`) as float64 big-endian. Each bit is black or white in one pixel, sampled across the first 96 pixels. The guest uses that timestamp and its local clock for the glass-to-glass estimate.

These hooks are test/diagnostic seams, not protocol changes. If the lane implementations use a different stats shape, auth seed, or barcode encoding, reconcile them here and in the harness before enabling real-mode CI.

## Latency metrics

`latency-probe.mjs` measures selected candidate-pair RTT, average inbound jitter-buffer delay (`jitterBufferDelay / jitterBufferEmittedCount`), inbound frames-per-second/dropped/decoded, and barcode-based glass-to-glass delay. It writes `harness/reports/latency-<label>.json` and refreshes `harness/LATENCY.md`. Missing browser stats are reported as `n/a`, not treated as a test failure. The probe can target a local origin or a tunnel; both endpoints still need to expose the host/guest hooks and media barcode above.
