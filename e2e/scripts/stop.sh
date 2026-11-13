#!/usr/bin/env bash
# Removes every container, network and volume of the e2e stack, tunnel included.
set -euo pipefail
source "$(dirname "$0")/lib.sh"

# `down` needs no API key, but compose refuses to interpolate the file without one.
MONEI_TEST_API_KEY="${MONEI_TEST_API_KEY:-unused}" compose down -v --remove-orphans
rm -rf "$GENERATED_DIR"
