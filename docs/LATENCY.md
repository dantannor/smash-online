# Latency measurements

## Available measurement

The only valid measurement so far is the mock E2E harness, not a real WebRTC/G2G measurement. `harness/reports/e2e-sample.json` reports 15 mock input-routing samples: p50 **0.81 ms**, p95 **8.23 ms**, max **8.23 ms**. These numbers do not include encoding, network transport, video playback, or game response.

## Pending

- Local real host + guest: pending. The guarded real harness opened the host page and canvas, then failed to complete guest connection and hit the 60-second Node test timeout. No real input-routing samples were produced.
- Cloudflare tunnel real host + guest: pending until the local real loop passes; no tunnel was started.
- `getStats()` RTT, jitterBufferDelay, FPS, dropped frames, and glass-to-glass barcode delay: pending. A real host capture page and barcode-bearing stream are required.
- DW6 JSON evidence: pending; no real/tunnel latency JSON is claimed.

Once the host exists, run `node harness/latency-probe.mjs --seconds 10 --label local`, then start the tunnel and run `node harness/latency-probe.mjs --url https://<current-tunnel-url> --seconds 30 --label tunnel`. Keep the generated JSON reports alongside this document, and label the results by route.
