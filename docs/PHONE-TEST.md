# Manual phone test (pending a passing real local loop)

This test is for Daniel after the host page is implemented and a quick tunnel is running. No public URL was started or tested in this phase.

1. On the Mac, start the game, sidecar, and signaling server using the README runbook; then start `server/tunnel.sh` and copy its current HTTPS URL.
2. From the Mac, confirm `https://<current-tunnel-url>/healthz` returns `{"status":"ok"}` and create a room from the working host page.
3. Copy only one guest link (P2) to the phone. Turn off Wi-Fi so the phone uses cellular data.
4. Open that link in the phone browser, allow playback if prompted, and confirm live game video appears.
5. Ask the Mac player to start a VS match; use the phone's controls to move P2. Record whether video and input both work, then stop the tunnel and discard the old URL.

Do not use this checklist until the local real host/guest loop passes. The quick-tunnel URL is temporary and may expose the app publicly while running.
