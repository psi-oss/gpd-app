#!/usr/bin/env bash
# scripts/dev/install-from-draft.sh
#
# INTERNAL DEV INSTALLER FOR GPD DESKTOP.
#
# Parallel to install-gpd/install (the user-facing CLI installer at
# https://download.gpd.psi.inc/install) but pulls from sources that
# external users should NEVER see:
#
#   * The desktop binary comes from the most recent UNPUBLISHED DRAFT
#     release on github.com/psi-oss/gpd-app (the user-facing path
#     pulls from the latest /releases/latest published release).
#
#   * get-physics-done is installed from the `main` branch of
#     github.com/psi-oss/get-physics-done via uv pip's git+https
#     specifier, NOT from PyPI or npm. The desktop app's first-run
#     setup (gpd_setup.rs) pip-installs from PyPI by default; this
#     script overrides that AFTER first-run by force-reinstalling
#     get-physics-done from the main-branch source tree.
#
# Both sources require gh-CLI auth that can see the unpublished
# drafts (the repo's GitHub Apps token or an internal collaborator
# PAT). DO NOT publish this script or its URL to end users — the
# draft binary has not gone through the placeholder-TOS gate, the
# code-signing flip (`gh release edit --draft=false`), or the
# download-page resync, and the main-branch sidecar isn't a
# release-managed wheel.
#
# Usage:
#   scripts/dev/install-from-draft.sh
#   scripts/dev/install-from-draft.sh --repo psi-oss/gpd-app
#   scripts/dev/install-from-draft.sh --tag gpd-desktop-v1.2.0
#   scripts/dev/install-from-draft.sh --gpd-ref some-feature-branch
#   scripts/dev/install-from-draft.sh --app-only       # skip the gpd swap
#   scripts/dev/install-from-draft.sh --gpd-only       # skip downloading
#                                                     # the desktop binary
#   scripts/dev/install-from-draft.sh --no-launch      # don't auto-open
#                                                     # the .app after install

set -euo pipefail

# ── Internal-use banner ────────────────────────────────────────────────────
# Print this BEFORE any other side effect so a curl-piped run can never
# accidentally do work without the user seeing the warning. stderr so a
# stdout-redirected pipeline (`script.sh > log`) still surfaces it.
cat >&2 <<'BANNER'
────────────────────────────────────────────────────────────────────────
  INTERNAL GPD DEV INSTALLER — NOT FOR END USERS

  This installs an UNPUBLISHED DRAFT desktop build and replaces the
  PyPI sidecar with the current main branch of get-physics-done. The
  draft has NOT been through the placeholder-TOS gate, the code-sign
  flip, or the download-page resync. Do NOT redistribute this URL to
  external users.

  End users should use:  curl -fsSL https://download.gpd.psi.inc/install | bash
────────────────────────────────────────────────────────────────────────
BANNER

# ── Configuration ──────────────────────────────────────────────────────────

DESKTOP_REPO="${DESKTOP_REPO:-psi-oss/gpd-app}"
GPD_SOURCE_REPO="${GPD_SOURCE_REPO:-psi-oss/get-physics-done}"
GPD_REF="${GPD_REF:-main}"

GPD_HOME="${GPD_HOME:-$HOME/.gpd}"
# The desktop app's first-run setup (gpd_setup.rs) creates this path
# WITHOUT a leading dot — `~/.gpd/venv`, not `~/.gpd/.venv`. Caught
# after 1.0.5 install-draft hit "doesn't exist" on the swap step.
GPD_VENV="$GPD_HOME/venv"
GPD_UV="$GPD_HOME/bin/uv"

DESKTOP_ONLY=0
GPD_ONLY=0
LAUNCH_AFTER_INSTALL=1
FORCED_TAG=""

# ── Logging helpers ────────────────────────────────────────────────────────

c_blue=$'\033[34m'
c_red=$'\033[31m'
c_yellow=$'\033[33m'
c_green=$'\033[32m'
c_dim=$'\033[2m'
c_reset=$'\033[0m'

log()     { printf '%s==>%s %s\n' "$c_blue" "$c_reset" "$*" >&2; }
warn()    { printf '%swarn:%s %s\n' "$c_yellow" "$c_reset" "$*" >&2; }
die()     { printf '%serror:%s %s\n' "$c_red" "$c_reset" "$*" >&2; exit 1; }
success() { printf '%s✓%s %s\n' "$c_green" "$c_reset" "$*" >&2; }
dim()     { printf '%s%s%s\n' "$c_dim" "$*" "$c_reset" >&2; }
# All informational output MUST go to stderr — `download_draft_asset`
# and similar helpers print the resolved path to stdout, which is then
# captured via `$(...)`. If log/success/dim leaked to stdout, the
# captured path would be polluted with log lines and `hdiutil attach`
# would fail with "couldn't determine DMG mount point" because the
# path argument is multi-line junk. Caught after 1.0.4 install-draft
# hit "can't find dmg mount point" reports.

# ── Argument parsing ───────────────────────────────────────────────────────

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)        DESKTOP_REPO="$2"; shift 2 ;;
    --tag)         FORCED_TAG="$2"; shift 2 ;;
    --gpd-repo)    GPD_SOURCE_REPO="$2"; shift 2 ;;
    --gpd-ref)     GPD_REF="$2"; shift 2 ;;
    --app-only)    GPD_ONLY=0; DESKTOP_ONLY=1; shift ;;
    --gpd-only)    DESKTOP_ONLY=0; GPD_ONLY=1; shift ;;
    --no-launch)   LAUNCH_AFTER_INSTALL=0; shift ;;
    -h|--help)
      sed -n '2,32p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) die "unknown argument: $1 (try --help)" ;;
  esac
done

# ── Pre-flight ─────────────────────────────────────────────────────────────

command -v gh >/dev/null 2>&1 || die "gh CLI not installed. brew install gh."
gh auth status >/dev/null 2>&1 || die "gh CLI not authenticated. Run: gh auth login --scopes repo,read:org"

OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"

case "$OS-$ARCH" in
  darwin-arm64)    ASSET_PATTERN="*aarch64.dmg" ; PLATFORM="mac-arm" ;;
  darwin-x86_64)   ASSET_PATTERN="*x64.dmg"     ; PLATFORM="mac-intel" ;;
  linux-x86_64)
    # Prefer .AppImage for portability; fall back to .deb. Both ship
    # in every gpd-desktop-v* release per gpd-release.yml's matrix.
    ASSET_PATTERN="*amd64.AppImage"             ; PLATFORM="linux" ;;
  *)
    die "unsupported platform: $OS-$ARCH. Supported: darwin-arm64, darwin-x86_64, linux-x86_64. Windows ARM/x64 not yet automated — download the .msi from the draft release manually."
    ;;
esac

# ── Step 1: Find the draft release ─────────────────────────────────────────

resolve_draft_tag() {
  if [[ -n "$FORCED_TAG" ]]; then
    if ! printf '%s' "$FORCED_TAG" | grep -Eq '^gpd-desktop-v[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.]+)?$'; then
      die "--tag must match gpd-desktop-vX.Y.Z (got: $FORCED_TAG)"
    fi
    printf '%s' "$FORCED_TAG"
    return
  fi
  # Pick the most recently created draft release whose tag matches
  # gpd-desktop-v*. Drafts have no underlying git ref until publish,
  # so the gh CLI's release-list (which fans out to /releases) is the
  # only authoritative source — /releases/tags/<tag> 404s on drafts.
  local tag
  tag=$(gh release list --repo "$DESKTOP_REPO" --limit 100 \
        --json tagName,isDraft,createdAt \
        --jq '[.[] | select(.isDraft == true and (.tagName | startswith("gpd-desktop-v")))] | sort_by(.createdAt) | reverse | .[0].tagName // ""')
  if [[ -z "$tag" ]]; then
    die "no draft gpd-desktop-v* release found in the most recent 100. Did gpd-release.yml finish? Check: gh run list --workflow gpd-release.yml --repo $DESKTOP_REPO --limit 5"
  fi
  printf '%s' "$tag"
}

download_draft_asset() {
  local tag="$1"
  local tmpdir
  tmpdir=$(mktemp -d)
  log "Looking up assets for $tag (pattern: $ASSET_PATTERN)..."

  # gh release view also resolves drafts. Filter assets locally so
  # the user sees what's available if the pattern doesn't match.
  local assets
  assets=$(gh release view "$tag" --repo "$DESKTOP_REPO" --json assets --jq '.assets[].name')

  if [[ -z "$assets" ]]; then
    die "$tag has no assets uploaded yet. Wait for gpd-release.yml to finish, then re-run."
  fi

  local matched
  matched=$(printf '%s\n' "$assets" | grep -E "${ASSET_PATTERN//\*/.*}$" || true)
  if [[ -z "$matched" ]]; then
    warn "no asset matched '$ASSET_PATTERN' in $tag. Available:"
    printf '%s\n' "$assets" | sed 's/^/  /' >&2
    die "rerun with --tag to override, or open the draft manually: https://github.com/$DESKTOP_REPO/releases"
  fi

  # If multiple match (e.g. .dmg and .dmg.sig), pick the .dmg/.AppImage.
  local asset
  asset=$(printf '%s\n' "$matched" | grep -Ev '\.(sig|sha256)$' | head -1)
  log "Downloading $asset to $tmpdir/ ..."
  gh release download "$tag" --repo "$DESKTOP_REPO" --pattern "$asset" --dir "$tmpdir"
  printf '%s/%s' "$tmpdir" "$asset"
}

install_macos_dmg() {
  local dmg="$1"
  log "Mounting $(basename "$dmg")..."
  # NOTE: don't combine `-quiet` with `-plist`. `-quiet` wins and
  # suppresses the plist output, leaving the parser with an empty
  # string → "couldn't determine DMG mount point" even when the
  # mount actually succeeded. Caught on 1.0.4 install-draft reports.
  local mount_info
  mount_info=$(hdiutil attach "$dmg" -nobrowse -plist)
  local mount_point
  mount_point=$(printf '%s' "$mount_info" | grep -A1 '<key>mount-point</key>' | tail -1 | sed -E 's/.*<string>(.*)<\/string>.*/\1/')
  if [[ -z "$mount_point" || ! -d "$mount_point" ]]; then
    die "couldn't determine DMG mount point. Check the .dmg file manually: $dmg"
  fi
  local app
  app=$(find "$mount_point" -maxdepth 1 -name "*.app" -type d | head -1)
  if [[ -z "$app" ]]; then
    hdiutil detach "$mount_point" -quiet || true
    die "no .app bundle inside DMG"
  fi
  local target="/Applications/$(basename "$app")"
  if [[ -d "$target" ]]; then
    log "Removing previous install at $target..."
    rm -rf "$target"
  fi
  log "Copying $(basename "$app") to /Applications ..."
  cp -R "$app" /Applications/
  hdiutil detach "$mount_point" -quiet
  # Strip Apple's quarantine attribute so Gatekeeper doesn't pop the
  # "downloaded from the internet" dialog on first launch. Drafts
  # are still notarized by the release workflow but quarantine flags
  # are applied per-process by the downloader (gh in our case).
  xattr -dr com.apple.quarantine "$target" 2>/dev/null || true
  success "Installed $target"
  if [[ "$LAUNCH_AFTER_INSTALL" -eq 1 ]]; then
    log "Launching app to trigger first-run setup (sidecar venv + opencode config)..."
    open -a "$target"
    log "Wait for the app to finish first-run setup (~30-60s the first time)."
    log "When ~/.gpd/.gpd-initialized exists, the get-physics-done swap will run."
    local waited=0
    while [[ ! -f "$GPD_HOME/.gpd-initialized" && $waited -lt 180 ]]; do
      sleep 2
      waited=$((waited + 2))
    done
    if [[ ! -f "$GPD_HOME/.gpd-initialized" ]]; then
      warn "still no $GPD_HOME/.gpd-initialized after 180s. Skipping the get-physics-done swap. Re-run with --gpd-only after first-run completes."
      return 1
    fi
    success "First-run setup finished."
  fi
  return 0
}

install_linux_appimage() {
  local img="$1"
  local target="$HOME/.local/bin/GPD.AppImage"
  mkdir -p "$(dirname "$target")"
  log "Copying AppImage to $target ..."
  cp "$img" "$target"
  chmod +x "$target"
  success "Installed $target. Add ~/.local/bin to PATH if not already on it."
  if [[ "$LAUNCH_AFTER_INSTALL" -eq 1 ]]; then
    log "Launching app to trigger first-run setup..."
    nohup "$target" >/dev/null 2>&1 &
    local waited=0
    while [[ ! -f "$GPD_HOME/.gpd-initialized" && $waited -lt 180 ]]; do
      sleep 2
      waited=$((waited + 2))
    done
    if [[ ! -f "$GPD_HOME/.gpd-initialized" ]]; then
      warn "still no $GPD_HOME/.gpd-initialized after 180s. Skipping swap. Re-run with --gpd-only after first-run completes."
      return 1
    fi
  fi
  return 0
}

# ── Step 2: Swap get-physics-done to main-branch GitHub source ────────────

swap_gpd_to_github_main() {
  if [[ ! -d "$GPD_VENV" ]]; then
    die "$GPD_VENV doesn't exist. Launch the GPD app once so it can create the venv, then re-run with --gpd-only."
  fi

  # The bundled `uv` is symlinked into ~/.gpd/bin/uv by gpd_setup.rs
  # (see ensure_gpd_installed: gpd_bin/uv -> bundled uv). Fall back
  # to system uv or pip if that symlink is missing.
  local uv_cmd=""
  if [[ -x "$GPD_UV" ]]; then
    uv_cmd="$GPD_UV"
  elif command -v uv >/dev/null 2>&1; then
    uv_cmd="$(command -v uv)"
  fi

  local spec="get-physics-done[arxiv] @ git+https://github.com/${GPD_SOURCE_REPO}@${GPD_REF}"
  log "Force-reinstalling get-physics-done from $GPD_SOURCE_REPO@$GPD_REF into $GPD_VENV ..."
  log "Spec: $spec"

  if [[ -n "$uv_cmd" ]]; then
    "$uv_cmd" pip install --reinstall \
      --python "$GPD_VENV/bin/python" \
      "$spec"
  else
    warn "no uv found; falling back to venv pip (slower; will rebuild from sdist)."
    "$GPD_VENV/bin/pip" install --force-reinstall --no-deps \
      "$spec"
    # --no-deps means we re-install the package itself but not deps;
    # PyPI deps already there from the original install will remain
    # at their PyPI-resolved versions, which matches what the
    # main-branch pyproject.toml's deps list would have asked for.
  fi

  # Sanity-check: import and report the installed version + commit.
  local version
  version=$("$GPD_VENV/bin/python" -c 'import gpd, gpd.core.profile; print(getattr(gpd, "__version__", "?"))' 2>/dev/null || echo "?")
  success "get-physics-done now installed from $GPD_SOURCE_REPO@$GPD_REF (version $version)"
  dim "    (the PyPI version that gpd_setup.rs installed has been replaced in-place)"
}

# ── Run ────────────────────────────────────────────────────────────────────

if [[ "$GPD_ONLY" -ne 1 ]]; then
  log "Resolving latest draft release in $DESKTOP_REPO ..."
  TAG=$(resolve_draft_tag)
  success "Selected draft: $TAG"

  ASSET_PATH=$(download_draft_asset "$TAG")
  success "Downloaded to $ASSET_PATH"

  case "$PLATFORM" in
    mac-arm|mac-intel) install_macos_dmg "$ASSET_PATH" || true ;;
    linux)             install_linux_appimage "$ASSET_PATH" || true ;;
  esac
fi

if [[ "$DESKTOP_ONLY" -ne 1 ]]; then
  swap_gpd_to_github_main
fi

success "Done."
dim "    Desktop binary: from draft release on $DESKTOP_REPO"
dim "    get-physics-done: from $GPD_SOURCE_REPO@$GPD_REF (not PyPI)"
