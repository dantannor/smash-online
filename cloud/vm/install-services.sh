#!/bin/bash
# Runs on the VM as root: install the systemd units. Idempotent; keeps an existing /etc/smash-online.env.
set -euo pipefail
U="${SMASH_USER:-smash}"; HOME_DIR="$(getent passwd "$U" | cut -d: -f6)"; REPO="$HOME_DIR/smash-online"
STATE="$HOME_DIR/.smash-online"; mkdir -p "$STATE"; chown "$U:$U" "$STATE"
[[ -f /etc/smash-online.env ]] || cat > /etc/smash-online.env <<C
# Smash Online cloud settings (re-read by the controller every 2 s; no restart needed)
SMASH_SIGNAL_ORIGIN=https://smash-online.reddit-service-site.workers.dev
# Idle shutdown: minutes with no guest since boot, and minutes with no guest after a session has happened.
SMASH_BOOT_GRACE_MIN=30
SMASH_IDLE_MIN=15
C
chmod 644 /etc/smash-online.env
ENVLINE="Environment=DISPLAY=:99 OPENSMASH_LAUNCHER_INPUT=$STATE/input.osi1"
unit() { cat > "/etc/systemd/system/$1.service"; }
unit smash-xvfb <<C
[Unit]
Description=Smash Online virtual display
[Service]
User=$U
ExecStart=/usr/bin/Xvfb :99 -screen 0 640x480x24 -nolisten tcp
Restart=always
[Install]
WantedBy=multi-user.target
C
unit smash-game <<C
[Unit]
Description=Smash Online game (restarted when the engine aborts)
After=smash-xvfb.service
Requires=smash-xvfb.service
StartLimitIntervalSec=120
StartLimitBurst=6
[Service]
User=$U
$ENVLINE
Environment=SMASH_WINDOW_X=0 SMASH_WINDOW_Y=0 LIBGL_ALWAYS_SOFTWARE=1 GALLIUM_DRIVER=llvmpipe LP_NUM_THREADS=8 SDL_AUDIODRIVER=dummy
ExecStart=$REPO/cloud/vm/run-game.sh
Restart=always
RestartSec=3
[Install]
WantedBy=multi-user.target
C
unit smash-sidecar <<C
[Unit]
Description=Smash Online OSI1 sidecar
After=smash-game.service
Wants=smash-game.service
[Service]
User=$U
$ENVLINE
ExecStart=$REPO/cloud/vm/sidecar-guard.sh
Restart=always
RestartSec=2
[Install]
WantedBy=multi-user.target
C
unit smash-server <<C
[Unit]
Description=Smash Online local server (host page)
[Service]
User=$U
Environment=PORT=8787 HOST=127.0.0.1
ExecStart=/usr/local/bin/node $REPO/server/index.js
Restart=always
[Install]
WantedBy=multi-user.target
C
unit smash-chrome <<C
[Unit]
Description=Smash Online host page (Chrome on the virtual display)
After=smash-server.service smash-xvfb.service smash-sidecar.service
Requires=smash-server.service smash-xvfb.service
[Service]
User=$U
Environment=DISPLAY=:99
EnvironmentFile=/etc/smash-online.env
ExecStartPre=/bin/rm -rf $STATE/chrome-profile
ExecStart=/usr/bin/google-chrome-stable --user-data-dir=$STATE/chrome-profile --no-first-run --no-default-browser-check \
  --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1 --window-position=0,0 --window-size=780,600 \
  --auto-select-desktop-capture-source="Entire screen" --autoplay-policy=no-user-gesture-required \
  --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows \
  --password-store=basic --no-sandbox \
  "http://127.0.0.1:8787/host?signal=\${SMASH_SIGNAL_ORIGIN}&p1guest=1"
Restart=always
RestartSec=3
[Install]
WantedBy=multi-user.target
C
unit smash-ctl <<C
[Unit]
Description=Smash Online controller (room, capture, links, idle shutdown)
After=smash-chrome.service
[Service]
User=$U
Environment=DISPLAY=:99
ExecStart=/usr/local/bin/node $REPO/cloud/vm/controller.mjs
Restart=always
RestartSec=3
[Install]
WantedBy=multi-user.target
C
systemctl daemon-reload
systemctl enable smash-xvfb smash-game smash-sidecar smash-server smash-chrome smash-ctl >/dev/null 2>&1
systemctl restart smash-xvfb smash-game smash-sidecar smash-server smash-chrome smash-ctl
echo SERVICES-INSTALLED
