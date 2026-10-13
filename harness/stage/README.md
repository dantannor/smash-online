# Stage-by-stage input-to-photon latency (cloud VM)

Measures one guest's key press to the first changed pixel on its screen against the live VM, and splits it into stages with timestamps from five places. The input is a character-select page flip (L or R): the whole picture changes in one frame, so detection is unambiguous. Note that this is the worst case for the video path (the encoder emits a scene-change frame of 40 to 80 KB where gameplay frames are about 10 KB); use it to compare configurations, not as the latency of every move.

```sh
node harness/stage/stage-latency.mjs <guest link> 60 /tmp/run.json   # full breakdown (hooks the host page over CDP, runs vm-probe)
node harness/stage/analyze.mjs /tmp/run.json                         # stage table
LIGHT=1 node harness/stage/stage-latency.mjs <guest link> 60 /tmp/light.json   # total only, nothing hooked on the VM
LIGHT=1 node harness/stage/analyze.mjs /tmp/light.json
node harness/stage/smooth.mjs <guest link> 45                        # displayed-frame intervals, freezes, loss (use with tc netem on the VM)
```

Needs `scripts/cloud.sh` set up (SSH config in `~/.smash-online`) and `vm-probe` built on the VM: `gcc -O2 -o ~/lab/vm-probe harness/stage/vm-probe.c -lX11 -lXext`. Do not run it while friends are playing (it takes a guest slot and presses buttons on the character select screen).

| Stage | Clock and source |
|---|---|
| send | guest: `performance.now()` around `setVirtualInput` (key to `dataChannel.send`) |
| net_up | host page timestamp of the data channel message minus the guest timestamp in the message, guests clock mapped to the VM clock by 40 ping/pongs on the `meta` channel (best RTT samples) |
| host_to_file | sidecar OSI1 file change seen by `vm-probe` (pread loop) minus the host page receive time (VM clock) |
| game | first Xvfb frame that differs (`vm-probe`, XShm grab of the root window every ~0.5 ms, 64x48 samples) minus the file change |
| capture | host page `MediaStreamTrackProcessor` on the capture track: first changed frame minus the Xvfb change |
| cap_to_recv | guest `requestVideoFrameCallback` `receiveTime` minus capture (encode, pacer, network one way) |
| recv_to_present | guest callback time minus `receiveTime` (assembly, jitter buffer, decode, render) |
| total | guest callback time of the first changed frame minus the timestamp before the press (guest clock only) |
