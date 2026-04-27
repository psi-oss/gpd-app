#!/usr/bin/env bash
# GPD — Get Physics Done: unified uninstaller (macOS + Linux)
#
# Detects platform at runtime + branches the OS-specific cleanup.
# Replaces the previous split between `uninstall.sh` (Linux) and
# `uninstall_macos.sh` (macOS). Mirrors the unified `install` script
# layout so users see a single cross-platform UX.
#
# Usage:
#   bash uninstall
#   bash uninstall --yes        # skip confirmation prompt
#
# Removes (both platforms):
#   - ~/.gpd/ (bin, config, python, venv)
#   - PATH entries + GPD_API_KEY exports from sentinel-bracketed shell rc
#     blocks (open `# >>> GPD CLI >>>` / close `# <<< GPD CLI <<<`)
#   - "gpd" entry from opencode auth.json
#   - GPD-specific entries in opencode.json (provider.gpd, model gpd/*,
#     enabled_providers list)
#   - Files listed in gpd-file-manifest.json + the manifest itself
#   - `~/.config/opencode/get-physics-done/` subdir (GPD-owned, blocking
#     fresh installs if left behind)
#   - Orphan GPD-managed marker files in opencode/{command,agents,hooks}
#     when no manifest is present
#
# macOS-only:
#   - /Applications/GPD.app
#   - ~/Library/Application Support/{GPD,inc.psi.gpd}/
#   - ~/Library/Caches/inc.psi.gpd/
#   - ~/Library/WebKit/inc.psi.gpd/
#
# Linux-only:
#   - GPD .deb package via dpkg --remove (Ubuntu/Debian)
#   - ~/.config/{gpd,inc.psi.gpd}/
#   - ~/.local/share/inc.psi.gpd/
#   - ~/.cache/inc.psi.gpd/
#
# Does NOT remove:
#   - The rest of opencode's config/data dir (preserves other providers,
#     chat history, custom prompts).
#   - LaTeX (BasicTeX / MacTeX / texlive-*) — detected and reported for
#     manual cleanup.
#   - Homebrew / apt / Xcode CLT / system Python.

set -euo pipefail

# ── Colors & logging ──────────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
RESET='\033[0m'

log()     { printf " ${CYAN}i${RESET} %s\n" "$*"; }
success() { printf " ${GREEN}+${RESET} %s\n" "$*"; }
warn()    { printf " ${YELLOW}!${RESET} %s\n" "$*"; }
skip()    { printf " ${DIM}-${RESET} %s\n" "$*"; }

# ── Platform detection ────────────────────────────────────────────────────

case "$(uname -s)" in
    Darwin) os="darwin" ;;
    Linux)  os="linux"  ;;
    *)
        printf "${RED}Unsupported platform: $(uname -s).${RESET}\n" >&2
        printf "This uninstaller targets macOS + Linux. For Windows, use uninstall.ps1.\n" >&2
        exit 1
        ;;
esac

# ── Arguments ─────────────────────────────────────────────────────────────

auto_yes=false
while [[ $# -gt 0 ]]; do
    case "$1" in
        -y|--yes) auto_yes=true; shift ;;
        -h|--help)
            printf "Usage: uninstall [--yes]\n"
            printf "  --yes, -y   Skip confirmation prompt\n"
            exit 0
            ;;
        *) shift ;;
    esac
done

# ── Configuration ─────────────────────────────────────────────────────────

GPD_HOME="${GPD_HOME:-$HOME/.gpd}"
GPD_BIN_DIR="$GPD_HOME/bin"

# opencode uses xdg-basedir v5 which always resolves xdgData to
# $HOME/.local/share regardless of platform; the installer matches that.
XDG_DATA="${XDG_DATA_HOME:-$HOME/.local/share}"
OPENCODE_DATA_DIR="$XDG_DATA/opencode"
OPENCODE_AUTH="$OPENCODE_DATA_DIR/auth.json"
OPENCODE_CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"

# get-physics-done/ subdir inside opencode config — populated by
# `gpd install opencode --global`. Wholly GPD-owned; remove
# unconditionally because re-running the installer against a stale dir
# trips gpd 1.2.x's preflight with "untrusted GPD manifest".
opencode_gpd_subdir="$OPENCODE_CONFIG_DIR/get-physics-done"

# Platform-specific app/state dirs.
gpd_app=""
app_support_dirs=()
deb_package=""
case "$os" in
    darwin)
        gpd_app="/Applications/GPD.app"
        # Tauri WebView data on macOS — stores localStorage (incl. the
        # "gpd.key.saved" flag the welcome screen keys off of), cookies,
        # WebKit cache, IndexedDB. Wiping these ensures a reinstall
        # doesn't inherit the previous install's "already-onboarded"
        # signal.
        app_support_dirs=(
            "$HOME/Library/Application Support/GPD"
            "$HOME/Library/Application Support/inc.psi.gpd"
            "$HOME/Library/Caches/inc.psi.gpd"
            "$HOME/Library/WebKit/inc.psi.gpd"
        )
        ;;
    linux)
        # Linux GUI config / cache dirs. Tauri uses XDG paths under
        # ~/.config and ~/.local/share.
        app_support_dirs=(
            "$HOME/.config/gpd"
            "$HOME/.config/inc.psi.gpd"
            "$HOME/.local/share/inc.psi.gpd"
            "$HOME/.cache/inc.psi.gpd"
        )
        if command -v dpkg &>/dev/null && dpkg -l gpd 2>/dev/null | grep -q "^ii"; then
            deb_package="gpd"
        fi
        ;;
esac

# Prefer the GPD-managed Python over the system stub. On a fresh macOS
# without Xcode CLT, /usr/bin/python3 pops a GUI install dialog when
# invoked — even from a non-GUI session — which is poor UX for an
# uninstaller. The installer always creates a venv at $GPD_HOME/venv,
# so we reach for that first and fall back to the system python only
# if the venv is gone.
PY=""
if [[ -x "$GPD_HOME/venv/bin/python" ]]; then
    PY="$GPD_HOME/venv/bin/python"
elif [[ -x "$GPD_HOME/python/bin/python3" ]]; then
    PY="$GPD_HOME/python/bin/python3"
elif command -v python3 &>/dev/null && python3 -c '' &>/dev/null; then
    PY="$(command -v python3)"
fi

# ── Discovery: show what will be removed ──────────────────────────────────

printf "\n"
case "$os" in
    darwin) printf "${BOLD} GPD Uninstaller (macOS)${RESET}\n" ;;
    linux)  printf "${BOLD} GPD Uninstaller (Linux)${RESET}\n"  ;;
esac
printf "\n"

found_anything=false

if [[ -d "$GPD_HOME" ]]; then
    log "Found GPD directory: $GPD_HOME"
    found_anything=true
fi

# Desktop app / .deb package (per-OS).
remove_gpd_app=false
if [[ -n "$gpd_app" && -d "$gpd_app" ]]; then
    log "Found GPD desktop app: $gpd_app"
    remove_gpd_app=true
    found_anything=true
fi
if [[ -n "$deb_package" ]]; then
    log "Found GPD .deb package: $deb_package"
    found_anything=true
fi

# Per-OS GUI / cache dirs.
app_support_dirs_found=()
for d in "${app_support_dirs[@]}"; do
    if [[ -d "$d" ]]; then
        log "Found app data dir: $d"
        app_support_dirs_found+=("$d")
        found_anything=true
    fi
done

# auth.json with a "gpd" entry. Use $PY when available (avoids the
# /usr/bin/python3 stub-prompt issue on fresh macOS); fall back to grep
# when no usable python3 is around.
strip_auth_gpd=false
if [[ -f "$OPENCODE_AUTH" && -n "$PY" ]]; then
    if "$PY" -c "
import json, sys
try:
    with open('$OPENCODE_AUTH') as f:
        data = json.load(f)
    sys.exit(0 if isinstance(data, dict) and 'gpd' in data else 1)
except Exception:
    sys.exit(1)
" 2>/dev/null; then
        log "Found 'gpd' entry in $OPENCODE_AUTH"
        strip_auth_gpd=true
        found_anything=true
    fi
elif [[ -f "$OPENCODE_AUTH" ]] && grep -q '"gpd"' "$OPENCODE_AUTH" 2>/dev/null; then
    log "Found 'gpd' entry in $OPENCODE_AUTH"
    strip_auth_gpd=true
    found_anything=true
fi

# GPD-specific artifacts inside opencode's global config dir.
opencode_json_has_gpd=false
if [[ -f "$OPENCODE_CONFIG_DIR/opencode.json" ]] \
    && grep -q '"gpd"' "$OPENCODE_CONFIG_DIR/opencode.json" 2>/dev/null; then
    opencode_json_has_gpd=true
    log "Found GPD entry in: $OPENCODE_CONFIG_DIR/opencode.json"
    found_anything=true
fi
opencode_manifest_paths=()
for candidate in \
    "$OPENCODE_CONFIG_DIR/gpd-file-manifest.json" \
    "$OPENCODE_DATA_DIR/gpd-file-manifest.json"; do
    if [[ -f "$candidate" ]]; then
        opencode_manifest_paths+=("$candidate")
        log "Found GPD file manifest: $candidate"
        found_anything=true
    fi
done
if [[ -d "$opencode_gpd_subdir" ]]; then
    log "Found GPD subdir: $opencode_gpd_subdir"
    found_anything=true
fi

# Shell rc files / login profiles for the GPD sentinel block.
rc_and_profile_candidates=(
    "$HOME/.bashrc"
    "$HOME/.zshrc"
    "$HOME/.profile"
    "$HOME/.bash_profile"
    "$HOME/.zprofile"
    "${ZDOTDIR:-$HOME}/.zprofile"
    "$HOME/.config/fish/config.fish"
)
rc_files_with_block=()
seen_rc_disco=""
for rc in "${rc_and_profile_candidates[@]}"; do
    case "$seen_rc_disco" in *"|$rc|"*) continue ;; esac
    seen_rc_disco="$seen_rc_disco|$rc|"
    if [[ -f "$rc" ]] && grep -qF '# >>> GPD CLI >>>' "$rc" 2>/dev/null; then
        rc_files_with_block+=("$rc")
        log "Found GPD sentinel block in: $rc"
        found_anything=true
    fi
done

# LaTeX detection — do NOT remove, just report at the end.
latex_detected=false
latex_note=""
case "$os" in
    darwin)
        if command -v brew &>/dev/null; then
            if brew list --cask 2>/dev/null | grep -qx "basictex"; then
                latex_detected=true; latex_note="BasicTeX (Homebrew cask)"
            elif brew list --cask 2>/dev/null | grep -qx "mactex"; then
                latex_detected=true; latex_note="MacTeX (Homebrew cask)"
            elif brew list --cask 2>/dev/null | grep -qx "mactex-no-gui"; then
                latex_detected=true; latex_note="MacTeX-no-GUI (Homebrew cask)"
            fi
        fi
        if [[ "$latex_detected" == false ]]; then
            if [[ -d "/Library/TeX" ]] || compgen -G "/usr/local/texlive/*" > /dev/null 2>&1; then
                latex_detected=true
                latex_note="TeX installation at /Library/TeX or /usr/local/texlive/"
            fi
        fi
        ;;
    linux)
        if command -v dpkg &>/dev/null; then
            if dpkg -l 2>/dev/null | awk '$1 == "ii" && $2 ~ /^texlive-/' | grep -q .; then
                latex_detected=true
                latex_note="TeX Live packages (apt)"
            fi
        fi
        ;;
esac

if [[ "$found_anything" == false ]]; then
    printf " ${DIM}Nothing to remove — GPD does not appear to be installed.${RESET}\n\n"
    if [[ "$latex_detected" == true ]]; then
        printf " ${DIM}Note: $latex_note is installed but will not be touched.${RESET}\n\n"
    fi
    exit 0
fi

# ── Confirmation ──────────────────────────────────────────────────────────

printf "\n"
if [[ "$auto_yes" == false ]]; then
    printf " ${BOLD}Remove GPD and all its files?${RESET} [y/N] "
    read -r confirm
    if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
        printf " Cancelled.\n\n"
        exit 0
    fi
fi

printf "\n"

# ── Remove desktop app (macOS) / .deb (Linux) ───────────────────────────

if [[ "$remove_gpd_app" == true ]]; then
    log "Removing $gpd_app..."
    if rm -rf "$gpd_app" 2>/dev/null; then
        success "Removed $gpd_app"
    elif sudo rm -rf "$gpd_app" 2>/dev/null; then
        success "Removed $gpd_app (with sudo)"
    else
        warn "Failed to remove $gpd_app (try: sudo rm -rf '$gpd_app')"
    fi
fi
if [[ -n "$deb_package" ]]; then
    log "Removing GPD .deb package..."
    if sudo dpkg --remove "$deb_package" 2>/dev/null; then
        success "Removed .deb package: $deb_package"
    else
        warn "Failed to remove .deb package (try: sudo dpkg --remove $deb_package)"
    fi
fi

# ── Strip 'gpd' entry from opencode auth.json ────────────────────────────
# Done BEFORE removing $GPD_HOME so $PY (venv python) is still available.
# auth.json itself is preserved — surgically drop the "gpd" key so other
# providers' auth stays intact.

if [[ "$strip_auth_gpd" == true && -n "$PY" ]]; then
    rc=0
    "$PY" - "$OPENCODE_AUTH" <<'PYEOF' || rc=$?
import json, os, sys
path = sys.argv[1]
try:
    with open(path) as f:
        data = json.load(f)
    if not (isinstance(data, dict) and 'gpd' in data):
        sys.exit(2)
    del data['gpd']
    if not data:
        os.remove(path)
        sys.exit(1)
    with open(path, 'w') as f:
        json.dump(data, f, indent=2)
        f.write('\n')
    try:
        os.chmod(path, 0o600)
    except Exception:
        pass
    sys.exit(0)
except SystemExit:
    raise
except Exception as e:
    sys.stderr.write(str(e) + '\n')
    sys.exit(3)
PYEOF
    case $rc in
        0) success "Removed 'gpd' entry from $OPENCODE_AUTH (other providers preserved)" ;;
        1) success "Removed $OPENCODE_AUTH (only contained 'gpd' entry)" ;;
        2) skip "No 'gpd' entry in $OPENCODE_AUTH" ;;
        *) warn "Failed to strip 'gpd' entry from $OPENCODE_AUTH (exit $rc)" ;;
    esac
elif [[ "$strip_auth_gpd" == true ]]; then
    warn "No python3 available to surgically strip 'gpd' from $OPENCODE_AUTH"
    warn "  Please remove the \"gpd\" key manually to avoid touching other providers."
else
    skip "No 'gpd' entry in opencode auth.json"
fi

# ── Clean GPD bits from opencode.json (preserve the dir) ─────────────────

clean_opencode_json() {
    local file="$1"
    [[ -f "$file" ]] || { skip "No $file to clean"; return; }
    if [[ -z "$PY" ]]; then
        warn "python3 not available — cannot safely edit $file"
        warn "  Please manually remove \"gpd\" entries from $file"
        return
    fi
    local rc=0
    "$PY" - "$file" <<'PY' || rc=$?
import json, os, sys
path = sys.argv[1]
try:
    with open(path) as f:
        data = json.load(f)
except Exception:
    sys.exit(3)
if not isinstance(data, dict):
    sys.exit(2)
changed = False
provider = data.get("provider")
if isinstance(provider, dict) and "gpd" in provider:
    del provider["gpd"]
    changed = True
    if not provider:
        del data["provider"]
model = data.get("model")
if isinstance(model, str) and model.startswith("gpd/"):
    del data["model"]
    changed = True
enabled = data.get("enabled_providers")
if isinstance(enabled, list) and "gpd" in enabled:
    data["enabled_providers"] = [p for p in enabled if p != "gpd"]
    changed = True
    if not data["enabled_providers"]:
        del data["enabled_providers"]
if not changed:
    sys.exit(2)
if not data:
    os.remove(path)
    sys.exit(1)
with open(path, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
sys.exit(0)
PY
    case "$rc" in
        0) success "Cleaned GPD entries from $file (opencode config preserved)" ;;
        1) success "Removed $file (only contained GPD entries)" ;;
        2) skip "No GPD entries to clean from $file" ;;
        3) warn "Could not parse $file as JSON — leaving it alone" ;;
    esac
}

if [[ "$opencode_json_has_gpd" == true ]]; then
    clean_opencode_json "$OPENCODE_CONFIG_DIR/opencode.json"
else
    skip "No GPD entries in $OPENCODE_CONFIG_DIR/opencode.json"
fi

# ── Manifest-driven file removal ─────────────────────────────────────────
#
# gpd-file-manifest.json lists files the installer dropped into the
# opencode config dir. Accept either {"files": [...]} or a top-level
# array. Relative paths resolve against the manifest's parent dir.

# Guard against manifest path traversal. The manifest is authored by the
# installer but treated as untrusted input — a corrupted/malicious
# manifest with entries like "../../../.ssh/authorized_keys" or absolute
# paths outside the allowlist would let us delete arbitrary user files.
is_safe_manifest_path() {
    local target="$1"
    local allow_prefix="$2"
    case "$target" in
        *..*) return 1 ;;
    esac
    local resolved
    resolved="$(realpath -m -- "$target" 2>/dev/null || echo "$target")"
    local allow_resolved
    allow_resolved="$(realpath -m -- "$allow_prefix" 2>/dev/null || echo "$allow_prefix")"
    [[ "$resolved" == "$allow_resolved" || "$resolved" == "$allow_resolved"/* ]]
}

process_gpd_manifest() {
    local manifest="$1"
    local base_dir="$2"
    if [[ ! -f "$manifest" ]]; then
        # Fallback: a partial install (or a user who manually wiped
        # ~/.gpd) can leave GPD-managed files in $base_dir without a
        # manifest. Sweep the well-known managed paths from the gpd
        # runtime catalog (`flat_command_globs: ["command/gpd-*.md"]`
        # for opencode + the conventional agents/ + hooks/ patterns) so
        # a future fresh install isn't blocked by orphan markers.
        local swept=0
        for pat in "command/gpd-*.md" "agents/gpd-*.md" "hooks/gpd-*"; do
            local matched
            matched=$(find "$base_dir" -maxdepth 2 -path "$base_dir/$pat" -type f 2>/dev/null | wc -l | tr -d ' ')
            if [[ "$matched" != "0" ]]; then
                find "$base_dir" -maxdepth 2 -path "$base_dir/$pat" -type f -delete 2>/dev/null || true
                swept=$((swept + matched))
            fi
        done
        if (( swept > 0 )); then
            success "Removed $swept orphan GPD marker file(s) from $base_dir (no manifest)"
        else
            skip "No gpd-file-manifest.json to process"
        fi
        return
    fi

    if [[ -z "$PY" ]]; then
        warn "python3 not available — cannot parse $manifest; removing manifest only"
        rm -f "$manifest"
        return
    fi

    local files_list
    files_list="$("$PY" - "$manifest" "$base_dir" 2>/dev/null <<'PY' || true
import json, os, sys
manifest_path = sys.argv[1]
base_dir = sys.argv[2]
try:
    with open(manifest_path) as f:
        data = json.load(f)
except Exception:
    sys.exit(3)
if isinstance(data, dict):
    files = data.get("files", [])
elif isinstance(data, list):
    files = data
else:
    files = []
if not isinstance(files, list):
    files = []
for entry in files:
    if not isinstance(entry, str) or not entry:
        continue
    if "\n" in entry:
        sys.stderr.write(f"skipping entry with newline: {entry!r}\n")
        continue
    path = entry if os.path.isabs(entry) else os.path.join(base_dir, entry)
    sys.stdout.write(path + "\n")
sys.exit(0)
PY
)"

    if ! "$PY" - "$manifest" &>/dev/null <<'PY'
import json, sys
with open(sys.argv[1]) as f:
    json.load(f)
PY
    then
        warn "Could not parse $manifest — leaving listed files in place"
        rm -f "$manifest"
        success "Removed $manifest"
        return
    fi

    local -a allow_prefixes=("$base_dir" "$GPD_HOME")
    [[ -n "${OPENCODE_CONFIG_DIR:-}" ]] && allow_prefixes+=("$OPENCODE_CONFIG_DIR")

    local missing_count=0
    while IFS= read -r path; do
        [[ -z "$path" ]] && continue
        local safe=false
        for allow in "${allow_prefixes[@]}"; do
            if is_safe_manifest_path "$path" "$allow"; then
                safe=true
                break
            fi
        done
        if [[ "$safe" != true ]]; then
            warn "Refusing to remove manifest entry outside allowed dirs: $path"
            continue
        fi
        if [[ -e "$path" || -L "$path" ]]; then
            if rm -f "$path" 2>/dev/null; then
                success "Removed manifest file: $path"
            else
                warn "Could not remove manifest file: $path"
            fi
        else
            missing_count=$((missing_count+1))
        fi
    done <<< "$files_list"

    if [[ "$missing_count" -gt 0 ]]; then
        skip "$missing_count manifest entry(ies) already gone"
    fi

    rm -f "$manifest"
    success "Removed $manifest"
}

if (( ${#opencode_manifest_paths[@]} > 0 )); then
    for m in "${opencode_manifest_paths[@]}"; do
        process_gpd_manifest "$m" "$(dirname "$m")"
    done
else
    process_gpd_manifest "$OPENCODE_CONFIG_DIR/gpd-file-manifest.json" "$OPENCODE_CONFIG_DIR"
fi

if [[ -d "$opencode_gpd_subdir" ]]; then
    rm -rf "$opencode_gpd_subdir"
    success "Removed $opencode_gpd_subdir"
fi

# ── Remove PATH entries / exports from shell rc files ────────────────────
#
# Sentinel-span removal: drop exactly the block bracketed by
#   # >>> GPD CLI >>>
#   ...
#   # <<< GPD CLI <<<
# No substring fallback — the old behaviour silently deleted any line
# mentioning "$GPD_BIN_DIR" or "GPD_API_KEY", which could mangle user
# lines that coincidentally referenced those strings.

remove_gpd_block() {
    local file="$1"
    [[ -f "$file" ]] || return 1
    if ! grep -qF '# >>> GPD CLI >>>' "$file" 2>/dev/null; then
        return 1
    fi

    # Protect against a user-edited rc where the CLOSER was deleted: if
    # open/close counts disagree, awk's skip flag would stay on and the
    # rest of the file past the opener would be dropped. Count both on
    # input that has been CR-stripped so CRLF-terminated dotfiles (common
    # with dotfile sync or Windows editors) don't throw off the regex.
    local opens closes
    opens="$(tr -d '\r' < "$file" | grep -cE '^# >>> GPD CLI >>>[[:space:]]*$' || true)"
    closes="$(tr -d '\r' < "$file" | grep -cE '^# <<< GPD CLI <<<[[:space:]]*$' || true)"
    if [[ "$opens" != "$closes" ]]; then
        warn "Unbalanced GPD sentinel markers in $file (open=$opens, close=$closes) — skipping to avoid destroying file contents"
        return 1
    fi

    local tmp
    tmp="$(mktemp)"
    if ! tr -d '\r' < "$file" | awk '
        /^# >>> GPD CLI >>>[[:space:]]*$/ { skip=1; next }
        /^# <<< GPD CLI <<<[[:space:]]*$/ { skip=0; next }
        skip == 0 { print }
    ' > "$tmp"; then
        rm -f "$tmp"
        return 1
    fi
    if ! diff -q "$file" "$tmp" &>/dev/null; then
        mv "$tmp" "$file"
        return 0
    else
        rm -f "$tmp"
        return 1
    fi
}

if (( ${#rc_files_with_block[@]} > 0 )); then
    removed_any_block=false
    for rc in "${rc_files_with_block[@]}"; do
        if remove_gpd_block "$rc"; then
            success "Removed GPD block from $rc"
            removed_any_block=true
        fi
    done
    if [[ "$removed_any_block" != true ]]; then
        skip "No GPD sentinel blocks found in shell rc/profile files"
    fi
else
    skip "No shell rc/profile files to clean"
fi

# ── Remove GPD directory ─────────────────────────────────────────────────
# NOTE: this wipes $PY, so everything that needs python3 must run above.

if [[ -d "$GPD_HOME" ]]; then
    rm -rf "$GPD_HOME"
    success "Removed $GPD_HOME"
else
    skip "$GPD_HOME already removed"
fi

# ── Remove platform-specific GUI / cache dirs ────────────────────────────

for d in "${app_support_dirs[@]}"; do
    if [[ -d "$d" ]]; then
        rm -rf "$d"
        success "Removed $d"
    else
        skip "No $d to remove"
    fi
done

# ── Done ──────────────────────────────────────────────────────────────────

printf "\n"
printf " ${GREEN}${BOLD}GPD has been uninstalled.${RESET}\n"
printf " ${DIM}Open a new terminal to clear any cached PATH entries.${RESET}\n"

if [[ "$latex_detected" == true ]]; then
    printf "\n"
    printf " ${YELLOW}Manual cleanup:${RESET} $latex_note was installed by the GPD installer\n"
    printf " but is left in place because many other apps may depend on it.\n"
    case "$os" in
        darwin)
            printf " To remove it yourself:\n"
            printf "   ${DIM}brew uninstall --cask basictex${RESET}   ${DIM}# or mactex / mactex-no-gui${RESET}\n"
            ;;
        linux)
            printf " To remove it yourself:\n"
            printf "   ${DIM}sudo apt remove texlive-latex-base texlive-binaries latexmk${RESET}\n"
            ;;
    esac
fi

printf "\n"
