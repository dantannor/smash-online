# Smash Online

Local Smash 64 streaming/input prototype with a native game, OSI1 sidecar, signaling server, host, guest, and browser harness. DW3 and DW4 pass. DW4 verified a VS match, live guest video, and P2 input from a guest page. The ScreenCaptureKit helper now builds from `game/run-game.sh`. See [Phase 2 status](docs/evidence/phase2-status.json) and the [DW4 report](docs/evidence/dw4-report.json).

## Quickstart

```sh
./scripts/start.sh            # game -> sidecar (muted) -> local server -> host Chrome, via the Cloudflare Worker
./scripts/stop.sh             # stops exactly what start.sh started
```

`start.sh` checks the game binary, free ports (8765, 8787) and the Worker's `/healthz`, runs everything detached (it survives closing the terminal), and records pids and logs under `~/.smash-online/run/<timestamp>/` (`current` points at the active run). Running it again while a session is up just reprints the links. Then click **Start capture** in the host Chrome window (keep it in the foreground) and share the P2-P4 links shown on the host page; you play P1 from the host page. Options: `--no-browser` (print the host URL, open it yourself), `--local` (no Worker; local signaling, use `./server/tunnel.sh` for remote guests). Env overrides: `SMASH_ONLINE_BINARY`, `SMASH_SIGNAL_ORIGIN`, `SMASH_INPUT_FILE`, `SMASH_CHROME`, `SMASH_GAME_CMD` (replace the game, for tests), `SMASH_WATCHDOG=0` (by default `scripts/game-watchdog.sh` restarts the game when it exits (an engine crash), restarts the sidecar if the OSI1 file gets a new inode, and logs to `restarts.log` in the run dir; after a restart the host page must click Start capture again), `SMASH_CHROME_DEBUG_PORT` (expose Chrome DevTools on 127.0.0.1 so a script can click Start capture). `stop.sh` sends SIGTERM to each process group, force-kills after 5 seconds, and `--purge` also deletes the logs. `scripts/stop-live.sh` remains for the older hand-started `/tmp/smash-live` session.

## Local setup (manual steps)

1. Build the native game with the absolute local ROM path: `ROM_PATH='/Users/danieltannor/Downloads/Super Smash Bros. (USA).z64' ./game/build.sh`. The ROM and generated assets stay outside this repo.
2. Start `./game/run-game.sh`. It opens BattleShip windowed at VS character select and builds `sck-capture` when needed.
3. Start the sidecar in another terminal: `node sidecar/index.js --file /tmp/smash-online-input.osi1 --port 8765`.
4. Start signaling with `npm start` (port 8787).
5. Open `http://localhost:8787/host`, keep Capture source set to **Game window / screen**, click **Create room**, then click **Start capture** and share each guest's own link. If capture ends, click **Resume capture**; existing guests stay connected. The sidecar stays on the host Mac at loopback.
6. For a temporary remote link, run `./server/tunnel.sh` and share the P2 link. Stop the tunnel when the session ends. It carries signaling only; WebRTC media tries a direct peer connection using public STUN, with no TURN relay.

To stop a detached session started under `/tmp/smash-live`, run `./scripts/stop-live.sh`.

## Controls and limits

**Guest keyboard** (the page also lists these): WASD or arrows = stick at full tilt, **hold Shift for a half stick** (tilts and walking), J=A, K=B, L=Z, Q=L, E=R, Enter=Start, U/N/H/I = C buttons, F = fullscreen. Keys are read by physical position, so any keyboard layout works. In Smash 64 a **smash attack** is a full-stick flick plus A within a few frames, so press a direction and J together; a **tilt** is Shift + direction + J. There is no smash charging by holding A in this game. Holding does matter for DK's Giant Punch and Samus's Charge Shot (hold K), repeating jabs (hold J), running and shielding. Held input is faithful end to end: the sidecar holds the last input through a network or browser stall of up to `--input-timeout-ms` (default 2500; it used to neutralize after 500 ms, which released a held B mid-charge).

Guests use a keyboard or standard gamepad. **Recommended P1:** keep the host page tab focused; its "Play P1 here" box (on by default) sends keyboard (WASD/arrows, J=A, K=B, L=Z, Enter=Start) and gamepad input to the sidecar as a kind-3 pad, like any guest. Legacy P1 (kind 2, only before the host page connects) uses the focused game-window keyboard: W/A/S/D or arrows, J for A, K for B, L for Z, Space/Return for Start. See [game controls](game/README.md). The DW4 harness drove P1 through the local sidecar test hook and P2 through the guest WebRTC data channel.

The macOS BattleShip window capture produced a video track and no audio track. Guests therefore do not get game audio yet. `docs/evidence/dw8-audio.json` records the result and a no-install ScreenCaptureKit audio-bridge design. See [latency results](docs/LATENCY.md) and the [phone checklist](docs/PHONE-TEST.md).

## Tests

`npm test` runs the project suite with a 30-second per-test timeout. The real browser E2E runs with `SMASH_E2E_REAL=1 node --test harness/e2e.test.js`. `node harness/dw4-visible.mjs` runs the visible local game/host/guest proof. The headless local and tunnel latency probes are documented in [harness/README.md](harness/README.md). The default E2E run does not touch `harness/reports/e2e-sample.json`; set `UPDATE_E2E_SAMPLE=1` to refresh that checked-in sample on purpose.

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

The whole stack (game, OSI1 sidecar, local server, host page in Chrome) runs on a GCE VM instead of your Mac, and all four players, P1 included, join with a browser link. Game audio is sent too.

```sh
scripts/cloud.sh secrets [gcp-key.json]   # once: generate the link secrets and store them as Worker secrets (the key only when it changes)
scripts/cloud.sh links     # the invite link, the P1 link and the P2-P4 links
scripts/cloud.sh up        # or start it yourself: create/start/resume the VM, wait for a room, print the current links
scripts/cloud.sh down      # suspend the VM (memory and disk kept); `down --stop` powers it off instead
scripts/cloud.sh status | links --live | newroom | sync | idle <bootGraceMin> <idleMin> | machine <type> | ssh [cmd]
```

**Links.** All of them wake a stopped or suspended VM and drop you into the game when it is ready; the loading page shows progress, the invite link with a Copy button, and (on the P1 page) the friend links.
- **Invite link** (`/join/<secret>`): whoever opens it first becomes P1, the next P2, then P3 and P4; a fifth sees "game is full". A browser keeps its slot across reloads and short absences (it remembers a token in localStorage; a slot is held for 90 s after its guest leaves, then the next opener may take it).
- **P1 link** (`/go/<secret>`) and **friend links** (`/p/<secret>/2..4`): fixed slots, same wake behaviour.
- A guest page whose room has died (the VM restarted into a new room) notices after about 24 s and returns through the link it came from, which hands out the live room.
- Secrets are Worker secrets (`P1_SECRET`, `FRIEND_SECRET`, `INVITE_SECRET`, `VM_SECRET`, `GCP_SA_JSON`) plus `~/.smash-online/permanent.env` (0600) on your Mac; nothing is in the repo. The Worker holds the project's service-account key (the IAM API is disabled here, so a start/resume-only account could not be created) and calls `instances.start` / `resume` with a WebCrypto-signed JWT. It records every wake in a Durable Object (`GET /api/vm/wakes`, Bearer `VM_SECRET`) for diagnosing slow starts.

**Waking.** A suspended VM resumes (about 12 s for the API call, the VM keeps its processes); a stopped one boots (userspace boot trimmed from 28 s to 8 s). `smash-ctl` notices the clock jump on resume, probes the host page's signaling socket, and reloads the host page for a fresh room when it is dead or the room expired (rooms live 30 min without a socket). Capture starts as soon as the game window exists. The room is registered with the Worker every minute; the Worker treats a registration older than 150 s as "not running", so a stale room is never handed out.

Root cause of the 78 s overnight wake: after asking the Worker to suspend it, the controller slept a blind 60 s. The VM froze about two seconds into that sleep, so after every idle-triggered resume the whole controller loop stalled for the remaining ~58 s before it could notice the resume and refresh the room. (`cloud.sh down` suspends from outside, which is why earlier resume tests did not show it.) Fixed: the request no longer blocks the loop, all controller fetches have timeouts. A suspend of 75 minutes resumed in 9 s to a running guest, so long suspends are not slow in themselves.

**Start times** (headless browser opens the P1 link, seconds until the video is playing; t2d-standard-8, 2026-10-13):

| Path | Runs (s) | Mean |
|---|---|---|
| Before: idle-suspend then click (the overnight case, Daniel's real wake) | about 80 click to registered | about 80 |
| Idle-suspend then click (after the fix) | 13.1, 15.1, 13.7 | 14.0 |
| `cloud.sh down` then click (short suspend) | 14.4, 13.0, 12.4 | 13.3 |
| Stopped VM, cold start | 29.7, 29.2, 27.6 | 28.9 |

**Fighters.** All 12 original fighters (all unlocked) and the whole smash.fun catalog (1046 custom fighters, 88 pages of 12 after the originals page) are in the game. The guest page is one scrolling page like smash.fun's: the live game video on top (it autoplays muted; sound stays behind **Sound on**), and under it every fighter you can pick, originals as name tiles and custom fighters with smash.fun's public portraits (lazy-loaded), with a search box. Click one with the mouse to put that fighter on *your* player in the character select (guest, `meta` data channel, host page, sidecar `roster:pick`, a file the game polls; `cloud/vm/roster-hooks.patch` adds the game side); the page scrolls back up to the video. Picks stick across page flips, so one player can be an original and another a custom fighter. Keyboard: arrows, space and the other game keys go to the game and do not scroll the page; while focus is in the search box or on a fighter tile they behave normally (picking a fighter or pressing a button drops focus). The mouse wheel, touch and the scrollbar scroll the page as usual. The game boots into its real opening (the N64 intro movie, then the title and attract demos; `SSB64_START_SCENE=28` in `cloud/vm/run-game.sh`), so that is what plays in the video when a guest opens the page. A fighter pick, **Play vs CPU** or the Start key during the opening, title or attract demo jumps straight to the VS character select and the pick or solo request is applied there. A first guest arriving in an idle game (nobody connected for 60 s; the sidecar writes `<seq> 20 0 0` into the pick file) restarts the opening, but only when the game is on the title, the attract demo, the character select or a menu: a match is never touched, and a guest joining while another is connected sends nothing. Every request is dropped in any other scene, so a pick made mid-match does nothing. The game side is `cloud/vm/intro-hook.patch` (applied after the roster and solo patches): it polls the pick file every frame from the controller read and jumps scenes the way the console reset does.

**Single player (Play vs CPU).** From your own link, press **Play vs CPU** under the video (choose 1, 2 or 3 CPUs next to it); nobody else has to join. The guest sends `roster:solo` on the `meta` channel, the host page passes it to the sidecar, which writes `<seq> <10 + player> <mask of connected ports> <cpu count>` into the pick file; `cloud/vm/solo-hook.patch` (applied after the roster hooks by `cloud/vm/build-game.sh`) then gives you a random original fighter if you have not picked one, turns that many ports with no connected guest into CPUs (level 4, distinct random originals), and starts the match exactly as Start would (random stage, 5 stocks). Pick your fighter first if you want a specific one. Guests that are connected but have not chosen a fighter are dropped from that match, as with Start. It only acts on the character select screen; when a match ends the game returns there.

**Video.** The game window and capture are 1120x840 (`SMASH_VIDEO_W/H` in `/etc/smash-online.env`), up from 640x480 originally and 960x720 after that. Measured in a 4-player match, game swap rate and guest fps:

| Machine, size | Game swap fps (mean / p5 / min) | Guest fps | Verdict |
|---|---|---|---|
| c2d-highcpu-8, 960x720 | 59.9 / 59.8 / 58.2 | 59.5 | steady |
| c2d-highcpu-8, 1280x960 | 53.9 / n.a. / 47 | 58.5 (frames repeated) | game slows |
| c3-standard-8, 1440x1080 | 43 to 53 | 50 | no |
| t2d-standard-8, 960x720 | 60.0 / 59.9 / 58.2 | 59.5 | steady |
| t2d-standard-8, 1120x840 | 59.8 / 59.5 / 52.9 over 11.6 min | 59.0 | **steady, chosen** |
| t2d-standard-8, 1280x960 | 56.7 / 52.5 / 48.3 | 59.0 | slightly slow |
| t2d-standard-8, 1440x1080 | 46 to 53 | 58 | no |

t2d vCPUs are real cores (c2d and c3 vCPUs are hyperthreads), which is why t2d-standard-8 beats the other 8-vCPU types here; the project's 12 vCPU quota rules out 16-vCPU types. `LP_NUM_THREADS` 4 and 6 were no better than 8. The sender is seeded at 4000 kbps with a 6000 kbps cap (about 4.5 to 5.5 Mbps per guest measured). The guest page has a **Sharpen** toggle (a convolution filter on the video) for a softer picture.

**Latency** (`harness/stage/`, 2026-10-13, t2d-standard-8, 1120x840, guest on a Mac at 12 ms RTT through the Cloudflare relay, 60 trials per column; method per row in `harness/stage/README.md`). The test presses L/R on the character select (a whole-screen change) and times the first changed frame on the guest. Stages, in ms, median / p90:

| Stage | Before | After | Measured with |
|---|---|---|---|
| Key to `dataChannel.send` | 0.0 / 0.1 | 0.0 / 0.1 | guest `performance.now()` around the send |
| Guest to VM (data channel) | 7.5 / 56 | 7.4 / 58 | host-page receive time minus message `t`, clocks tied by 40 pings (the p90 is this Mac's Wi-Fi) |
| Host page to sidecar to OSI1 file | 0.8 / 2.4 | 0.7 / 2.4 | `vm-probe` file change minus host-page receive (VM clock) |
| Game: file read to new frame in Xvfb | 28.9 / 38 | 24.3 / 31 | `vm-probe` XShm grab of the screen, first changed frame minus file change |
| Xvfb to Chrome capture | 6.2 / 16 | 10.7 / 16 | `MediaStreamTrackProcessor` on the capture track |
| Capture to first byte at the guest (encode 2.5, pacer, network) | 115.8 / 363 | 44.8 / 108 | guest `requestVideoFrameCallback` `receiveTime` minus capture; sender stats: 2.5 ms encode per frame, pacer delay 21 ms per packet before and 2.9 ms after |
| Guest receive to picture (assembly, jitter buffer, decode, render) | 26.4 / 37 | 24.7 / 38 | rVFC callback minus `receiveTime`; decode is 0.5 ms |
| **Total (instrumented run)** | **200.6 / 450** | **113.0 / 197** | guest clock only |
| **Total (light run, nothing hooked, 2 x 60 trials pooled)** | **177.8 / 205** (n=120) | **104.5 / 160** (n=120) | same test, `LIGHT=1` |

The dominant stage was the WebRTC pacer: it releases queued packets at 2.5 times the bitrate, so a scene-change frame (40 to 80 KB at 5 Mbps) sat in the send queue for 60 to 100 ms, and more when the bandwidth estimate dipped. The host Chrome now starts with `--force-fieldtrials=WebRTC-Video-Pacing/factor:8.0/` (`SMASH_CHROME_EXTRA` in `/etc/smash-online.env`; set it empty to go back). Verified afterwards: 4 guests in a match at 1120x840 held 59.4 fps with 0 lost packets and 0 freezes, audio still flows, and under 15 ms +/- 10 ms jitter with 0.5% loss the playback smoothness equals the old setting (frames over 25 ms: 239 vs 207 to 220 per 45 s).

Tried and not adopted: forcing the receiver playout delay to 0 (`WebRTC-ForceSendPlayoutDelay`) saves another 10 to 15 ms on a clean link but doubles the number of late frames under jitter (about 560 vs 220 per 45 s); capturing at 120 fps cut the capture stage from 11 to 4 ms but not the total (the encoder cadence absorbs it); a pacer factor of 16 was no better than 8. What remains: the game (about 24 ms, one 60 Hz frame of input sampling plus the llvmpipe render), the jitter buffer (about 25 ms) and the network. The page-flip test is the worst case for the video path; gameplay frames are about 10 KB, so ordinary moves see less of the pacer delay than this test did.

**Audio.** The game plays into a PulseAudio null sink; a virtual source on its monitor is the host page's default input, sent as Opus to every guest through `getUserMedia` (Chrome cannot capture system audio on Linux). The first click or key press on a guest page turns sound on.

**Services** (systemd, all restart on failure): `smash-xvfb`, `smash-pulse`, `smash-game` (restarted by systemd when the engine aborts, game back in about 4 s), `smash-sidecar` (restarted when the OSI1 file gets a new inode), `smash-server`, `smash-chrome` (host page with `?p1guest=1&audio=1`) and `smash-ctl` (room, capture, links, Worker registration, idle suspend, resume recovery).

**Direct path.** The firewall rule `smash-allow-webrtc-udp` opens udp 50000-50099 and a Chrome policy keeps WebRTC inside it, so guests on ordinary networks can connect directly; Cloudflare TURN is the fallback. This Mac's Wi-Fi only lets UDP out to a few well-known ports, so guests here always use the relay (RTT 9 to 25 ms).

**Access.** The VM has no service account. Port 22 is not exposed: SSH runs over TLS on 443 (stunnel to sshd, key-only), allowed from your current public IP only (`cloud.sh up` refreshes the rule). `cloud.sh sync`, `up` and service restarts change rooms: do not run them while someone is playing.

**Engine crashes** (fixed 2026-10-14, root causes found with gdb and an ASan build on the VM). Four patches in `cloud/vm/`, applied by `build-game.sh`:
- `opening-vanilla.patch`: the game starts on custom-roster page 1, so the opening movie put custom fighters on its tiles; the run and clash scenes load files only for the original eight and the cliff scene uses a Link-only move, so the idle game crashed about 38 s after every boot. With `SSB64_OPENING_VANILLA=1` (set in `run-game.sh`) the opening uses the original fighters.
- `reloc-dedup.patch`: every scene re-registered the same persistent pointers in the RelocPointerTable, about 500 new slots per scene change, until the 1M-slot limit aborted the engine after a few hours. A pointer that already has a live slot now gets that slot's token back. It also logs one `RELOCSTAT` line per scene change.
- `particle-bank-reloc.patch`: freed particle banks now release their reloc slots instead of leaving tokens to freed memory.
- `arena-serial.patch`: two caches of custom-fighter state trusted pointers from an earlier scene. The mesh owner check compared scene kinds, so character select, stage select, character select dereferenced a recycled arena; and the per-player HUD sprite clones were fixed up a second time in a later scene, writing past their bitmap arrays (heap corruption, found with ASan). Both now key on a counter that bumps on every scene arena recycle.

Regression check: `cloud/vm/crash-soak.sh <seconds> [seed] [label]` (takes the game and sidecar down for the run, refuses while a guest is connected) exits 0 only with no crash and live reloc slots growing by at most 2000 over the second half. Menu churn: `SOAK_ARGS="--picks 2 --fighters 1046 --quit-every 20 --start-bias 0.1"`; idle game: `SOAK_MASH=0`. Results on t2d-standard-8: 10 min of churn (40 scene changes, 9 matches, 29 quits, 1023 fighter picks and page jumps) with 0 crashes; before, the same run crashed within 2 to 4 minutes. Live reloc slots still creep by about 40 per scene change (leaked HUD clones), roughly 80 hours of nonstop mashing to the limit. Still open: a double free in the engine's exit handler (the abort on every service stop) and a palette over-read in `GfxDpLoadTlut`, both harmless to play.

**Idle suspend.** After `SMASH_BOOT_GRACE_MIN` (30) minutes with no guest ever connected, and `SMASH_IDLE_MIN` (15) minutes with no guest once a session has happened, the VM asks the Worker (`POST /api/vm/suspend`, Bearer `VM_SECRET`) to suspend it; `SMASH_IDLE_ACTION=poweroff` powers off instead. Change the timeouts with `scripts/cloud.sh idle 30 15`.

**First run** (VM missing) creates `smash-online` (t2d-standard-8, me-west1-c, Ubuntu 24.04, 60 GB disk), uploads your ROM (`SMASH_ROM_PATH`) to the VM only, builds the game (Release), stages the full roster and installs the services. Measured on the earlier machine type: about 8 minutes.

**Tested** (4 headless browsers through the invite link, 11.6 min, 1120x840): 4 players steady 59.4 fps, 5.2 Mbps and 10 ms RTT per guest; a late joiner (P4) joined in 2 s; a guest that left and returned got its slot back in under 2 s; a reload mid-match was back in 1.3 s; with 100 ms added delay and 2% loss on the VM's egress guests held 59 fps with 22 freezes over 2 minutes; killing the game (`kill -9`) showed the menu again 4.3 s later; two matches ran to a results screen. Input to picture (guest input to the first changed video frame, character-select page flip, 14 trials) was 141 to 183 ms, median 172 ms at 10 ms RTT before the pacer fix below; it is now about 105 ms (see **Latency**).

**Cost** (estimates, check the billing page): t2d-standard-8 about $0.45 per hour while running; a suspended VM bills only storage for its memory image (up to about $1.5 per month for the 32 GB machine) and a stopped one nothing for compute; the 60 GB disk is a few dollars a month. Egress is the variable part: measured 4.5 to 5.5 Mbps per guest, so four guests are about 8 to 10 GB per hour, roughly $1 to $2 per hour at internet egress rates. Plan on $1.5 to $2.5 per hour for four players and $0.7 to $1 for one or two.

**Limits.** The engine crashed every 40 s on an idle game and within a few minutes of menu mashing until 2026-10-14 (see **Engine crashes**); a 10-minute mash and a 10-minute idle soak now run without one. Input-to-picture latency is about 105 ms (page-flip test, 12 ms RTT; the game itself is about 24 ms of it). The ROM lives only on the VM disk, never in the repo, a bucket or an image. The IAP route stays unusable until the project owner enables the IAP API and grants the tunnel role.

## Custom fighters (opensmash roster)

The game shows the 12 original fighters and opensmash's custom fighters (smash.fun catalog, 1046 at the time of writing) on character-select **pages**: page 0 is the 12 originals (all unlocked, Luigi, Ness, Captain Falcon and Jigglypuff included), and every page after it holds 12 custom fighters (88 pages for the full catalog; the engine allows 2048 entries). A custom fighter plays like the original it is based on. Picks stick when you flip pages, so one player can be an original and another a custom fighter.

1. `scripts/stage-roster.sh` downloads and hash-verifies the catalog into `~/Projects/smash-online-build/roster/` (never committed). It defaults to the first 40 fighters (about 100 MB); `SMASH_ROSTER_COUNT=all` stages everything (about 2.6 GB, a few minutes) and is what the cloud VM uses. `SMASH_ROSTER_SLUGS=a,b,c` stages a specific list.
2. `scripts/start.sh` picks it up automatically (`game/run-game.sh` sets `SSB64_ROSTER_FILE` and starts on page 1). `SMASH_ROSTER=vanilla` disables it; with no staged roster it falls back to vanilla.
3. In the game, switch pages with L/R (guest keyboard Q/E) or by moving the hand cursor to the left or right screen edge.
4. **Fighter grid (cloud host).** See the Fighters paragraph in the Google Cloud section: a smash.fun-style grid on the guest page, under the video, with search; a click puts that fighter on your player. The page-flip hook (`SSB64_ROSTER_PAGE_FILE`) and the pick hook (`SSB64_ROSTER_PICK_FILE`) live in `cloud/vm/roster-hooks.patch`.
