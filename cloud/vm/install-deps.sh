#!/bin/bash
# Runs on the VM as root: build dependencies, Xvfb, Chrome, Node.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y build-essential cmake ninja-build git python3 python3-venv python3-pip pkg-config curl ca-certificates \
  libsdl2-dev libglew-dev libglu1-mesa-dev libgl1-mesa-dri mesa-utils libx11-dev libxext-dev libpng-dev zlib1g-dev \
  libtinyxml2-dev nlohmann-json3-dev libspdlog-dev libzip-dev zipcmp zipmerge ziptool libbz2-dev libogg-dev libvorbis-dev \
  xvfb x11-utils xdotool imagemagick libarchive-dev libcurl4-openssl-dev libopus-dev libglfw3-dev libhidapi-dev libusb-1.0-0-dev \
  libfreetype-dev libfmt-dev lld clang fonts-liberation
if ! command -v google-chrome-stable >/dev/null; then
  curl -fsSL -o /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
  apt-get install -y /tmp/chrome.deb; rm -f /tmp/chrome.deb
fi
if ! command -v node >/dev/null || [[ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]]; then
  curl -fsSL https://nodejs.org/dist/v22.11.0/node-v22.11.0-linux-x64.tar.xz | tar -xJ -C /usr/local --strip-components=1
fi
node --version; google-chrome-stable --version
echo DEPS-DONE
