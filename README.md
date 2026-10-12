# Smash Online

Local Smash 64 streaming/input prototype with a native game, OSI1 sidecar, signaling server, host, guest, and browser harness. DW3 and DW4 pass. DW4 verified a VS match, live guest video, and P2 input from a guest page. The ScreenCaptureKit helper now builds from `game/run-game.sh`. See [Phase 2 status](docs/evidence/phase2-status.json) and the [DW4 report](docs/evidence/dw4-report.json).

## Quickstart

```sh
./scripts/start.sh            # game -> sidecar (muted) -> local server -> host Chrome, via the Cloudflare Worker
./scripts/stop.sh             # stops exactly what start.sh started
```

`start.sh` checks the game binary, free ports (8765, 8787) and the Worker's `/healthz`, runs everything detached (it survives closing the terminal), and records pids and logs under `~/.smash-online/run/<timestamp>/` (`current` points at the active run). Running it again while a session is up just reprints the links. Then click **Start capture** in the host Chrome window (keep it in the foreground) and share the P2-P4 links shown on the host page; you play P1 from the host page. Options: `--no-browser` (print the host URL, open it yourself), `--local` (no Worker; local signaling, use `./server/tunnel.sh` for remote guests). Env overrides: `SMASH_ONLINE_BINARY`, `SMASH_SIGNAL_ORIGIN`, `SMASH_INPUT_FILE`, `SMASH_CHROME`, `SMASH_GAME_CMD` (replace the game, for tests), `SMASH_WATCHDOG=0` (by default `scripts/game-watchdog.sh` restarts the game when it exits, e.g. the engine's periodic RelocPointerTable abort, restarts the sidecar if the OSI1 file gets a new inode, and logs to `restarts.log` in the run dir; after a restart the host page must click Start capture again), `SMASH_CHROME_DEBUG_PORT` (expose Chrome DevTools on 127.0.0.1 so a script can click Start capture). `stop.sh` sends SIGTERM to each process group, force-kills after 5 seconds, and `--purge` also deletes the logs. `scripts/stop-live.sh` remains for the older hand-started `/tmp/smash-live` session.

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

## Running on Google Cloud (Tel Aviv VM)

The whole stack (game, OSI1 sidecar, local server, host page in Chrome) can run on a GCE VM instead of your Mac, and all four players, P1 included, join with a browser link.

```sh
scripts/cloud.sh up        # create or start the VM, wait for a room, print the P1-P4 links (about 1 minute from a stopped VM)
scripts/cloud.sh down      # stop the VM; the disk is kept, so the next `up` skips the build
scripts/cloud.sh status | links | newroom | sync | idle <bootGraceMin> <idleMin> | ssh [cmd]
```

- **First run** (VM missing) creates `smash-online` (c2d-highcpu-8, me-west1-c, Ubuntu 24.04, 60 GB disk, Release build), uploads your ROM (`SMASH_ROM_PATH`, default `~/Downloads/Super Smash Bros. (USA).z64`) to the VM only, builds the game, stages the custom roster and installs the services. Expect about 20 to 25 minutes. It needs `gcloud` authenticated for the project (`SMASH_GCP_PROJECT`, default `smash-online-511318`; `SMASH_GCLOUD` points at the binary). Optional settings go in `~/.smash-online/cloud.env`.
- **Services** (systemd, all restart on failure): `smash-xvfb` (640x480 virtual display), `smash-game` (Release build with `SSB64_ROSTER_FILE`; restarted by systemd when the engine aborts, which replaces `game-watchdog.sh`), `smash-sidecar` (restarted when the OSI1 file gets a new inode), `smash-server` (host page on 127.0.0.1:8787), `smash-chrome` (host page with `?p1guest=1`, so P1 is a guest slot and "Play P1 here" is off) and `smash-ctl`. `smash-ctl` drives Chrome over its DevTools port: it creates the room, clicks Start capture (and again if capture ever ends), publishes the links to GCE guest attributes (`smash/status`), and runs the idle shutdown. Capture is the whole virtual screen, so a game restart needs no click: guests see a few black seconds and then the new game.
- **Signaling and media** use the existing Cloudflare Worker and its TURN relay. The Worker's `POST /api/rooms` accepts `{"p1Guest": true}` to add a P1 slot; without it rooms stay P2-P4. `?p1guest=1` on the host page sends it.
- **Access**: the VM has no service account. Port 22 is not exposed. SSH runs over TLS on 443 (stunnel to sshd, key-only, no root login, dedicated key in `~/.smash-online/`), and the firewall rule `smash-allow-ssh-tls` admits only your current public IP as a /32; `cloud.sh up` refreshes it on every run, so `up` again after your IP changes. A `smash-allow-iap-ssh` rule (IAP range) is also kept in case IAP is enabled for the project later. Links reach your Mac through guest attributes, with no inbound port at all.
- **Idle shutdown**: the VM powers itself off after `SMASH_BOOT_GRACE_MIN` (default 30) minutes from when the services start (boot) with no guest ever connected, and after `SMASH_IDLE_MIN` (default 15) minutes with no guest connected once a session has happened. Change them live with `scripts/cloud.sh idle 30 15` (stored in `/etc/smash-online.env` on the VM). A guest tab left open counts as connected.
- **Cost** (estimates, check the billing page): the VM is roughly $0.40 per hour while running (c2d-highcpu-8, Tel Aviv) and nothing for compute when stopped; the 60 GB disk is a few cents a day. Egress is the variable part: each guest receives up to 6 Mbps (about 2.7 GB per hour, roughly $0.30 to $0.60 per hour per guest at internet egress rates), and a static menu screen costs almost nothing. Plan on about $1 to $2 per hour for four active players, and run `scripts/cloud.sh down` when you finish.
- **Measured** (2026-10-12, Mac on this Wi-Fi, P1 and P2 as headless guests for 30 s on the character-select screen): ICE pair relay/udp to srflx/udp, RTT 73 to 80 ms average (max 131; the symmetric NAT forces the Cloudflare relay, so this is the relay path, not a direct 8-20 ms one), 54 to 60 fps, 0 to 1 packets lost, P1 input moved the P1 cursor. A cold `up` from a stopped VM took 65 s. The VM held 100% of one core for the game (llvmpipe) and about 10% each for the two Chrome processes.
- **Limits**: game audio is still not sent (no audio track, same as on the Mac). The engine still aborts about every 3 hours (systemd restarts it; a match in progress is lost). The ROM lives only on the VM disk (`~/rom.z64`), never in the repo, a bucket or an image. `cloud.sh sync` copies the current checkout to the VM and reinstalls the services.

## Custom fighters (opensmash roster)

The game can show opensmash's custom fighters (smash.fun catalog, ~1000 total) on extra character-select pages, next to the 12 vanilla ones.

1. `scripts/stage-roster.sh` downloads and hash-verifies the first 40 catalog fighters (Donald Trump, Obama, etc.) into `~/Projects/smash-online-build/roster/` (about 100 MB, never committed). `SMASH_ROSTER_COUNT=N` or `SMASH_ROSTER_SLUGS=a,b,c` change the set.
2. `scripts/start.sh` picks it up automatically (`game/run-game.sh` sets `SSB64_ROSTER_FILE` and starts on page 1). `SMASH_ROSTER=vanilla` disables it; with no staged roster it falls back to vanilla.
3. On the select screen, switch pages with L/R (guest keyboard Q/E) or move the hand cursor to the left/right screen edge. Page 0 is the vanilla 12; pages 1+ are 12 custom fighters each.
