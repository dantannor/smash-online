# Lane B: input sidecar

The sidecar owns an 80-byte OSI1 snapshot and a loopback WebSocket endpoint. It accepts only the host protocol messages defined in [../PROTOCOL.md](../PROTOCOL.md), on `127.0.0.1` (default port `8765`). No ROM or game process is needed.

## Run

```sh
node sidecar/index.js --file /tmp/smash-online-input.osi1 --port 8765
```

P1 defaults to kind 2, enabled, with neutral values until the host supplies input. The host can send P1 through the same WebSocket using `slot:connect`, `slot:input`, and `slot:disconnect` with `port: 1`; P1 inputs are written as kind 3 while connected. P2-P4 guest inputs also use kind 3. The server binds only to `127.0.0.1` and permits one host WebSocket client at a time.

To read P1 from an external helper instead:

```sh
node sidecar/index.js --file /tmp/smash-online-input.osi1 --port 8765 --p1 'pad-helper:node ./my-pad-helper.js'
```

The command after `pad-helper:` runs as a shell command. It should write newline-delimited JSON to stdout, one object per update, for example:

```json
{"buttons":32768,"sx":0,"sy":-20}
```

`buttons`, `sx`, and `sy` must be numeric. Button masks and stick values are clamped by the shared protocol helper. The helper's P1 snapshots are kind 3. The helper can be tested with a fake process such as `node -e 'setInterval(() => console.log(JSON.stringify({buttons:0,sx:0,sy:0})), 50)'`.

## Behavior and contract notes

- Every snapshot is encoded with `encodeOSI1` from `shared/protocol.js`, written to a unique temporary file in the target directory, then atomically renamed over the target. Mute is always 0 and reserved bytes remain zero.
- Snapshots refresh every 100 ms while running and immediately after state changes.
- Disconnects neutralize and disable the port immediately. A guest that sends no input for 500 ms is also neutralized, disabled (kind 0), and reported as `slot:disconnected`. This follows the contract's statement that timeout neutralizes and disconnects the slot; it resolves the deliverable's enabled-state question by treating timeout as disconnect, not as a connected-but-neutral slot.
- Reconnecting a port replaces its connection ID and starts neutral; messages from the replaced ID are rejected. Sequence numbers must strictly increase within a connection; wraparound is rejected, matching the contract's monotonic wording.
- P1 kind 2 is enabled by default even before the host reports keyboard availability because the contract specifies an enabled default P1 keyboard source. P1 input over WebSocket changes to kind 3 while that source is connected; disconnect returns the port to kind 0.
- Shutdown writes one final all-neutral snapshot. The process leaves that file in place for the launcher to read.

Run focused tests with `node --test sidecar/index.test.js`, then the project suite with `npm test`.
