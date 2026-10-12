#!/usr/bin/env bash
# Run Smash Online on a Google Cloud VM (Tel Aviv) instead of the Mac. See README "Running on Google Cloud".
#   scripts/cloud.sh up       create/start the VM, wait until a room exists, print the P1-P4 links
#   scripts/cloud.sh down     stop the VM (the disk is kept)
#   scripts/cloud.sh status   VM state, services, guests, idle-shutdown settings
#   scripts/cloud.sh links    print the links of the running room (from GCE guest attributes)
#   scripts/cloud.sh sync     copy this checkout to the VM and restart the services
#   scripts/cloud.sh newroom  restart the host page (new room, new links)
#   scripts/cloud.sh idle <bootGraceMin> <idleMin>   change the idle-shutdown timeouts
#   scripts/cloud.sh ssh [cmd...]
# Needs gcloud, already authenticated for the project (gcloud auth login, or activate-service-account).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
CONF="${SMASH_CLOUD_DIR:-$HOME/.smash-online}"; mkdir -p "$CONF"; chmod 700 "$CONF"
[[ -r "$CONF/cloud.env" ]] && . "$CONF/cloud.env"
PROJECT="${SMASH_GCP_PROJECT:-smash-online-511318}"
ZONE="${SMASH_GCP_ZONE:-me-west1-c}"
VM="${SMASH_GCP_INSTANCE:-smash-online}"
MACHINE="${SMASH_GCP_MACHINE:-c2d-highcpu-8}"
ROM="${SMASH_ROM_PATH:-$HOME/Downloads/Super Smash Bros. (USA).z64}"
KEY="${SMASH_CLOUD_KEY:-$CONF/gcp_ed25519}"
SSH_CONF="$CONF/ssh_config"
GCLOUD="${SMASH_GCLOUD:-$(command -v gcloud || ls /tmp/gcloud-sdk/google-cloud-sdk/bin/gcloud 2>/dev/null || true)}"
[[ -n "$GCLOUD" ]] || { echo "gcloud not found (set SMASH_GCLOUD)" >&2; exit 2; }
gc() { "$GCLOUD" --project "$PROJECT" "$@"; }
gci() { gc compute instances "$@" --zone "$ZONE"; }
say() { echo "[cloud $(date +%T)] $*" >&2; }

vm_status() { gci describe "$VM" --format='value(status)' 2>/dev/null || echo MISSING; }
vm_ip() { gci describe "$VM" --format='value(networkInterfaces[0].accessConfigs[0].natIP)'; }
my_ip() { curl -fsS -m 8 -4 https://api.ipify.org; }

ensure_key() {
  [[ -f "$KEY" ]] || { ssh-keygen -q -t ed25519 -N '' -C smash-cloud -f "$KEY"; say "created SSH key $KEY"; }
}
ensure_firewall() { # SSH-over-TLS on 443 from this machine's /32 only; IAP range kept for when IAP is enabled
  local ip; ip="$(my_ip)"
  if gc compute firewall-rules describe smash-allow-ssh-tls >/dev/null 2>&1; then
    gc compute firewall-rules update smash-allow-ssh-tls --source-ranges "$ip/32" --quiet >/dev/null
  else
    gc compute firewall-rules create smash-allow-ssh-tls --network default --direction INGRESS --allow tcp:443 \
      --source-ranges "$ip/32" --target-tags smash-online --quiet >/dev/null
  fi
  gc compute firewall-rules describe smash-allow-iap-ssh >/dev/null 2>&1 || \
    gc compute firewall-rules create smash-allow-iap-ssh --network default --direction INGRESS --allow tcp:22 \
      --source-ranges 35.235.240.0/20 --quiet >/dev/null
  say "firewall: 443 open to $ip/32 only"
}
write_ssh_config() { # the IP changes on every start, the host key is pinned under the alias
  cat > "$SSH_CONF" <<C
Host smash-vm
  HostName $1
  HostKeyAlias smash-online-vm
  User smash
  IdentityFile $KEY
  IdentitiesOnly yes
  StrictHostKeyChecking accept-new
  UserKnownHostsFile $CONF/known_hosts
  ProxyCommand sh -c 'openssl s_client -quiet -connect %h:443 2>/dev/null'
  ServerAliveInterval 20
  ConnectTimeout 20
C
}
vssh() { ssh -F "$SSH_CONF" smash-vm "$@"; }
wait_ssh() {
  local end=$((SECONDS + 240))
  until vssh true >/dev/null 2>&1; do ((SECONDS < end)) || { echo "SSH over TLS never came up" >&2; return 1; }; sleep 4; done
}
create_vm() {
  ensure_key
  echo "smash:$(cat "$KEY.pub")" > "$CONF/ssh-keys.txt"
  say "creating $VM ($MACHINE, $ZONE)"
  gci create "$VM" --machine-type "$MACHINE" --image-family ubuntu-2404-lts-amd64 --image-project ubuntu-os-cloud \
    --boot-disk-size 60GB --boot-disk-type pd-balanced --tags smash-online --no-service-account --no-scopes \
    --metadata enable-guest-attributes=TRUE,enable-oslogin=FALSE \
    --metadata-from-file startup-script="$ROOT/cloud/vm/startup.sh",ssh-keys="$CONF/ssh-keys.txt" >/dev/null
}
sync_repo() {
  say "copying the checkout to the VM"
  (cd "$ROOT" && { git ls-files; git ls-files --others --exclude-standard; } | sort -u | grep -v '^harness/reports/' \
    | COPYFILE_DISABLE=1 tar --no-xattrs -czf - -T - 2>/dev/null) | vssh 'mkdir -p ~/smash-online && tar -xzf - -C ~/smash-online && cd ~/smash-online && (test -d node_modules/ws || npm install --no-save --no-package-lock --ignore-scripts ws@8.22.0 2>&1 | tail -1)'
}
provision() { # first run: dependencies, ROM, game build, roster, services (takes ~20 min)
  [[ -f "$ROM" ]] || { echo "ROM not found: $ROM (set SMASH_ROM_PATH)" >&2; exit 2; }
  say "first run: provisioning (deps, build, roster)"
  vssh 'for _ in $(seq 1 90); do test -f /var/tmp/startup-done && exit 0; sleep 4; done; exit 1'   # the boot startup-script also uses apt
  sync_repo
  say "uploading the ROM to the VM (it goes nowhere else)"
  scp -F "$SSH_CONF" "$ROM" smash-vm:rom.z64 && vssh 'chmod 600 ~/rom.z64'
  vssh 'cd ~/smash-online/cloud/vm && sudo ./install-deps.sh > ~/provision.log 2>&1 && ./build-game.sh >> ~/provision.log 2>&1 && cd ~/smash-online && ./scripts/stage-roster.sh >> ~/provision.log 2>&1 && echo PROVISION-OK >> ~/provision.log' \
    || { echo "provisioning failed; see ~/provision.log on the VM (scripts/cloud.sh ssh tail -50 provision.log)" >&2; exit 1; }
  vssh 'sudo ~/smash-online/cloud/vm/install-services.sh'
}
need_provision() { ! vssh 'test -x ~/Projects/smash-online-build/src/BattleShip/build-us/BattleShip && test -f /etc/systemd/system/smash-ctl.service' >/dev/null 2>&1; }

status_json() { # prints the controller status JSON, or nothing
  gci get-guest-attributes "$VM" --query-path=smash/status --format='value(value)' 2>/dev/null || true
}
print_links() { # stdin: status JSON
  node -e '
    const s = JSON.parse(require("fs").readFileSync(0, "utf8"));
    for (const l of s.links.sort((a, b) => a.port - b.port)) console.log(`P${l.port}${l.port === 1 ? " (Daniel)" : ""}: ${l.url}`);
  '
}
cmd_up() {
  local t0=$SECONDS st; st="$(vm_status)"
  ensure_key; ensure_firewall
  case "$st" in
    MISSING) create_vm ;;
    TERMINATED|STOPPED|SUSPENDED) say "starting $VM"; gci start "$VM" >/dev/null ;;
    RUNNING|PROVISIONING|STAGING) say "$VM already $st" ;;
    *) echo "unexpected VM state: $st" >&2; exit 1 ;;
  esac
  local ip; ip="$(vm_ip)"; write_ssh_config "$ip"; say "VM at $ip; waiting for SSH over TLS"
  wait_ssh
  if need_provision; then provision; fi
  local boot_floor; boot_floor="$(gci describe "$VM" --format='value(lastStartTimestamp)' | node -e 'console.log(Math.floor(new Date(require("fs").readFileSync(0,"utf8").trim()).getTime()/1000))')"
  say "waiting for a room with live capture"
  local end=$((SECONDS + 420)) json=""
  while ((SECONDS < end)); do
    json="$(status_json)"
    if [[ -n "$json" ]] && echo "$json" | node -e 'const s=JSON.parse(require("fs").readFileSync(0,"utf8")); process.exit(s.ready && s.boot >= '"$boot_floor"' - 30 && s.links.length >= 4 ? 0 : 1)' 2>/dev/null; then break; fi
    json=""; sleep 5
  done
  [[ -n "$json" ]] || { echo "services did not become healthy; try: scripts/cloud.sh status" >&2; exit 1; }
  say "up in $((SECONDS - t0)) s"
  echo "$json" | print_links
  echo "Idle shutdown: see 'scripts/cloud.sh status'. Stop billing now with: scripts/cloud.sh down"
}
cmd_down() { say "stopping $VM"; gci stop "$VM" --quiet >/dev/null; say "stopped (disk kept)"; }
cmd_links() { local j; j="$(status_json)"; [[ -n "$j" ]] || { echo "no links (is the VM up? scripts/cloud.sh up)" >&2; exit 1; }; echo "$j" | print_links; }
cmd_status() {
  local st; st="$(vm_status)"; echo "VM $VM: $st"
  [[ "$st" == RUNNING ]] || exit 0
  write_ssh_config "$(vm_ip)"
  vssh 'for u in smash-xvfb smash-game smash-sidecar smash-server smash-chrome smash-ctl; do printf "%-15s %s\n" $u "$(systemctl is-active $u)"; done; echo; grep -E "^SMASH_(BOOT|IDLE)" /etc/smash-online.env; echo "uptime: $(uptime -p)"; python3 -c "import json; s=json.load(open(\"/home/smash/.smash-online/status.json\")); print(\"room:\", s[\"room\"], \"capture live:\", s[\"captured\"], \"guests connected:\", s[\"guests\"])" 2>/dev/null; true' 
}
with_vm() { [[ "$(vm_status)" == RUNNING ]] || { echo "VM is not running" >&2; exit 1; }; write_ssh_config "$(vm_ip)"; }
case "${1:-}" in
  up) cmd_up ;;
  down) cmd_down ;;
  status) cmd_status ;;
  links) cmd_links ;;
  sync) with_vm; sync_repo; vssh 'sudo ~/smash-online/cloud/vm/install-services.sh' ;;
  newroom) with_vm; vssh 'sudo systemctl restart smash-chrome' ;;
  idle) with_vm; [[ "${2:-}" =~ ^[0-9]+$ && "${3:-}" =~ ^[0-9]+$ ]] || { echo "usage: cloud.sh idle <bootGraceMin> <idleMin>" >&2; exit 64; }
        vssh "sudo sed -i -e 's/^SMASH_BOOT_GRACE_MIN=.*/SMASH_BOOT_GRACE_MIN=$2/' -e 's/^SMASH_IDLE_MIN=.*/SMASH_IDLE_MIN=$3/' /etc/smash-online.env && grep -E '^SMASH_(BOOT|IDLE)' /etc/smash-online.env" ;;
  ssh) shift; with_vm; vssh "$@" ;;
  *) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 64 ;;
esac
