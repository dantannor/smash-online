# Phone test checklist

DW4 and the Cloudflare quick-tunnel smoke test pass. The tunnel test used a generated canvas source, not the game window. This checklist is for Daniel's real phone run. The quick tunnel exposes the host temporarily, so share only the P2 link with the phone.

## On the Mac

1. In the repo, run `./game/run-game.sh` and leave the BattleShip window open.
2. In another terminal, run `node sidecar/index.js --file /tmp/smash-online-input.osi1 --port 8765`.
3. In another terminal, run `npm start`.
4. In another terminal, run `./server/tunnel.sh`. Wait for the `https://...trycloudflare.com` URL and keep this terminal open.
5. Open `https://<current-tunnel-url>/healthz` on the Mac. It should return `{"status":"ok"}`.
6. Open `https://<current-tunnel-url>/host`, leave Capture source set to **Game window / screen**, then click **Create room**. Share only the P2 guest link with your phone.

## On the phone

1. Turn Wi-Fi off so the phone uses cellular data.
2. Open the P2 link in Safari or Chrome. Allow the page to play video.
3. Confirm the page says **Connected** and the game video moves. The test passed locally with one headless guest at 640×360; this phone step still needs a human check.
4. Move P2 with the on-screen controls or a paired gamepad. On the Mac, keep the BattleShip window focused and use **W/A/S/D** or the arrow keys for P1, **J** for A, **K** for B, **L** for Z, and **Space/Return** for Start.
5. Record whether video, P2 input, and audio work. Current macOS display capture sends video but no BattleShip audio track. See [audio evidence](evidence/dw8-audio.json).

## Stop

Press Ctrl+C in the tunnel terminal first, then stop the server and sidecar terminals and close the game window. The quick-tunnel URL is temporary and stops working when `cloudflared` exits.
