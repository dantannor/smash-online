# Smash Online

**Smash Bros. 64 with friends, in a browser tab. No install, no ROM, no emulator for the people playing.**

https://github.com/user-attachments/assets/d3a589cf-1443-4926-8914-97371bd40b97

*Trailer from [turtlesoupy/opensmash](https://github.com/turtlesoupy/opensmash), the project this game is built on. It shows the custom fighters we use here.*

### [Play now: smash-online.reddit-service-site.workers.dev](https://smash-online.reddit-service-site.workers.dev)

> The live game is invite-only: it runs on one cloud VM, and the host shares a join link. Opening the bare URL shows a 404 on purpose.

*Fan project. Not affiliated with, endorsed by, or sponsored by Nintendo. No Nintendo ROMs, assets, or game files are in this repo.*

## What it is

One machine runs the real game (a native PC port of Smash 64) and streams it as WebRTC video. Up to four players open a link in any modern browser and play with a keyboard or gamepad. Their inputs travel back to the host and drive the game's controller ports. P1 is a browser too, so the host machine can be a headless VM.

## Features

- **Four players, zero installs.** Open a link, press keys. The first to open the invite link is P1, the next P2, and so on.
- **Low-latency stream.** 60 fps H.264 over WebRTC, with a TURN relay fallback for strict networks. Measured results are in [docs/LATENCY.md](docs/LATENCY.md).
- **Keyboard and gamepad.** Full stick and half-stick (tilt) support, all N64 buttons.
- **Pick your fighter from the page.** Scroll under the video, search, click. All 12 originals and the 1000+ custom fighters from [smash.fun](https://smash.fun) are available.
- **Play vs CPU** button for when your friends are late.
- **Wakes on demand.** The VM suspends when idle; opening a link resumes it in about 13 seconds, or 29 seconds from a cold stop.
- **Rejoin-safe.** Reload the tab or lose Wi-Fi and you keep your slot for 90 seconds.

https://github.com/user-attachments/assets/97b41166-8646-4dd5-ab45-80ee5d275297

*Opensmash custom fighters running on real N64 hardware, also from [turtlesoupy/opensmash](https://github.com/turtlesoupy/opensmash). Our version streams the PC port to a browser instead.*

## How to play

| Key | Action |
|---|---|
| WASD / arrows | Stick (hold **Shift** for a half stick: tilts, walking) |
| J / K / L | A / B / Z |
| Q / E | L / R |
| Enter | Start |
| U / N / H / I | C buttons |
| F | Fullscreen |

A smash attack is a stick flick plus A, so press a direction and J together. A tilt is Shift + direction + J. A standard gamepad works too. The page lists these controls and mutes the video until you click **Sound on**.

## Run it yourself

You need your own legally obtained US Smash 64 ROM. It stays on your machine and is never committed or served.

```sh
ROM_PATH='/path/to/Super Smash Bros. (USA).z64' ./game/build.sh   # builds the native game from pinned sources
./scripts/start.sh     # game, input sidecar, local server and host page
./scripts/stop.sh
```

Then click **Start capture** in the host window and share the player links it shows. `start.sh --local` skips the Cloudflare Worker and uses local signaling. For the cloud setup (Cloudflare Worker plus a Google Cloud VM that wakes on demand), custom fighters, and every option, see [docs/DETAILS.md](docs/DETAILS.md). Tests: `npm test`.

## How it works

```
 guest browser  <--WebRTC video / input data channel-->  host page (Chrome)
       |                                                      |
       '--- WebSocket signaling (Cloudflare Worker + DO) -----'
                                                              |
                                       input sidecar --> OSI1 file --> game
```

- **Game:** the BattleShip native port of Smash 64, built locally from your ROM with small patches (launcher input file, roster, scene hooks in [`cloud/vm`](cloud/vm)).
- **Sidecar:** [`sidecar/`](sidecar) turns guest input into an 80-byte OSI1 file the game polls every frame. The format is in [PROTOCOL.md](PROTOCOL.md).
- **Host page:** [`host/`](host) captures the game window and sends it to each guest over WebRTC, and forwards their input to the sidecar.
- **Guest page:** [`guest/`](guest) plays the video, reads the keyboard and gamepad, and shows the fighter grid.
- **Signaling:** [`cloud/`](cloud) is a Cloudflare Worker with one Durable Object per room. It also holds the secret join links and wakes the VM. [`server/`](server) is the same API for local use.

## Credits

Built on top of **[turtlesoupy/opensmash](https://github.com/turtlesoupy/opensmash)** (MIT), the project behind [smash.fun](https://smash.fun). Without it there is no game here. Specifically:

- `game/build.sh` clones opensmash and applies its `launcher.patch` and `embedded.patch` to the [BattleShip](https://github.com/turtlesoupy/BattleShip) PC port. We do not copy those files into this repo; they are fetched at build time at a pinned commit.
- The OSI1 controller-input file format comes from opensmash's launcher headers. Our sidecar and encoder are written separately in JavaScript from that format.
- The custom-fighter roster is opensmash's: the smash.fun catalog and its `characters.py` staging tool, which `scripts/stage-roster.sh` calls.
- opensmash's handoff-rooms signaling was the reference for ours. Ours uses WebSocket signaling instead of HTTP polling.

Also thanks to the BattleShip, `ssb-decomp-re`, libultraship and Torch projects that opensmash builds on; see the [opensmash README](https://github.com/turtlesoupy/opensmash#upstream-projects) for their licenses and credits.

## License

No license has been chosen for this repo's own code yet, so for now all rights are reserved by the author. Third-party projects keep their own licenses (opensmash is MIT). Super Smash Bros. is a trademark of Nintendo. This project is not affiliated with Nintendo.
