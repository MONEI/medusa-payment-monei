#!/usr/bin/env bash
# Prints the backend log of every container of the run, oldest first: the logs restartBackend
# saved before each recreate, then the running container. One collapsible group each on CI.
set -uo pipefail
source "$(dirname "$0")/lib.sh"

group() {
  echo "::group::$1"
  cat
  echo "::endgroup::"
}

for file in "$GENERATED_DIR"/backend-*.log; do
  [ -e "$file" ] || continue
  group "backend log: $(basename "$file" .log) (replaced container)" <"$file"
done
# `logs` needs no API key, but compose refuses to interpolate the file without one.
MONEI_TEST_API_KEY="${MONEI_TEST_API_KEY:-unused}" compose logs --no-color --no-log-prefix backend |
  group "backend log: running container"
