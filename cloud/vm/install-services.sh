#!/bin/bash
# Runs on the VM as root: install the systemd units. Idempotent; keeps an existing /etc/smash-online.env.
set -euo pipefail
U="${SMASH_USER:-smash}"; HOME_DIR="$(getent passwd "$U" | cut -d: -f6)"; REPO="$HOME_DIR/smash-online"
STATE="$HOME_DIR/.smash-online"; mkdir -p "$STATE"; chown "$U:$U" "$STATE"
touch /etc/smash-online.env; chgrp "$U" /etc/smash-online.env; chmod 640 /etc/smash-online.env   # holds the Worker registration secret
setdef() { grep -q "^$1=" /etc/smash-online.env || echo "$1=$2" >> /etc/smash-online.env; }   # keep values an operator already changed
setdef SMASH_SIGNAL_ORIGIN https://smash-online.reddit-service-site.workers.dev
# Idle shutdown: minutes with no guest since the services started, and minutes with no guest after a session has happened.
setdef SMASH_BOOT_GRACE_MIN 30
setdef SMASH_IDLE_MIN 15
# Game window / capture size (the virtual screen is the same size) and video sender tuning (kbps).
setdef SMASH_VIDEO_W 960
setdef SMASH_VIDEO_H 720
setdef SMASH_VIDEO_MAX_KBPS 8000
setdef SMASH_VIDEO_START_KBPS 4000
setdef SMASH_VIDEO_MIN_KBPS 1500
# WebRTC media port range (open to the world in the smash-allow-webrtc-udp firewall rule).
setdef SMASH_UDP_PORTS 50000-50099
# Worker registration (set by scripts/cloud.sh secrets): the VM tells the Worker its room so permanent links work.
setdef SMASH_VM_SECRET ""
ENVLINE="Environment=DISPLAY=:99 OPENSMASH_LAUNCHER_INPUT=$STATE/input.osi1"
unit() { cat > "/etc/systemd/system/$1.service"; }
unit smash-xvfb <<C
[Unit]
Description=Smash Online virtual display
[Service]
User=$U
EnvironmentFile=/etc/smash-online.env
ExecStart=/usr/bin/Xvfb :99 -screen 0 \${SMASH_VIDEO_W}x\${SMASH_VIDEO_H}x24 -nolisten tcp
Restart=always
[Install]
WantedBy=multi-user.target
C
unit smash-pulse <<C
[Unit]
Description=Smash Online audio (PulseAudio null sink; its monitor feeds the host page)
[Service]
User=$U
Environment=HOME=$HOME_DIR XDG_RUNTIME_DIR=/run/smash-pulse
Type=notify
RuntimeDirectory=smash-pulse
ExecStart=/usr/bin/pulseaudio -n --daemonize=no --exit-idle-time=-1 --log-target=journal \\
  -L "module-native-protocol-unix auth-anonymous=1 socket=/run/smash-pulse/native" \\
  -L "module-null-sink sink_name=smash sink_properties=device.description=Smash" \\
  -L "module-virtual-source source_name=smashmic master=smash.monitor"
ExecStartPost=/usr/bin/pactl --server=unix:/run/smash-pulse/native set-default-sink smash
ExecStartPost=/usr/bin/pactl --server=unix:/run/smash-pulse/native set-default-source smashmic
Restart=always
[Install]
WantedBy=multi-user.target
C
unit smash-game <<C
[Unit]
Description=Smash Online game (restarted when the engine aborts)
After=smash-xvfb.service smash-pulse.service
Requires=smash-xvfb.service
Wants=smash-pulse.service
StartLimitIntervalSec=120
StartLimitBurst=6
[Service]
User=$U
$ENVLINE
EnvironmentFile=/etc/smash-online.env
Environment=SMASH_WINDOW_X=0 SMASH_WINDOW_Y=0 LIBGL_ALWAYS_SOFTWARE=1 GALLIUM_DRIVER=llvmpipe LP_NUM_THREADS=8 SDL_AUDIODRIVER=pulseaudio PULSE_SERVER=unix:/run/smash-pulse/native
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
After=smash-server.service smash-xvfb.service smash-sidecar.service smash-pulse.service
Requires=smash-server.service smash-xvfb.service
[Service]
User=$U
Environment=DISPLAY=:99 PULSE_SERVER=unix:/run/smash-pulse/native
EnvironmentFile=/etc/smash-online.env
ExecStartPre=/bin/rm -rf $STATE/chrome-profile
ExecStart=/usr/bin/google-chrome-stable --user-data-dir=$STATE/chrome-profile --no-first-run --no-default-browser-check \
  --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1 --window-position=0,0 --window-size=\${SMASH_VIDEO_W},\${SMASH_VIDEO_H} \
  --auto-select-desktop-capture-source="Entire screen" --autoplay-policy=no-user-gesture-required \
  --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows \
  --password-store=basic --no-sandbox \
  "http://127.0.0.1:8787/host?signal=\${SMASH_SIGNAL_ORIGIN}&p1guest=1&audio=1&maxkbps=\${SMASH_VIDEO_MAX_KBPS}&startkbps=\${SMASH_VIDEO_START_KBPS}&minkbps=\${SMASH_VIDEO_MIN_KBPS}"
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
# Chrome policy: keep WebRTC UDP inside the opened firewall range, and let the host page read the audio device without a prompt.
UDP="$(grep '^SMASH_UDP_PORTS=' /etc/smash-online.env | cut -d= -f2)"
mkdir -p /etc/opt/chrome/policies/managed
cat > /etc/opt/chrome/policies/managed/smash.json <<C
{ "WebRtcUdpPortRange": "$UDP", "AudioCaptureAllowed": true, "AudioCaptureAllowedUrls": ["http://127.0.0.1:8787"] }
C
systemctl daemon-reload
systemctl enable smash-pulse smash-xvfb smash-game smash-sidecar smash-server smash-chrome smash-ctl >/dev/null 2>&1
systemctl restart smash-pulse smash-xvfb smash-game smash-sidecar smash-server smash-chrome smash-ctl
echo SERVICES-INSTALLED
