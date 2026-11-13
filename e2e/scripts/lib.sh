# Shared by the e2e shell scripts. Never `set -x` here: compose interpolates the API key.
E2E_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_DIR="$(cd "$E2E_DIR/.." && pwd)"
GENERATED_DIR="$E2E_DIR/.generated"

compose() {
  docker compose -f "$E2E_DIR/docker-compose.yml" "$@"
}

fail() {
  echo "e2e: $*" >&2
  exit 1
}

# wait_for <seconds> <service> <description> <command...>: retry the command every 2 s;
# stop early with the service log when its container has exited.
wait_for() {
  local timeout="$1" service="$2" what="$3"
  shift 3
  local deadline=$((SECONDS + timeout))
  until "$@" >/dev/null 2>&1; do
    if [ -n "$(compose ps -a -q --status exited "$service")" ]; then
      compose logs --no-color --tail 80 "$service" >&2
      fail "the $service container exited while waiting for $what"
    fi
    ((SECONDS < deadline)) || fail "timed out after ${timeout}s waiting for $what"
    sleep 2
  done
}
