# Lane C: host

Owner lane: C. Contract: create/join signaling rooms, capture host game video at 60 fps, forward P1 and guest lifecycle/input messages to the sidecar, and support `?source=canvas` frame-counter mode. Signaling uses port 8787; sidecar WebSocket uses loopback port 8765. See [../PROTOCOL.md](../PROTOCOL.md).
