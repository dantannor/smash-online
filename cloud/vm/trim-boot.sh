#!/bin/bash
# Runs on the VM as root (from install-services.sh): drop boot work this appliance never needs. A cold start went
# from about 28 s of userspace boot (snapd alone 13 s) to the time the game services need. Everything is masked, not removed,
# so `systemctl unmask` brings it back.
set -u
mask=(snapd.service snapd.socket snapd.seeded.service snapd.apparmor.service snapd.autoimport.service snapd.core-fixup.service
  snapd.recovery-chooser-trigger.service snapd.snap-repair.timer snapd.system-shutdown.service
  apport.service unattended-upgrades.service apt-daily.timer apt-daily-upgrade.timer apt-daily.service apt-daily-upgrade.service
  motd-news.timer motd-news.service multipathd.service multipathd.socket lxd-installer.socket ubuntu-advantage.service
  esm-cache.service secureboot-db.service e2scrub_reap.service google-osconfig-agent.service fwupd-refresh.timer
  plymouth-quit.service plymouth-quit-wait.service plymouth-start.service ModemManager.service)
for unit in "${mask[@]}"; do systemctl mask --now "$unit" >/dev/null 2>&1 || true; done
# cloud-init only matters on the very first boot; its "local" stage (4.5 s) sits on the path to the network
touch /etc/cloud/cloud-init.disabled
echo "boot trimmed: ${#mask[@]} units masked, cloud-init disabled"
