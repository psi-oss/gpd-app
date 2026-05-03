#!/usr/bin/env bash
# Manual, opt-in macOS full-surface exploration run.
#
# This script intentionally does not run from normal CI triggers. It launches
# the debug app through the pytest harness, isolates HOME by default, inventories
# rendered controls, clicks reversible controls, and writes all artifacts under
# tests-gui/artifacts/manual-full-*.
set -u
set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null)"; then
  :
else
  ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
fi
DIR="$ROOT/packages/desktop/tests-gui"
cd "$DIR" || exit 1

export PATH="$HOME/.gpd/uv-bootstrap:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
ART="${GPD_EXPLORER_ARTIFACT_DIR:-$DIR/artifacts/manual-full-$STAMP}"
mkdir -p "$ART"
export GPD_EXPLORER_ARTIFACT_DIR="$ART"

: "${GPD_EXPLORER_DEPTH:=full}"
: "${GPD_EXPLORER_STRICT:=1}"
: "${GPD_EXPLORER_MAX_ACTIONS:=200}"
: "${GPD_EXPLORER_MAX_CONFIRMABLE:=80}"
: "${GPD_EXPLORER_MAX_INPUTS:=80}"
: "${GPD_EXPLORER_MIN_CONTROLS:=60}"
: "${GPD_EXPLORER_MIN_PASSIVE:=8}"
: "${GPD_EXPLORER_MIN_INPUTS_USEFUL:=2}"
: "${GPD_EXPLORER_RUN_DESTRUCTIVE:=0}"
: "${GPD_EXPLORER_RUN_REAL_BACKEND:=0}"
: "${GPD_EXPLORER_ISOLATE_HOME:=1}"
: "${GPD_EXPLORER_REQUIRE_KEY:=1}"
: "${GPD_EXPLORER_QUIT_APP:=0}"

export GPD_EXPLORER_STRICT
export GPD_EXPLORER_MAX_ACTIONS
export GPD_EXPLORER_MAX_CONFIRMABLE
export GPD_EXPLORER_MAX_INPUTS
export GPD_EXPLORER_MIN_CONTROLS
export GPD_EXPLORER_MIN_PASSIVE
export GPD_EXPLORER_MIN_INPUTS_USEFUL
export PYTEST_COLD_START=1
export PYTEST_CI=1
export PYTEST_SLOWMO_MS=0
export GPD_TEST_SEED_ONBOARDING=1

if [ "$GPD_EXPLORER_QUIT_APP" = "1" ]; then
  export PYTEST_QUIT_GPD=1
else
  unset PYTEST_QUIT_GPD
fi

if [ "$GPD_EXPLORER_ISOLATE_HOME" = "1" ]; then
  export HOME="${GPD_EXPLORER_HOME:-$ART/home}"
  export XDG_CONFIG_HOME="$HOME/.config"
  export XDG_DATA_HOME="$HOME/.local/share"
  mkdir -p "$XDG_CONFIG_HOME" "$XDG_DATA_HOME"
fi

if [ -z "${GPD_EXPLORER_KEY:-}" ] && [ -n "${GPD_TEST_KEY:-}" ]; then
  export GPD_EXPLORER_KEY="$GPD_TEST_KEY"
fi

if [ -z "${GPD_EXPLORER_KEY:-}" ] && [ -n "${GPD_API_KEY:-}" ]; then
  export GPD_EXPLORER_KEY="$GPD_API_KEY"
fi

if [ -n "${GPD_EXPLORER_KEY:-}" ]; then
  export GPD_API_KEY="$GPD_EXPLORER_KEY"
elif [ "$GPD_EXPLORER_REQUIRE_KEY" = "1" ]; then
  echo "GPD_EXPLORER_KEY/GPD_TEST_KEY/GPD_API_KEY is required for logged-in full-app exploration." >&2
  echo "Set GPD_EXPLORER_REQUIRE_KEY=0 only when intentionally testing logged-out onboarding." >&2
  exit 2
fi

if [ -z "${GPD_APP_PATH:-}" ]; then
  CANDIDATE="$ROOT/packages/desktop/src-tauri/target/debug/bundle/macos/GPD Dev.app"
  if [ -d "$CANDIDATE" ]; then
    export GPD_APP_PATH="$CANDIDATE"
  elif [ -d "/Applications/GPD.app" ]; then
    export GPD_APP_PATH="/Applications/GPD.app"
  fi
fi

if ! command -v uv >/dev/null 2>&1; then
  echo "uv is required to run the test harness." >&2
  echo "Install it for developer runs, or run the GPD installer first so $HOME/.gpd/uv-bootstrap/uv exists." >&2
  exit 2
fi

bundle_id=""
if [ -n "${GPD_APP_PATH:-}" ] && [ -f "$GPD_APP_PATH/Contents/Info.plist" ] && [ -x /usr/libexec/PlistBuddy ]; then
  bundle_id="$(/usr/libexec/PlistBuddy -c 'Print CFBundleIdentifier' "$GPD_APP_PATH/Contents/Info.plist" 2>/dev/null || true)"
fi

if [ "$bundle_id" = "inc.psi.gpd" ] && [ "${GPD_EXPLORER_RELEASE_DRIVER:-0}" != "1" ]; then
  echo "GPD_APP_PATH points at a production release bundle ($GPD_APP_PATH)." >&2
  echo "Release bundles intentionally do not expose the debug MCP socket used by the explorer." >&2
  echo "Run the release smoke gate instead:" >&2
  echo "  cd packages/desktop/tests-gui && PYTEST_RELEASE_BUILD=1 GPD_APP_PATH='$GPD_APP_PATH' uv run pytest tests/smoke/test_release_no_mcp.py -m smoke -v" >&2
  echo "For full UI exploration, use a debug/test build or set GPD_EXPLORER_RELEASE_DRIVER=1 after the AX release driver lands." >&2
  exit 2
fi

{
  echo "# GPD manual full exploration"
  echo
  echo "- started_utc: $STAMP"
  echo "- depth: $GPD_EXPLORER_DEPTH"
  echo "- artifacts: $ART"
  echo "- isolated_home: $GPD_EXPLORER_ISOLATE_HOME"
  echo "- app_path: ${GPD_APP_PATH:-not set}"
  echo "- strict: $GPD_EXPLORER_STRICT"
  echo "- max_actions: $GPD_EXPLORER_MAX_ACTIONS"
  echo "- max_inputs: $GPD_EXPLORER_MAX_INPUTS"
  echo "- min_passive: $GPD_EXPLORER_MIN_PASSIVE"
  echo "- min_inputs_useful: $GPD_EXPLORER_MIN_INPUTS_USEFUL"
  echo "- run_destructive: $GPD_EXPLORER_RUN_DESTRUCTIVE"
  echo "- run_real_backend: $GPD_EXPLORER_RUN_REAL_BACKEND"
  echo "- key_present: $([ -n "${GPD_EXPLORER_KEY:-}" ] && echo 1 || echo 0)"
  echo "- quit_app: $GPD_EXPLORER_QUIT_APP"
  echo
} > "$ART/summary.md"

echo "Artifacts: $ART"
echo "Depth: $GPD_EXPLORER_DEPTH"
echo "App: ${GPD_APP_PATH:-not set}"

uv sync --extra dev

FAIL=0

run_group() {
  local label="$1"
  local marker="$2"
  local path="${3:-}"
  local xml="$ART/junit-$label.xml"
  local log="$ART/$label.log"
  echo
  echo "=== $label ==="
  if [ -n "$path" ]; then
    # Paths are repo-controlled pytest paths without spaces; allow a group to
    # pass multiple paths as "tests/ipc tests/security".
    uv run pytest $path -m "$marker" --junitxml="$xml" -v > "$log" 2>&1
  else
    uv run pytest -m "$marker" --junitxml="$xml" -v > "$log" 2>&1
  fi
  local rc=$?
  tail -40 "$log"
  echo "- $label: rc=$rc" >> "$ART/summary.md"
  if [ "$rc" -ne 0 ]; then
    FAIL=1
  fi
}

run_group unit "unit" "tests_unit"
run_group harness "harness_selftest" "tests/harness_selftest"
run_group explorer "explorer" "tests/explorer"

echo
echo "=== usefulness ==="
if uv run python scripts/validate_exploration_artifacts.py "$ART" | tee "$ART/usefulness.log"; then
  echo "- usefulness: rc=0" >> "$ART/summary.md"
else
  echo "- usefulness: rc=1" >> "$ART/summary.md"
  FAIL=1
fi

case "$GPD_EXPLORER_DEPTH" in
  inventory)
    ;;
  surfaces)
    run_group smoke "smoke and not restart" "tests/smoke"
    run_group surfaces "surfaces and not steals_focus" "tests/surfaces"
    ;;
  flows)
    run_group smoke "smoke and not restart" "tests/smoke"
    run_group surfaces "surfaces and not steals_focus" "tests/surfaces"
    run_group flows "flows and not real_backend" "tests/flows"
    run_group regression "regression" "tests/regression"
    run_group ipc_security "ipc or security" "tests/ipc tests/security"
    ;;
  full)
    run_group smoke "smoke and not restart" "tests/smoke"
    run_group surfaces "surfaces and not steals_focus" "tests/surfaces"
    run_group flows "flows and not real_backend" "tests/flows"
    run_group regression "regression" "tests/regression"
    run_group ipc_security "ipc or security" "tests/ipc tests/security"
    run_group broad "broad and not steals_focus" "tests/broad"
    run_group stress "flows and not real_backend" "tests/stress"
    ;;
  *)
    echo "Unknown GPD_EXPLORER_DEPTH=$GPD_EXPLORER_DEPTH" | tee -a "$ART/summary.md"
    exit 2
    ;;
esac

if [ "$GPD_EXPLORER_RUN_REAL_BACKEND" = "1" ]; then
  run_group real_backend "real_backend" "tests/flows tests/stress"
fi

if [ "$GPD_EXPLORER_RUN_DESTRUCTIVE" = "1" ]; then
  run_group restart "restart" "tests/smoke"
  run_group lifecycle "lifecycle" "tests/lifecycle"
fi

echo
echo "Summary: $ART/summary.md"
cat "$ART/summary.md"
exit "$FAIL"
