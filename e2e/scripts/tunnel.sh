#!/usr/bin/env bash
# Starts a cloudflared quick tunnel to the backend and writes its URL to
# .generated/backend.env, which the backend reads as MONEI_BACKEND_URL (callbackUrl base).
set -euo pipefail
source "$(dirname "$0")/lib.sh"

mkdir -p "$GENERATED_DIR"
compose up -d tunnel

tunnel_url() {
  compose logs --no-color tunnel 2>/dev/null | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | tail -1
}
registered() {
  compose logs --no-color tunnel 2>/dev/null | grep -q 'Registered tunnel connection'
}

# Resolving the hostname before cloudflared registers it caches an NXDOMAIN for minutes.
wait_for 90 tunnel "the cloudflared tunnel to register" registered
url="$(tunnel_url)"
[ -n "$url" ] || fail "cloudflared registered a connection but printed no trycloudflare.com URL"

echo "MONEI_BACKEND_URL=$url" >"$GENERATED_DIR/backend.env"
echo "tunnel: $url"
