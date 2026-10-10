#!/usr/bin/env bash
set -euo pipefail
command -v cloudflared >/dev/null || { echo "cloudflared is required (brew install cloudflared)" >&2; exit 1; }
exec cloudflared tunnel --url http://localhost:8787
