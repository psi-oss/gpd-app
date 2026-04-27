#!/usr/bin/env bash
# GPD — Get Physics Done: uninstaller
#
# Usage:
#   bash uninstall.sh
#   bash uninstall.sh --yes    # skip confirmation prompt
#
# Removes everything created by the GPD installer:
#   - ~/.gpd/ directory (bin, config, python, venv)
#   - PATH entries from shell rc files
#   - GPD_API_KEY exports from login profiles
#   - GPD .deb package (Ubuntu, if installed)
#   - "gpd" provider entry from opencode's auth.json
#   - GUI config dirs (~/.config/gpd, ~/.config/inc.psi.gpd)
#   - GPD-specific entries inside ~/.config/opencode/ (preserves opencode itself)

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

# ── Arguments ─────────────────────────────────────────────────────────────

auto_yes=false
while [[ $# -gt 0 ]]; do
    case "$1" in
        -y|--yes) auto_yes=true; shift ;;
        -h|--help)
            printf "Usage: uninstall.sh [--yes]\n"
            printf "  --yes, -y   Skip confirmation prompt\n"
            exit 0
            ;;
        *) shift ;;
    esac
done

# ── Configuration ─────────────────────────────────────────────────────────

GPD_HOME="${GPD_HOME:-$HOME/.gpd}"
GPD_BIN_DIR="$GPD_HOME/bin"

# auth.json lives under XDG_DATA_HOME (Linux) or ~/Library/Application Support (macOS).
# The installer writes all three on the respective platforms; check all of them
# so we clean up correctly even if XDG_DATA_HOME was set at install time but
# not now (or vice versa).
auth_json_candidates=()
if [[ -n "${XDG_DATA_HOME:-}" ]]; then
    auth_json_candidates+=("$XDG_DATA_HOME/opencode/auth.json")
fi
auth_json_candidates+=("$HOME/.local/share/opencode/auth.json")
auth_json_candidates+=("$HOME/Library/Application Support/opencode/auth.json")

# GUI config directories (full app state — safe to remove entirely).
# Also includes the Tauri WebView data dirs under ~/.local/share and
# ~/.cache where the browser localStorage (incl. "gpd.key.saved" flag),
# cookies, IndexedDB, and cache live. Without these, a fresh install
# would inherit the previous user's key prompt state. macOS paths are
# covered by the macOS uninstaller (uninstall_macos.sh); here we handle
# Linux XDG layout.
gui_config_dirs=(
    "$HOME/.config/gpd"
    "$HOME/.config/inc.psi.gpd"
    "$HOME/.local/share/inc.psi.gpd"
    "$HOME/.cache/inc.psi.gpd"
)

# opencode's global config dir — we NEVER rm -rf this. Users commonly
# have opencode installed for other providers (anthropic, openai, etc.);
# wiping the dir would destroy their auth.json, chat history, and custom
# prompts. Instead we do surgical cleanup:
#   - strip the "gpd" entry from auth.json
#   - strip the "gpd" provider from opencode.json
#   - delete files listed in gpd-file-manifest.json
#   - delete the manifest itself
#   - delete $opencode_config_dir/get-physics-done/ if it's empty after
#     the manifest sweep
# Any non-GPD opencode data (other providers' auth, opencode.db session
# logs under XDG_STATE_HOME, caches) is left strictly alone.
opencode_config_dir="$HOME/.config/opencode"

# ── Discovery: show what will be removed ──────────────────────────────────

printf "\n"
printf "${BOLD} GPD Uninstaller${RESET}\n"
printf "\n"

found_anything=false

if [[ -d "$GPD_HOME" ]]; then
    log "Found GPD directory: $GPD_HOME"
    found_anything=true
fi

# Check for .deb package (Ubuntu/Debian)
deb_package=""
if command -v dpkg &>/dev/null; then
    if dpkg -l gpd 2>/dev/null | grep -q "^ii"; then
        deb_package="gpd"
        log "Found GPD .deb package: $deb_package"
        found_anything=true
    fi
fi

# Check shell rc files and login profiles for the GPD sentinel block.
# A single pass covers both the PATH export and the GPD_API_KEY export
# since the installer wraps them in one `# >>> GPD CLI >>>` block.
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

# Check for auth.json files containing a "gpd" provider entry
auth_json_files=()
seen_auth=""
for candidate in "${auth_json_candidates[@]}"; do
    # de-dupe (XDG_DATA_HOME may resolve to the same path)
    case "$seen_auth" in *"|$candidate|"*) continue ;; esac
    seen_auth="$seen_auth|$candidate|"
    if [[ -f "$candidate" ]] && grep -q '"gpd"' "$candidate" 2>/dev/null; then
        auth_json_files+=("$candidate")
        log "Found auth.json at: $candidate"
        found_anything=true
    fi
done

# Check for GUI config directories
gui_dirs_found=()
for d in "${gui_config_dirs[@]}"; do
    if [[ -d "$d" ]]; then
        gui_dirs_found+=("$d")
        log "Found GUI config directory: $d"
        found_anything=true
    fi
done

# Check for GPD-specific artifacts inside opencode's global config
opencode_json_has_gpd=false
opencode_manifest=""
if [[ -f "$opencode_config_dir/opencode.json" ]] && grep -q '"gpd"' "$opencode_config_dir/opencode.json" 2>/dev/null; then
    opencode_json_has_gpd=true
    log "Found GPD entry in: $opencode_config_dir/opencode.json"
    found_anything=true
fi
if [[ -f "$opencode_config_dir/gpd-file-manifest.json" ]]; then
    opencode_manifest="$opencode_config_dir/gpd-file-manifest.json"
    log "Found GPD file manifest: $opencode_manifest"
    found_anything=true
fi

# get-physics-done/ subdir — populated by `gpd install opencode --global`.
# We remove it after the manifest sweep (AC-9) so files dropped there by
# GPD are cleaned up, but we do NOT use its existence as license to wipe
# the rest of opencode's config.
opencode_gpd_subdir="$opencode_config_dir/get-physics-done"
if [[ -d "$opencode_gpd_subdir" ]]; then
    log "Found GPD subdir: $opencode_gpd_subdir"
    found_anything=true
fi

if [[ "$found_anything" == false ]]; then
    printf " ${DIM}Nothing to remove — GPD does not appear to be installed.${RESET}\n\n"
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

# ── Remove .deb package ──────────────────────────────────────────────────

if [[ -n "$deb_package" ]]; then
    log "Removing GPD .deb package..."
    if sudo dpkg --remove "$deb_package" 2>/dev/null; then
        success "Removed .deb package: $deb_package"
    else
        warn "Failed to remove .deb package (may need manual: sudo dpkg --remove $deb_package)"
    fi
else
    skip "No .deb package installed"
fi

# ── Remove PATH entries / exports from shell rc files ────────────────────
#
# Sentinel-span removal: the installer writes a block bracketed by
#   # >>> GPD CLI >>>
#   ...
#   # <<< GPD CLI <<<
# We drop exactly that block. If the sentinels aren't found, we do
# nothing (no substring fallback — the old behaviour silently deleted
# any line mentioning "$GPD_BIN_DIR" or "GPD_API_KEY", which could
# mangle unrelated user-authored lines).

remove_gpd_block() {
    local file="$1"
    [[ -f "$file" ]] || return 1

    # Bail early if the open sentinel isn't present — no block to remove.
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
    # awk skips lines from the opening sentinel through the closing one
    # (inclusive). Input is piped through tr -d '\r' so CRLF line endings
    # still match the regex. Trailing whitespace on the sentinel line is
    # tolerated so dotfile editors that auto-trim / re-add spaces don't
    # turn the strip into a silent no-op.
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

# ── Remove "gpd" entry from auth.json (preserve other providers) ──────────

remove_gpd_from_auth_json() {
    local file="$1"

    if command -v python3 &>/dev/null; then
        # Use python to drop just the "gpd" key; delete the file entirely if
        # nothing else remains. Exit codes:
        #   0  removed gpd entry, file still has other providers
        #   1  removed gpd entry, file was empty afterwards (deleted)
        #   2  no gpd entry present, nothing to do
        #   3  JSON parse error — caller should fall back
        #
        # NOTE: `set -e` aborts on any non-zero exit of a simple command, so
        # we must capture the python exit code via `|| rc=$?` rather than
        # reading $? on the next line (which would never execute).
        local rc=0
        python3 - "$file" <<'PY' || rc=$?
import json, os, sys
path = sys.argv[1]
try:
    with open(path) as f:
        data = json.load(f)
except Exception:
    sys.exit(3)
if not isinstance(data, dict) or "gpd" not in data:
    sys.exit(2)
del data["gpd"]
if not data:
    os.remove(path)
    sys.exit(1)
with open(path, "w") as f:
    json.dump(data, f, indent=2)
os.chmod(path, 0o600)
sys.exit(0)
PY
        case "$rc" in
            0) success "Removed 'gpd' entry from $file (other providers preserved)" ;;
            1) success "Removed $file (only contained 'gpd' entry)" ;;
            2) skip "No 'gpd' entry in $file" ;;
            3)
                warn "Could not parse $file as JSON — removing it entirely"
                rm -f "$file"
                ;;
        esac
    else
        # No python3 available. We detected a "gpd" entry, but we can't safely
        # edit JSON with pure bash. If the file contains other provider keys,
        # warn before removing. Otherwise just remove it.
        local other_providers
        # crude: count top-level quoted keys other than "gpd"
        other_providers=$(grep -oE '"[A-Za-z0-9_-]+"[[:space:]]*:' "$file" 2>/dev/null \
            | grep -v '^"gpd"' | head -1 || true)
        if [[ -n "$other_providers" ]]; then
            warn "python3 not available and $file has other providers — removing whole file anyway"
            warn "  You may need to re-authenticate other providers in opencode"
        fi
        rm -f "$file"
        success "Removed $file"
    fi
}

if (( ${#auth_json_files[@]} > 0 )); then
    for f in "${auth_json_files[@]}"; do
        remove_gpd_from_auth_json "$f"
    done
else
    skip "No auth.json with 'gpd' entry to clean up"
fi

# ── Remove GUI config directories ─────────────────────────────────────────

if (( ${#gui_dirs_found[@]} > 0 )); then
    for d in "${gui_dirs_found[@]}"; do
        rm -rf "$d"
        success "Removed GUI config directory: $d"
    done
else
    skip "No GUI config directories to remove"
fi

# ── Clean GPD bits from opencode's global config (preserve the dir) ───────
#
# AC-10: strip `provider.gpd` from opencode.json. If `provider` becomes
# empty after that, drop the key. If the resulting object is equivalent
# to `{}`, delete the file. Non-JSON files are left alone with a warning.
#
# We also drop a top-level `model` that points at `gpd/*` and remove
# `gpd` from `enabled_providers` — these were written by the installer
# and are dead references once the provider is gone.

clean_opencode_json() {
    local file="$1"

    if command -v python3 &>/dev/null; then
        # NOTE: same `set -e` caveat as remove_gpd_from_auth_json — capture
        # the python exit code via `|| rc=$?` so non-zero "signal" exits
        # (1/2/3/4) don't abort the whole uninstaller.
        #
        # Exit codes:
        #   0  modified, file still has other content
        #   1  modified, file reduced to {} and was deleted
        #   2  nothing to change
        #   3  JSON parse error — caller warns
        local rc=0
        python3 - "$file" <<'PY' || rc=$?
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
# Drop the "gpd" provider entry
provider = data.get("provider")
if isinstance(provider, dict) and "gpd" in provider:
    del provider["gpd"]
    changed = True
    if not provider:
        del data["provider"]
# Clear default model if it points at gpd/*
model = data.get("model")
if isinstance(model, str) and model.startswith("gpd/"):
    del data["model"]
    changed = True
# Remove "gpd" from enabled_providers (or drop the key if empty)
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
    else
        warn "python3 not available — cannot safely edit $file"
        warn "  Please manually remove \"gpd\" entries from $file"
    fi
}

# ── AC-9: manifest-driven file removal ───────────────────────────────────
#
# gpd-file-manifest.json lists files the installer dropped into the
# opencode config dir (templates, commands, agents, etc.). We iterate
# the list and remove each file, then delete the manifest itself.
# Accepted manifest shapes:
#   {"files": ["path/a.md", "path/b.md", ...]}
#   ["path/a.md", "path/b.md", ...]
# Relative paths are resolved against $opencode_config_dir.

# Guard against manifest path traversal. The manifest is authored by the
# installer but we treat it as untrusted input — a corrupted/malicious
# manifest with entries like "../../../.ssh/authorized_keys" or absolute
# paths outside the allowlist would let us delete arbitrary user files.
# Resolves both the candidate and its allowed prefix via realpath -m
# (accepts non-existent targets so we can still reject them) and requires
# the resolved target to live under the prefix. `..` segments are refused
# up-front.
is_safe_manifest_path() {
    local target="$1"
    local allow_prefix="$2"
    # Reject any `..` segment in the raw path.
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
        # for opencode, plus the conventional agents/ + hooks/ patterns)
        # so a future fresh install isn't blocked by orphan markers.
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

    if ! command -v python3 &>/dev/null; then
        warn "python3 not available — cannot parse $manifest; removing manifest only"
        rm -f "$manifest"
        return
    fi

    # Python prints each absolute path on its own line. Paths containing
    # newlines are skipped with a stderr warning (bash's command
    # substitution can't carry NUL bytes, so newline is the separator).
    # In practice every path GPD's installer writes is ASCII-clean.
    local rc=0
    local files_list
    files_list="$(python3 - "$manifest" "$base_dir" 2>/dev/null <<'PY' || true
import json, os, sys
manifest_path = sys.argv[1]
base_dir = sys.argv[2]
try:
    with open(manifest_path) as f:
        data = json.load(f)
except Exception as e:
    sys.stderr.write(f"parse error: {e}\n")
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

    # Parse error detection — python prints nothing on parse failure AND
    # exits non-zero. We piped stderr to /dev/null so check for the
    # presence of a real file list. A separate dry-run parse attempts to
    # distinguish "empty manifest" (valid) from "unparseable" (warn).
    if ! python3 - "$manifest" &>/dev/null <<'PY'
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

    # Allowlist: every manifest entry must resolve to a path inside one
    # of these prefixes. Anything outside is treated as a manifest-traversal
    # attack (or a legitimate but dangerous manifest we won't honor) and
    # gets skipped with a warning.
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

process_gpd_manifest "$opencode_config_dir/gpd-file-manifest.json" "$opencode_config_dir"

if [[ "$opencode_json_has_gpd" == true ]]; then
    clean_opencode_json "$opencode_config_dir/opencode.json"
else
    skip "No GPD entries in opencode's global config"
fi

# Clean up get-physics-done/ subdir. The earlier "remove only if empty
# after manifest sweep" heuristic was wrong — `gpd install opencode
# --global` writes files (agents, commands, runtime-config) into this
# subdir that aren't always recorded in gpd-file-manifest.json (manifest
# tracking was added in a later release; pre-manifest installs leave
# orphans here forever). The dir is named after the package and is
# wholly GPD-owned; remove unconditionally. If the user customised
# templates here, they should back them up before uninstalling.
#
# The bug this fixed: re-running the installer against a stale
# get-physics-done/ dir tripped gpd 1.2.x's preflight with
# "untrusted GPD manifest" because the new install didn't recognise
# the old install's signature. Removing the dir on uninstall makes the
# next install see a clean target.
if [[ -d "$opencode_gpd_subdir" ]]; then
    rm -rf "$opencode_gpd_subdir"
    success "Removed $opencode_gpd_subdir"
fi

# ── Remove GPD directory ─────────────────────────────────────────────────

if [[ -d "$GPD_HOME" ]]; then
    rm -rf "$GPD_HOME"
    success "Removed $GPD_HOME"
else
    skip "$GPD_HOME already removed"
fi

# ── Done ──────────────────────────────────────────────────────────────────

printf "\n"
printf " ${GREEN}${BOLD}GPD has been uninstalled.${RESET}\n"
printf " ${DIM}Open a new terminal to clear any cached PATH entries.${RESET}\n"
printf "\n"
printf " ${BOLD}Note:${RESET} the following system packages were ${BOLD}not${RESET} removed,\n"
printf " since other applications on your machine may depend on them:\n"
printf "   ${DIM}- LaTeX tools: texlive-latex-base, texlive-binaries, latexmk${RESET}\n"
printf "   ${DIM}- git${RESET}\n"
printf " If you want to remove LaTeX, run:\n"
printf "   ${BOLD}sudo apt remove texlive-latex-base texlive-binaries latexmk${RESET}\n"
printf "\n"
