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

## Video smoothness for several guests (2026-10-19 baseline)

```sh
node harness/stage/host-sampler.mjs 60 > host.jsonl      # on the VM, sender side: encode ms, fps, kbps, qualityLimitationReason, VM CPU
node harness/stage/video-baseline.mjs out.json 40 [--match|--unpause] <guest link> ...   # from anywhere with playwright
```

Run guests from a machine with enough cores: three headless guests on a 2-core box saturate its CPU (decode 13 ms per frame, 2 s of jitter buffer), which is the box and not the VM. One guest is a valid receiver view; the host sampler is valid for any number.

Baseline in a real 4-fighter match, t2d-standard-8, 1120x840, guest on a 2-core Hetzner box (58 ms RTT through the Cloudflare relay):

| | 1 guest | 3 guests |
|---|---|---|
| Sender fps (host page) | 59.0 | 59.5 each |
| Encode (OpenH264) ms per frame | 4.3 | 5.7 |
| Sender bitrate | 4.8 Mbps | 5.8 Mbps each (6 Mbps cap) |
| `qualityLimitationReason` | bandwidth 46% of the time (the cap), cpu 0 s | bandwidth 15% |
| VM CPU, mean / p95 | 41% / 52% | 45% / 52% |
| Receiver decoded fps / freezes / dropped / lost | 59 / 0 / 0 / 0 | not valid (box CPU) |
| Receiver jitter buffer, decode | 10 ms, 3.4 ms | not valid |
| Keyframes | about 1 every 3.5 s | about 1 every 20 s |
