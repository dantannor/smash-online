# Latency measurements

## Real local input path

`harness/reports/e2e-1791666378893.json` is the real server + sidecar + host + three-guest run. Across 15 input deliveries, latency was p50 **0.70 ms**, p95 **1.66 ms**, max **1.66 ms**. Each guest wrote only to its assigned OSI1 port; disconnect neutralized within 500 ms and the same link restored its slot. This measures input-to-OSI1 observation on one Mac, not video latency.

## DW6 WebRTC video probe

`docs/evidence/dw6-latency.json` records two 10-second runs with **39 samples each** and a guest video size of **640×360**. Local: RTT **0.00 ms**, average jitter buffer **6.93 ms**, **60.23 FPS**, zero dropped frames, glass-to-glass estimate **25.82 ms mean / 27.50 ms median**. Tunnel: RTT **0.97 ms**, average jitter buffer **7.19 ms**, **60.13 FPS**, zero dropped frames, glass-to-glass estimate **26.87 ms mean / 26.80 ms median**.

These use the live signaling server and real WebRTC peers, but the host source is the deterministic canvas barcode, not the game window. The barcode measurement is a synthetic glass-to-glass estimate. The Cloudflare quick tunnel carries signaling; WebRTC media negotiated a direct peer path on this same Mac, so this is not a Cloudflare-relayed media-latency result. The barcode uses 4-pixel-wide source bars and scales its decode coordinates to survive 2× video downscaling.

## DW4 game loop

DW4 passed with the local BattleShip window: see `docs/evidence/dw4-report.json`. The launcher now builds the ScreenCaptureKit helper successfully. The sidecar must keep the same OSI1 inode: `game/init-input.mjs` now initializes an existing file in place because the game and sidecar hold open descriptors.

## Limits

- This does not measure phone/cellular latency, WAN media relay, audio latency, or BattleShip game-frame latency.
- `getDisplayMedia` returned only a video track for the BattleShip window; see `docs/evidence/dw8-audio.json`. Guest game audio remains unsupported pending the documented ScreenCaptureKit audio bridge.
