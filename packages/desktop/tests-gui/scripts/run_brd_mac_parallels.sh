#!/usr/bin/env bash
# Host-side helper for running the macOS BRD suite inside a Parallels macOS VM.
#
# This script intentionally avoids embedding secrets. Put local keys in the
# repo-root .env file on the host and/or inside the guest; .env is gitignored.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
VM="${GPD_PARALLELS_MAC_VM:-GPD macOS BRD}"
SNAP="${GPD_PARALLELS_SNAPSHOT:-brd-clean}"
IPSW="${GPD_PARALLELS_MAC_IPSW:-}"
GUEST_REPO="${GPD_PARALLELS_GUEST_REPO:-}"
GUEST_USER="${GPD_PARALLELS_GUEST_USER:-}"
GUEST_PASS="${GPD_PARALLELS_GUEST_PASSWORD:-}"
DEPTH="${GPD_BRD_DEPTH:-full}"
INSTALL_ARGS="${GPD_INSTALLER_ARGS:---no-launch}"

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<EOF
Usage:
  bash packages/desktop/tests-gui/scripts/run_brd_mac_parallels.sh <command>

Commands:
  doctor          Show host/Parallels/VM status.
  list            List registered Parallels VMs.
  create          Create a macOS VM from GPD_PARALLELS_MAC_IPSW.
  start           Start the macOS BRD VM.
  stop            Stop the macOS BRD VM.
  snapshot        Create a clean snapshot named GPD_PARALLELS_SNAPSHOT.
  snapshots       List VM snapshots.
  revert <id>     Revert to a snapshot id from 'snapshots'.
  guest-check     Check guest tools via prlctl exec.
  install-local   Run this checkout's install-gpd/install inside the guest.
  verify-install  Verify the installer-created app, uv, Python, venv, marker.
  release-smoke   Run release-bundle smoke checks against /Applications/GPD.app.
  guest-run       Run the BRD suite inside the guest against default app path.
  guest-run-installed
                  Run the BRD suite against installer-created /Applications/GPD.app.
  installer-full  Run install-local, verify-install, then release-smoke.
  print-setup     Print manual guest setup commands.

Environment:
  GPD_PARALLELS_MAC_VM         Default: "GPD macOS BRD"
  GPD_PARALLELS_MAC_IPSW       Required for 'create'.
  GPD_PARALLELS_SNAPSHOT       Default: "brd-clean"
  GPD_PARALLELS_GUEST_REPO     Repo path inside guest or shared folder.
  GPD_PARALLELS_GUEST_USER     Optional guest username for prlctl exec.
  GPD_PARALLELS_GUEST_PASSWORD Optional guest password for prlctl exec.
  GPD_BRD_DEPTH                inventory|surfaces|flows|full, default full.
  GPD_INSTALLER_ARGS           Arguments passed to install-gpd/install, default "--no-launch".

Examples:
  GPD_PARALLELS_MAC_IPSW="\$HOME/Downloads/UniversalMac_15.x_Restore.ipsw" \\
    bash packages/desktop/tests-gui/scripts/run_brd_mac_parallels.sh create

  bash packages/desktop/tests-gui/scripts/run_brd_mac_parallels.sh snapshot
  bash packages/desktop/tests-gui/scripts/run_brd_mac_parallels.sh snapshots
  bash packages/desktop/tests-gui/scripts/run_brd_mac_parallels.sh revert '{snapshot-id}'

  GPD_PARALLELS_GUEST_REPO="/Users/tester/gpd-opencode-fresh" \\
    GPD_PARALLELS_GUEST_USER="tester" \\
    GPD_PARALLELS_GUEST_PASSWORD="..." \\
    bash packages/desktop/tests-gui/scripts/run_brd_mac_parallels.sh installer-full
EOF
}

require_prlctl() {
  command -v prlctl >/dev/null 2>&1 || die "prlctl not found; install/open Parallels Desktop first"
}

exists() {
  prlctl list -a --no-header 2>/dev/null | awk '{$1=$1; print}' | grep -F " $VM" >/dev/null
}

exec_guest() {
  local cmd="$1"
  if [ -n "$GUEST_USER" ] && [ -n "$GUEST_PASS" ]; then
    printf '%s\n' "$cmd" | prlctl exec "$VM" --user "$GUEST_USER" --password "$GUEST_PASS" /bin/bash -s
    return
  fi
  printf '%s\n' "$cmd" | prlctl exec "$VM" --current-user /bin/bash -s
}

shell_quote() {
  printf '%q' "$1"
}

run_local_installer() {
  exists || die "VM not found: $VM"
  [ -f "$ROOT/install-gpd/install" ] || die "installer not found: $ROOT/install-gpd/install"
  if [ -n "$GUEST_USER" ] && [ -n "$GUEST_PASS" ]; then
    # shellcheck disable=SC2086
    prlctl exec "$VM" --user "$GUEST_USER" --password "$GUEST_PASS" /bin/bash -s -- $INSTALL_ARGS < "$ROOT/install-gpd/install"
    return
  fi
  # shellcheck disable=SC2086
  prlctl exec "$VM" --current-user /bin/bash -s -- $INSTALL_ARGS < "$ROOT/install-gpd/install"
}

verify_installer_install() {
  exists || die "VM not found: $VM"
  exec_guest 'set -euo pipefail
test -d /Applications/GPD.app
test -x "$HOME/.gpd/uv-bootstrap/uv"
test -x "$HOME/.gpd/python/bin/python3"
test -x "$HOME/.gpd/venv/bin/python"
test -x "$HOME/.gpd/venv/bin/gpd"
test -f "$HOME/.gpd/.gpd-initialized"
"$HOME/.gpd/python/bin/python3" --version
printf "import gpd\nprint(\"gpd-import-ok\")\n" | "$HOME/.gpd/venv/bin/python"
if [ -d /Library/Developer/CommandLineTools ]; then
  echo "clt=1"
else
  echo "clt=0"
fi'
}

run_guest_suite() {
  local app_path="${1:-}"
  exists || die "VM not found: $VM"
  [ -n "$GUEST_REPO" ] || die "set GPD_PARALLELS_GUEST_REPO to the repo path inside the guest"

  local repo_q depth_q app_q
  repo_q="$(shell_quote "$GUEST_REPO")"
  depth_q="$(shell_quote "$DEPTH")"
  app_q="$(shell_quote "$app_path")"

  if [ -n "$app_path" ]; then
    exec_guest "set -euo pipefail
cd $repo_q
set -a
[ -f .env ] && source .env
set +a
export PATH=\"\$HOME/.gpd/uv-bootstrap:\$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:\$PATH\"
export GPD_APP_PATH=$app_q
: \"\${GPD_EXPLORER_ISOLATE_HOME:=0}\"
: \"\${GPD_EXPLORER_QUIT_APP:=1}\"
export GPD_EXPLORER_ISOLATE_HOME GPD_EXPLORER_QUIT_APP
GPD_EXPLORER_DEPTH=$depth_q bash packages/desktop/tests-gui/scripts/run_manual_full_exploration.sh"
    return
  fi

  exec_guest "set -euo pipefail
cd $repo_q
set -a
[ -f .env ] && source .env
set +a
export PATH=\"\$HOME/.gpd/uv-bootstrap:\$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:\$PATH\"
GPD_EXPLORER_DEPTH=$depth_q bash packages/desktop/tests-gui/scripts/run_manual_full_exploration.sh"
}

run_release_smoke() {
  exists || die "VM not found: $VM"
  [ -n "$GUEST_REPO" ] || die "set GPD_PARALLELS_GUEST_REPO to the repo path inside the guest"

  local repo_q
  repo_q="$(shell_quote "$GUEST_REPO")"
  exec_guest "set -euo pipefail
cd $repo_q/packages/desktop/tests-gui
set -a
[ -f ../../.env ] && source ../../.env
[ -f ../../../.env ] && source ../../../.env
set +a
export PATH=\"\$HOME/.gpd/uv-bootstrap:\$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:\$PATH\"
export GPD_APP_PATH=/Applications/GPD.app
export PYTEST_RELEASE_BUILD=1
export GPD_RELEASE_ONBOARDING_RESET=1
uv sync --extra dev
uv run pytest tests/smoke/test_release_no_mcp.py tests/smoke/test_release_tos_ax.py -m smoke -v"
}

cmd="${1:-help}"
shift || true

require_prlctl

case "$cmd" in
  help|-h|--help)
    usage
    ;;
  doctor)
    printf 'repo: %s\n' "$ROOT"
    printf 'host: '
    sw_vers | tr '\n' ' '
    printf '\narch: %s\n' "$(uname -m)"
    prlctl --version
    printf 'target_vm: %s\n' "$VM"
    printf 'target_vm_exists: '
    if exists; then printf '1\n'; else printf '0\n'; fi
    printf 'env_file_gitignored: '
    if git check-ignore -q "$ROOT/.env"; then printf '1\n'; else printf '0\n'; fi
    printf 'backend_key_present: '
    if [ -f "$ROOT/.env" ] && grep -q '^GPD_TEST_KEY=' "$ROOT/.env"; then printf '1\n'; else printf '0\n'; fi
    printf '\nRegistered VMs:\n'
    prlctl list -a
    ;;
  list)
    prlctl list -a
    ;;
  create)
    [ -n "$IPSW" ] || die "set GPD_PARALLELS_MAC_IPSW to a local UniversalMac Restore.ipsw"
    [ -f "$IPSW" ] || die "IPSW not found: $IPSW"
    if exists; then
      die "VM already exists: $VM"
    fi
    prlctl create "$VM" -o macos --restore-image "$IPSW"
    prlctl set "$VM" --cpus "${GPD_PARALLELS_CPUS:-4}" --memsize "${GPD_PARALLELS_MEM_MB:-8192}"
    printf 'created VM: %s\n' "$VM"
    printf 'start it, finish macOS Setup Assistant, install Parallels Tools if prompted, then run snapshot.\n'
    ;;
  start)
    exists || die "VM not found: $VM"
    prlctl start "$VM"
    ;;
  stop)
    exists || die "VM not found: $VM"
    prlctl stop "$VM" --kill
    ;;
  snapshot)
    exists || die "VM not found: $VM"
    prlctl snapshot "$VM" -n "$SNAP" -d "Clean BRD baseline created by tests-gui helper"
    ;;
  snapshots)
    exists || die "VM not found: $VM"
    prlctl snapshot-list "$VM" --tree
    ;;
  revert)
    exists || die "VM not found: $VM"
    id="${1:-}"
    [ -n "$id" ] || die "pass a snapshot id from: prlctl snapshot-list \"$VM\" --tree"
    prlctl snapshot-switch "$VM" --id "$id" --skip-resume
    ;;
  guest-check)
    exists || die "VM not found: $VM"
    exec_guest 'set -e; sw_vers; uname -m; command -v git || true; command -v bun || true; command -v rustc || true; command -v uv || true; command -v cliclick || true'
    ;;
  install-local)
    run_local_installer
    ;;
  verify-install)
    verify_installer_install
    ;;
  release-smoke)
    run_release_smoke
    ;;
  guest-run)
    run_guest_suite
    ;;
  guest-run-installed)
    run_guest_suite "/Applications/GPD.app"
    ;;
  installer-full)
    run_local_installer
    verify_installer_install
    run_release_smoke
    ;;
  print-setup)
    cat <<EOF
Installer-backed lane:

  # Host:
  bash packages/desktop/tests-gui/scripts/run_brd_mac_parallels.sh install-local
  bash packages/desktop/tests-gui/scripts/run_brd_mac_parallels.sh verify-install

  # Guest: make the repo available for the test harness only.
  # The app under test still comes from the installer at /Applications/GPD.app.
  cd ~/gpd-opencode-fresh
  cp <secure-source> .env
  chmod 600 .env

  # Host:
  GPD_BRD_DEPTH=$DEPTH bash packages/desktop/tests-gui/scripts/run_brd_mac_parallels.sh guest-run-installed

Developer-debug lane:

  Install git/bun/rust/uv/cliclick only when you intentionally want to build
  and test GPD Dev.app inside the guest rather than testing the installer app.

After setup, create a Parallels snapshot from the host:

  bash packages/desktop/tests-gui/scripts/run_brd_mac_parallels.sh snapshot
EOF
    ;;
  *)
    usage
    exit 2
    ;;
esac
