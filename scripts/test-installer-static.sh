#!/usr/bin/env bash
# Self-test for scripts/check-installer-static.sh.
#
# Two failure modes the static gates must defend against, BOTH of
# which we've shipped at least once this release cycle:
#
#   1. Real violation in source -> gate must FAIL CI (false negative
#      = we ship the bug to users).
#   2. Clean source -> gate must PASS CI (false positive = we block
#      every PR until we patch the gate).
#
# `scripts/check-installer-static.sh` running against the live repo
# only checks (1) by accident (when developers push violations) and
# never checks (2) — a gate could silently rot to "always fails" and
# we'd notice only when CI started rejecting unrelated work.
#
# This script tests both directions explicitly:
#   - clean fixture: every gate must report 0 fails
#   - one dirty fixture per gate: that gate must fire (and ONLY it
#     should fire for the targeted regression)
#
# Run locally: `bash scripts/test-installer-static.sh`
# Run in CI:   chained from .github/workflows/installer-lint.yml so
#              every push validates the gates themselves before
#              running them against source.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# IMPORTANT: don't reuse the real-tree gate when running fixtures.
# scripts/check-installer-static.sh resolves its own working dir via
# `dirname "$0"/..`, so invoking $REPO_ROOT/scripts/check-installer-static.sh
# from inside a tmp fixture would still cd back to the real repo and
# audit the live source instead of the mutated copy. Instead, every
# fixture gets its own copy of scripts/ via stage_fixture and we
# invoke <fixture>/scripts/check-installer-static.sh.

declare -i tests_run=0
declare -i tests_failed=0

# Build a known-clean fixture: a copy of the real install-gpd/ tree
# at HEAD plus a minimal README.md referencing only files that exist.
# Run the gate against it, assert 0 fails. If this fails, the gate
# is broken (false-positiving on clean source) — exactly today's
# heredoc-arg regression in gate 4.
expect_clean() {
  tests_run+=1
  local fixture="$1"
  local label="$2"
  if (cd "$fixture" && bash "$fixture/scripts/check-installer-static.sh") \
        >/tmp/gpd-self-test-out 2>&1; then
    echo "PASS clean fixture: $label"
  else
    echo "FAIL clean fixture should pass but gate reported failures: $label"
    sed 's/^/  /' /tmp/gpd-self-test-out
    tests_failed+=1
  fi
}

# Build a known-dirty fixture: clone of the clean tree plus ONE
# targeted regression. Assert gate fires (exit non-zero) and that
# the failure message mentions the gate-specific keyword.
expect_dirty() {
  tests_run+=1
  local fixture="$1"
  local label="$2"
  local expect_substr="$3"
  if (cd "$fixture" && bash "$fixture/scripts/check-installer-static.sh") \
        >/tmp/gpd-self-test-out 2>&1; then
    echo "FAIL dirty fixture should fail but gate reported all-clean: $label"
    sed 's/^/  /' /tmp/gpd-self-test-out
    tests_failed+=1
    return
  fi
  if ! grep -qF "$expect_substr" /tmp/gpd-self-test-out; then
    echo "FAIL dirty fixture: gate fired but message missing '$expect_substr' for: $label"
    sed 's/^/  /' /tmp/gpd-self-test-out
    tests_failed+=1
    return
  fi
  echo "PASS dirty fixture: $label"
}

stage_fixture() {
  # Copy the live install-gpd/ + README.md + scripts/ into a fresh
  # tmp dir so we can mutate without touching the working tree.
  local dst="$1"
  rm -rf "$dst"
  mkdir -p "$dst"
  cp -R "$REPO_ROOT/install-gpd"  "$dst/"
  cp -R "$REPO_ROOT/scripts"      "$dst/"
  cp    "$REPO_ROOT/README.md"    "$dst/"
}

ROOT_TMP="$(mktemp -d)"
trap 'rm -rf "$ROOT_TMP"' EXIT

echo "=== self-test: clean fixture ==="
CLEAN="$ROOT_TMP/clean"
stage_fixture "$CLEAN"
expect_clean "$CLEAN" "as-shipped install-gpd/ + README.md"

echo
echo "=== self-test: dirty fixture per gate ==="

# Gate 1: BOM in served .ps1
DIRTY="$ROOT_TMP/dirty-bom"
stage_fixture "$DIRTY"
{ printf '\xef\xbb\xbf'; cat "$DIRTY/install-gpd/windows_11/install.ps1"; } > "$DIRTY/install-gpd/windows_11/install.ps1.tmp"
mv "$DIRTY/install-gpd/windows_11/install.ps1.tmp" "$DIRTY/install-gpd/windows_11/install.ps1"
expect_dirty "$DIRTY" "BOM in install.ps1" "UTF-8 BOM"

# Gate 2: non-ASCII byte in bootstrap
DIRTY="$ROOT_TMP/dirty-nonascii"
stage_fixture "$DIRTY"
{ printf '# caf\xc3\xa9\n'; cat "$DIRTY/install-gpd/windows_11/install.ps1"; } > "$DIRTY/install-gpd/windows_11/install.ps1.tmp"
mv "$DIRTY/install-gpd/windows_11/install.ps1.tmp" "$DIRTY/install-gpd/windows_11/install.ps1"
expect_dirty "$DIRTY" "non-ASCII in bootstrap" "non-ASCII"

# Gate 4: top-level `exit` in main
DIRTY="$ROOT_TMP/dirty-toplevel-exit"
stage_fixture "$DIRTY"
printf '\nexit 7\n' >> "$DIRTY/install-gpd/windows_11/install_main.ps1"
expect_dirty "$DIRTY" "top-level exit in install_main.ps1" "top-level"

# Gate 5: bash syntax error
DIRTY="$ROOT_TMP/dirty-bash-syntax"
stage_fixture "$DIRTY"
printf '\nif [[ unclosed\n' >> "$DIRTY/install-gpd/install"
expect_dirty "$DIRTY" "bash syntax error in install" "bash syntax error"

# Gate 5b: stdout pollution inside command-substitution helper
DIRTY="$ROOT_TMP/dirty-uv-stdout"
stage_fixture "$DIRTY"
perl -0pi -e 's/log "Installing uv \(manages app-local Python\)\.\.\." >&2/log "Installing uv (manages app-local Python)..."/' "$DIRTY/install-gpd/install"
expect_dirty "$DIRTY" "install_uv_bootstrap stdout pollution" "stdout"

# Gate 7: README references unmapped URL
DIRTY="$ROOT_TMP/dirty-readme-unmapped"
stage_fixture "$DIRTY"
echo 'irm https://download.gpd.psi.inc/install_xyz.ps1 | iex' >> "$DIRTY/install-gpd/README.md"
expect_dirty "$DIRTY" "README references unmapped URL" "no source-file mapping"

echo
echo "=== summary ==="
echo "tests run:    $tests_run"
echo "tests failed: $tests_failed"
if (( tests_failed > 0 )); then
  exit 1
fi
echo "RESULT: gate self-test passed"
