#!/bin/bash
# GCE startup-script (runs as root on every boot). Makes the VM reachable by SSH-over-TLS on 443 without
# any SSH session: stunnel terminates TLS on 443 and forwards to sshd on 127.0.0.1:22. The GCE firewall only
# admits the operator's /32 on 443 (scripts/cloud.sh refreshes it). sshd is key-only, no root login.
set -eu
export DEBIAN_FRONTEND=noninteractive
if ! command -v stunnel4 >/dev/null; then apt-get update -y && apt-get install -y stunnel4 openssl; fi
install -d -m 700 /etc/stunnel
if [ ! -s /etc/stunnel/both.pem ]; then
  openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj /CN=smash-online \
    -keyout /etc/stunnel/k.pem -out /etc/stunnel/c.pem 2>/dev/null
  cat /etc/stunnel/k.pem /etc/stunnel/c.pem > /etc/stunnel/both.pem; chmod 600 /etc/stunnel/*.pem
fi
cat > /etc/stunnel/ssh.conf <<C
[ssh]
accept = 443
connect = 127.0.0.1:22
cert = /etc/stunnel/both.pem
C
cat > /etc/ssh/sshd_config.d/00-smash.conf <<'C'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
C
systemctl enable stunnel4 >/dev/null 2>&1 || true
systemctl restart stunnel4   # the Debian unit runs every /etc/stunnel/*.conf
systemctl reload ssh || systemctl restart ssh
touch /var/tmp/startup-done
