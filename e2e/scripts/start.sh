#!/usr/bin/env bash
# Boots the e2e stack from scratch: guards, packed plugin, tunnel, backend, seed, storefront.
set -euo pipefail
source "$(dirname "$0")/lib.sh"

node "$E2E_DIR/scripts/preflight.ts"

# Medusa version the backend installs; the specs read it from .generated/medusa-version.
export MEDUSA_VERSION="${MEDUSA_VERSION:-2.22.3}"
[[ "$MEDUSA_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "MEDUSA_VERSION must be x.y.z, got \"$MEDUSA_VERSION\""
# "redis" (default) or "local"; see e2e/backend/Dockerfile.
export E2E_EVENT_BUS="${E2E_EVENT_BUS:-redis}"
[[ "$E2E_EVENT_BUS" =~ ^(redis|local)$ ]] || fail "E2E_EVENT_BUS must be redis or local, got \"$E2E_EVENT_BUS\""

# The backend installs exactly what `pnpm pack` publishes, built from this checkout.
(cd "$REPO_DIR" && pnpm build && pnpm pack --out "$E2E_DIR/backend/plugin/medusa-payment-monei.tgz")

compose down -v --remove-orphans
rm -rf "$GENERATED_DIR"
mkdir -p "$GENERATED_DIR"
echo "$MEDUSA_VERSION" >"$GENERATED_DIR/medusa-version"

compose build backend storefront
compose up -d postgres redis
"$E2E_DIR/scripts/tunnel.sh"
compose up -d backend

backend_healthy() { curl -fsS http://localhost:19000/health; }
wait_for 300 backend "the backend /health" backend_healthy

# The specs expect the requested version in traceDetails; this proves the image has it.
installed="$(compose exec -T backend node -p 'require("/app/node_modules/@medusajs/framework/package.json").version')"
[ "$installed" = "$MEDUSA_VERSION" ] || fail "the backend runs @medusajs/framework $installed, not MEDUSA_VERSION $MEDUSA_VERSION"

tunnel_healthy() { curl -fsS "$(sed -n 's/^MONEI_BACKEND_URL=//p' "$GENERATED_DIR/backend.env")/health"; }
wait_for 120 tunnel "the backend /health through the tunnel" tunnel_healthy

node "$E2E_DIR/scripts/seed.ts"

compose up -d storefront
storefront_ready() { curl -fsS -o /dev/null http://localhost:18000/es; }
wait_for 600 storefront "the storefront to build and serve /es" storefront_ready

compose up -d visual-browser
visual_browser_ready() { compose logs --no-color visual-browser | grep -q 'Listening on ws://127.0.0.1:13333/'; }
wait_for 180 visual-browser "the visual project's browser server" visual_browser_ready

echo "e2e stack ready: storefront http://localhost:18000, backend http://localhost:19000 (Medusa $MEDUSA_VERSION, $E2E_EVENT_BUS event bus)"
