#!/usr/bin/env bash
# Runs Playwright. Without --project, the auth project runs in a second invocation after the
# others: its fixture recreates the backend with capture: false, so no other spec (or retry)
# may run after it, and a failure in the first invocation must not stop it from reporting.
set -uo pipefail
source "$(dirname "$0")/lib.sh"

CONFIG="$E2E_DIR/playwright.config.ts"

for arg in "$@"; do
  case "$arg" in
    --project | --project=*) exec playwright test -c "$CONFIG" "$@" ;;
  esac
done

has_tests() {
  # The configured html reporter would clear the report folder on --list.
  playwright test -c "$CONFIG" --list --reporter=list "$@" 2>/dev/null | grep -q '^Total: [1-9]'
}

# run_phase <name> <args...>: each phase keeps its own results and report folder.
run_phase() {
  local name="$1"
  shift
  PLAYWRIGHT_HTML_OUTPUT_DIR="$E2E_DIR/playwright-report/$name" \
    playwright test -c "$CONFIG" --output "$E2E_DIR/test-results/$name" "$@"
}

MAIN=(--project=chromium --project=paypal --project=visual)
main_code=skipped
auth_code=skipped

if has_tests "${MAIN[@]}" "$@"; then
  run_phase main "${MAIN[@]}" "$@"
  main_code=$?
  # Interrupted (Ctrl-C or a signal): do not start the next phase.
  ((main_code < 128)) || exit "$main_code"
fi
if has_tests --project=auth "$@"; then
  run_phase auth --project=auth "$@"
  auth_code=$?
fi

[[ "$main_code$auth_code" != skippedskipped ]] || fail "no tests match: $*"
echo "e2e: chromium/paypal/visual exit $main_code, auth exit $auth_code"
[[ "$main_code" =~ ^(0|skipped)$ && "$auth_code" =~ ^(0|skipped)$ ]]
