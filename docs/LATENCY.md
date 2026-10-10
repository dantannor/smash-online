# Latency measurements

## Real local input path

`harness/reports/e2e-1791666378893.json` is the real server + sidecar + host + three-guest run. Across 15 input deliveries, latency was p50 **0.70 ms**, p95 **1.66 ms**, max **1.66 ms**. Each guest wrote only to its assigned OSI1 port; disconnect neutralized within 500 ms and the same link restored its slot.

This measures guest input to OSI1 observation on one Mac. It is not video latency or a network test.

## Pending

- DW4 game-window capture did not start. `game/run-game.sh` failed while compiling the ScreenCaptureKit helper: `clang: error: no such file or directory: '\\'`. See `docs/evidence/dw4-report.json`.
- Tunnel measurements and glass-to-glass are not run. The DW4 failure gate stopped the session before tunnel startup.
- `getStats()` RTT, jitter buffer, FPS, dropped frames, and glass-to-glass through local display capture and tunnel remain pending.

After fixing the literal backslash in the `swiftc` command in `game/run-game.sh`, run the DW4 loop first. Then run `node harness/latency-probe.mjs --seconds 10 --label local` against the live local host and `node harness/latency-probe.mjs --url https://<current-tunnel-url> --seconds 30 --label tunnel`. Keep the outputs separate and label each route.
