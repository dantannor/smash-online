# Smash Online Phase 0 contract

This document is the shared contract for lanes A–F. Treat all values below as the Phase 0 interface; propose changes before implementing cross-lane behavior.

## ROM input

Use this local ROM only by its absolute path; never copy it into this repository, upload it, or serve it:

```sh
ROM_PATH='/Users/danieltannor/Downloads/Super Smash Bros. (USA).z64'
```

Pass `$ROM_PATH` to the game launcher's ROM argument. The verified big-endian SHA-1 begins `e2929e10fccc`; the original word-swapped `.n64` stays untouched.

## Signaling API and URLs

The signaling service listens on **HTTP/WebSocket port 8787**. REST endpoints and the signaling WebSocket share that origin; WebSocket path is `/ws`. Production must use HTTPS/WSS. Only public Google STUN is configured in Phase 0; no TURN service or credentials.

- `POST /api/rooms` with `{}` creates a room. Response: `{room, roomToken, hostUrl, slots:[{port,slotToken,guestUrl}]}`. Issue one random room token and independent random slot token for each P2/P3/P4 link. Tokens are bearer secrets, minimum 128 bits of entropy; store token hashes server-side and compare in constant time.
- `POST /api/rooms/:room/join` with `{slotToken}` admits that link and returns `{port,slotSession}`. A slot token is reusable for reconnects. A second live connection using the same slot replaces the first.
- The host connects to `wss://<host>/ws?room=<room>&role=host&token=<roomToken>`. A guest connects to the same path with `role=guest&token=<slotToken>&port=<2|3|4>`.
- Messages are JSON envelopes: `{type, ...payload}`. After WebSocket authentication, the host sends `{type:"offer",port,sdp}`; the selected guest replies `{type:"answer",sdp}`. Either peer relays `{type:"ice",candidate}` to the other peer. Server events are `{type:"slot:connected",port,connectionId}` and `{type:"slot:disconnected",port,connectionId}`. An old connection's close event must not disconnect a replacement connection. `{type:"error",code,message}` reports a rejected operation. SDP and ICE are signaling only; game input uses the peer data channel.
- Host URL: `https://<host>/host?room=<room>` (host retains `roomToken` in its authenticated session, not in the shareable URL). Guest URLs: `https://<host>/play?room=<room>&slot=<slotToken>`. The URL contains exactly that guest's slot credential, never the room token or another slot's token.
- Room create/join are HTTP operations, while offer/answer/ICE and slot lifecycle events use the authenticated WebSocket. Room and slot credentials must not be logged. Expire inactive rooms after 30 minutes.

## Guest input data channel

Create one WebRTC `RTCDataChannel` per guest with `{ordered:false,maxRetransmits:0}` and a stable label `input`. Guest sends `{seq,t,buttons,sx,sy}` at 60 Hz and immediately on input change. `seq` is an unsigned 32-bit monotonically increasing counter per connection; `t` is the guest's `performance.now()` timestamp in milliseconds. `buttons` is a 16-bit mask; sticks are integer axes clamped to ±80. Drop stale/repeated sequence numbers; no retransmit or application-level queue. A slot timeout after 500 ms is neutralized and disconnected by the sidecar.

Buttons: A `0x8000`, B `0x4000`, Z `0x2000`, Start `0x1000`; D-pad U/D/L/R `0x0800/0x0400/0x0200/0x0100`; L `0x0020`, R `0x0010`; C U/D/L/R `0x0008/0x0004/0x0002/0x0001`.

## Host to sidecar WebSocket

The host connects only to loopback **`ws://127.0.0.1:8765`**. The sidecar accepts `{type:"slot:connect",port,connectionId}`, `{type:"slot:input",port,connectionId,input:{seq,t,buttons,sx,sy}}`, and `{type:"slot:disconnect",port,connectionId}`. It emits `{type:"ready"}`, `{type:"slot:connected",port}`, `{type:"slot:disconnected",port}`, and `{type:"error",code,message}`. Ports are numeric 1–4. P1's source is the local host keyboard/game-window input; the host always sends P1 state through this same sidecar/file path. Only one host process owns the sidecar connection at a time.

While any remote slot is connected, rewrite the complete OSI1 file at least every 100 ms, incrementing its byte-5 sequence on every write. For a slot disconnect, write neutral input with `enabled=0` within 500 ms; disconnected ports use kind 0. Connected guests use kind 3, enabled 1. P1 uses kind 2 for game-window keyboard input, enabled 1 when the host input source is available. On sidecar shutdown, write one final neutral packet and close cleanly. Reject invalid port, stale connection ID, malformed input, and non-monotonic sequence updates.

## OSI1 file contract

`OPENSMASH_LAUNCHER_INPUT` names the sidecar-owned 80-byte input file. `SSB64_BOOT_SLOTS=hhhh` and `SSB64_START_SCENE=16` are game launch settings. Example (the ROM path remains an argument to the game launcher, not the input-file path):

```sh
ROM_PATH='/Users/danieltannor/Downloads/Super Smash Bros. (USA).z64'
export OPENSMASH_LAUNCHER_INPUT='/tmp/smash-online-input.osi1'
export SSB64_BOOT_SLOTS=0000
export SSB64_START_SCENE=16
```

OSI1 is exactly 80 bytes. Bytes 0–3 are ASCII `OSI1`; byte 4 is mute (`0` unmuted, `1` muted); byte 5 is a sequence byte that changes on every write; bytes 6–7 are zero. Four 16-byte port records start at `8 + 16*port` (port indices 0–3): kind at +0, enabled at +1, buttons uint16 LE at +2, stick X int16 LE at +4, stick Y int16 LE at +6. Stick values are approximately ±80. Bytes +8..+15 within each port record are not consumed by the SSB64 launcher input reader and remain reserved/zero in this protocol. Bytes 72–79 after the four records are also reserved and zero.

Kinds: 2 game-window keyboard; 3 file-driven pad; other values disconnected. With `OPENSMASH_LAUNCHER_INPUT` enabled, all four ports are supplied by the file, including P1. Keep the file fresh at least every 100 ms while a remote slot is connected. If a held-input sequence is not advanced, the launcher clears file-driven pad inputs after 500 ms. All four records must be written atomically as one complete 80-byte snapshot.

**Reference discrepancy:** `desktop/input.cjs` accepts a nine-number port tuple. It writes tuple elements 3–6 as two signed LE int16 axes, elements 7–8 at record offsets +12/+13, and leaves +14/+15 zero. The SSB64 reader only consumes the first eight bytes of each port record, so the extra two tuple values do not affect the OSI1 input contract. This Phase 0 contract reserves all eight trailing bytes as zero. The desktop writer advances the sequence byte once on each write and initializes byte 4 muted; Smash Online explicitly writes byte 4 as 0 unless mute is requested. The file reader's 500 ms stale-sequence timeout specifically disables kind-3 ports; it is not a general timeout for keyboard kind 2.

## Media and playback defaults

Capture at 60 fps. Set `MediaStreamTrack.contentHint = "motion"`. Prefer H.264 (`video/H264`) and configure sender encoding `maxBitrate: 6_000_000`, `maxFramerate: 60`, `priority: "high"`, `degradationPreference: "maintain-framerate"`. Target approximately 6 Mbps per guest. Guest playback sets `video.playbackQuality` only for diagnostics, sets `video.playsInline = true`, requests the lowest supported `jitterBufferTarget` and sets `playoutDelayHint = 0` where implemented. Unsupported browser APIs are best-effort, not fatal.

## Test hook

Host `?source=canvas` selects deterministic canvas capture instead of the game window. The canvas shows a monotonically increasing frame counter so tests can verify capture and guest playback without a ROM or game process.

## Reference implementation

OSI1 reference files were read from `turtlesoupy/opensmash`: `desktop/native/OpenSmashLauncher.h`, `engines/ssb64/native/launcher_input.h`, and `desktop/input.cjs`. Signaling/reference behavior was read from `web-prototype/server/handoff-rooms.js`, `web-prototype/src/rom-handoff-client.js`, and `web-prototype/server/handoff-ice.js`. The reference handoff uses HTTP-polled mailbox signaling and can enable TURN; Smash Online's Phase 0 contract intentionally uses WebSocket signaling and STUN only. No other OSI1 discrepancy was found beyond the details above.
