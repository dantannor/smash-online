# Smash Online

Local Smash 64 streaming/input prototype with a native game, OSI1 sidecar, signaling server, host, guest, and browser harness. DW3 and DW4 pass. DW4 verified a VS match, live guest video, and P2 input from a guest page. The ScreenCaptureKit helper now builds from `game/run-game.sh`. See [Phase 2 status](docs/evidence/phase2-status.json) and the [DW4 report](docs/evidence/dw4-report.json).

## Quickstart

```sh
./scripts/start.sh            # game -> sidecar (muted) -> local server -> host Chrome, via the Cloudflare Worker
./scripts/stop.sh             # stops exactly what start.sh started
```

`start.sh` checks the game binary, free ports (8765, 8787) and the Worker's `/healthz`, runs everything detached (it survives closing the terminal), and records pids and logs under `~/.smash-online/run/<timestamp>/` (`current` points at the active run). Running it again while a session is up just reprints the links. Then click **Start capture** in the host Chrome window (keep it in the foreground) and share the P2-P4 links shown on the host page; you play P1 from the host page. Options: `--no-browser` (print the host URL, open it yourself), `--local` (no Worker; local signaling, use `./server/tunnel.sh` for remote guests). Env overrides: `SMASH_ONLINE_BINARY`, `SMASH_SIGNAL_ORIGIN`, `SMASH_INPUT_FILE`, `SMASH_CHROME`, `SMASH_GAME_CMD` (replace the game, for tests), `SMASH_CHROME_DEBUG_PORT` (expose Chrome DevTools on 127.0.0.1 so a script can click Start capture). `stop.sh` sends SIGTERM to each process group, force-kills after 5 seconds, and `--purge` also deletes the logs. `scripts/stop-live.sh` remains for the older hand-started `/tmp/smash-live` session.

## Local setup (manual steps)

1. Build the native game with the absolute local ROM path: `ROM_PATH='/Users/danieltannor/Downloads/Super Smash Bros. (USA).z64' ./game/build.sh`. The ROM and generated assets stay outside this repo.
2. Start `./game/run-game.sh`. It opens BattleShip windowed at VS character select and builds `sck-capture` when needed.
3. Start the sidecar in another terminal: `node sidecar/index.js --file /tmp/smash-online-input.osi1 --port 8765`.
4. Start signaling with `npm start` (port 8787).
5. Open `http://localhost:8787/host`, keep Capture source set to **Game window / screen**, click **Create room**, then click **Start capture** and share each guest's own link. If capture ends, click **Resume capture**; existing guests stay connected. The sidecar stays on the host Mac at loopback.
6. For a temporary remote link, run `./server/tunnel.sh` and share the P2 link. Stop the tunnel when the session ends. It carries signaling only; WebRTC media tries a direct peer connection using public STUN, with no TURN relay.

To stop a detached session started under `/tmp/smash-live`, run `./scripts/stop-live.sh`.

## Controls and limits

Guests use a keyboard or standard gamepad. **Recommended P1:** keep the host page tab focused; its "Play P1 here" box (on by default) sends keyboard (WASD/arrows, J=A, K=B, L=Z, Enter=Start) and gamepad input to the sidecar as a kind-3 pad, like any guest. Legacy P1 (kind 2, only before the host page connects) uses the focused game-window keyboard: W/A/S/D or arrows, J for A, K for B, L for Z, Space/Return for Start. See [game controls](game/README.md). The DW4 harness drove P1 through the local sidecar test hook and P2 through the guest WebRTC data channel.

The macOS BattleShip window capture produced a video track and no audio track. Guests therefore do not get game audio yet. `docs/evidence/dw8-audio.json` records the result and a no-install ScreenCaptureKit audio-bridge design. See [latency results](docs/LATENCY.md) and the [phone checklist](docs/PHONE-TEST.md).

## Tests

`npm test` runs the project suite with a 30-second per-test timeout. The real browser E2E runs with `SMASH_E2E_REAL=1 node --test harness/e2e.test.js`. `node harness/dw4-visible.mjs` runs the visible local game/host/guest proof. The headless local and tunnel latency probes are documented in [harness/README.md](harness/README.md).

## Hosted on Cloudflare

`cloud/` is the same signaling API as `server/` as a Cloudflare Worker with one SQLite-backed Durable Object per room (WebSocket Hibernation; rooms expire 30 minutes after the last activity but never while a socket is connected). Static pages come from Workers static assets, assembled by `npm run cloud:build` into `cloud/public` (host, play, shared; never ROMs).

- Deploy (free plan, uses the existing `wrangler login`): `npm run cloud:deploy`. Worker name `smash-online`, served at its `workers.dev` URL.
- `/api/ice` always returns `stun:stun.cloudflare.com:3478`. If the Worker secrets `TURN_KEY_ID` and `TURN_KEY_API_TOKEN` exist it also returns short-lived Cloudflare Realtime TURN credentials (including `turns:` on 443). Create a TURN key in the dashboard (Realtime, TURN), then from the repo root: `npx wrangler secret put TURN_KEY_ID --config cloud/wrangler.toml` and the same for `TURN_KEY_API_TOKEN`.
- Guest pages accept `?relay=1` to force relay-only ICE for testing.
- The host page stays on the local server (so it can reach the sidecar at `ws://127.0.0.1:8765` without browser local-network prompts) and uses the Worker for rooms and signaling: open `http://127.0.0.1:8787/host?signal=https://<worker>.workers.dev`, or start the local server with `SMASH_SIGNAL_ORIGIN=https://<worker>.workers.dev` and `/host` redirects there. Guest links point at the Worker's `/play`. The Worker allows CORS from `http://127.0.0.1` / `http://localhost` only.
- Measured (2026-10-11, live game window captured by the local host page in Worker mode, headless Chromium P3 guest, 30 s window): with `?relay=1` the selected pair was relay/udp on both ends (Cloudflare TURN), RTT about 10 ms, 57.5 fps average (min 56), 0 to 1 packets lost, no reconnects; P3 stick and A reached port 2 and the P3 cursor moved in the real game. Without forcing relay the same-machine guest picked host/host (RTT 0, 57.4 fps), which says nothing about friends; this Wi-Fi has symmetric NAT and blocked Google STUN, so remote friends depend on the relay path.
- The host tab must be foreground for `getDisplayMedia` (Chrome refuses it on a backgrounded page with `InvalidStateError`).
- Tests: `node --test cloud/worker.test.js` (starts `wrangler dev --local`).
