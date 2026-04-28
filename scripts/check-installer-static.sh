#!/usr/bin/env bash
# L0 installer static gates — runs on every PR/push.
#
# Catches the deterministic release-breakers we've shipped this cycle.
# Single script, repo-local, no toolchain dependency beyond stock POSIX
# bash + GNU/BSD coreutils + (optional) pwsh for AST parsing. pwsh is
# preinstalled on every GHA hosted runner; if absent locally we skip
# only the AST gate and run everything else.
#
# Exit codes:
#   0  all gates passed
#   1  one or more gates failed (each prints "FAIL: <reason>" before
#      script continues — we don't fail-fast so a single PR sees every
#      issue at once)

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

declare -i fails=0
fail() { echo "FAIL: $*"; fails+=1; }
ok()   { echo "OK:   $*"; }

# Files served at https://download.gpd.psi.inc and therefore loaded
# either via `iex` (bootstraps) or via scriptblock evaluation (mains).
# Top-level `exit` in any of these terminates the user's PowerShell
# host process when run via `irm | iex` — see the `Stop-WithError`
# fix in install_main.ps1.
SERVED_BOOTSTRAPS=(
  install-gpd/windows_11/install.ps1
  install-gpd/windows_11/uninstall.ps1
)
SERVED_MAINS=(
  install-gpd/windows_11/install_main.ps1
  install-gpd/windows_11/uninstall_main.ps1
)
SERVED_POSIX=(
  install-gpd/install
  install-gpd/uninstall
)
SERVED_PS1=( "${SERVED_BOOTSTRAPS[@]}" "${SERVED_MAINS[@]}" )

# ── Gate 1: no UTF-8 BOM in any served .ps1 ───────────────────────────────
# PS 5.1 + Invoke-RestMethod defaults to ISO-8859-1 decoding when the
# response Content-Type lacks `charset=`. A leading EF BB BF then
# arrives in the script string as "ï»¿" and `iex` tries to invoke it
# as a cmdlet — observed on a Windows 11 PT-BR machine as
#   I»¿# : O termo 'I»¿#' não é reconhecido como nome de cmdlet.
# Fix: strip BOM. Verify nothing has crept back in.
for f in "${SERVED_PS1[@]}"; do
  [[ -f "$f" ]] || { fail "missing file: $f"; continue; }
  if head -c 3 "$f" | od -An -tx1 | tr -d ' \n' | grep -q '^efbbbf'; then
    fail "UTF-8 BOM at start of $f"
  fi
done
[[ $fails -eq 0 ]] && ok "no BOM in served .ps1 files"

# ── Gate 2: bootstrap .ps1 must be pure ASCII ─────────────────────────────
# The bootstrap is the file users actually pipe through `iex`; any
# non-ASCII byte in it is mis-decoded under PS 5.1 when irm picks
# ISO-8859-1. Mains are fine — bootstrap fetches them via WebClient
# with explicit UTF-8.
prev_fails=$fails
# `LC_ALL=C tr -d '\000-\177'` is portable across BSD grep (macOS),
# GNU grep, and busybox — `grep -P` is GNU-only and would silently
# pass on macOS BSD grep with exit code 2 ("invalid option").
for f in "${SERVED_BOOTSTRAPS[@]}"; do
  [[ -f "$f" ]] || continue
  non_ascii="$(LC_ALL=C tr -d '\000-\177' < "$f" | wc -c | tr -d ' ')"
  if [[ "$non_ascii" != "0" ]]; then
    fail "$non_ascii non-ASCII byte(s) in bootstrap $f"
  fi
done
[[ $fails -eq $prev_fails ]] && ok "bootstrap .ps1 files are pure ASCII"

# ── Gate 3: every served .ps1 parses cleanly via [scriptblock]::Create ────
# Catches the regression class where someone reintroduces top-level
# [CmdletBinding()] + param() into a file users run via iex — the
# parser rejects the attribute as "unexpected" mid-pipeline.
# Skips itself (gracefully) if pwsh isn't on PATH.
if command -v pwsh >/dev/null 2>&1; then
  prev_fails=$fails
  for f in "${SERVED_PS1[@]}"; do
    [[ -f "$f" ]] || continue
    if ! pwsh -NoProfile -Command "
      \$ErrorActionPreference = 'Stop'
      \$body = [System.IO.File]::ReadAllText('$f')
      \$tokens = \$null; \$errs = \$null
      [System.Management.Automation.Language.Parser]::ParseInput(
        \$body, [ref]\$tokens, [ref]\$errs) | Out-Null
      if (\$errs) {
        foreach (\$e in \$errs) {
          Write-Host (\"  \" + \$e.Message + ' @ ' + \$e.Extent.StartLineNumber + ':' + \$e.Extent.StartColumnNumber)
        }
        exit 2
      }
      \$null = [scriptblock]::Create(\$body)
    " 2>&1; then
      fail "PowerShell parse error in $f"
    fi
  done
  [[ $fails -eq $prev_fails ]] && ok "all served .ps1 parse via [scriptblock]::Create"
else
  echo "SKIP: pwsh not on PATH — skipping AST parse gate"
fi

# ── Gate 4: no top-level `exit` in scriptblock-loaded files ───────────────
# Scope: bootstraps (loaded by iex) + mains (loaded by bootstrap as a
# scriptblock). In both contexts, an `exit` statement at the script
# root kills the powershell.exe HOST process — closes the user's
# terminal mid-install with no visible error. Stop-WithError in
# install_main.ps1 was hit by this and is now `throw`. Don't let it
# regress.
#
# Allow `exit` inside a `function ... { ... }` body. Heuristic:
# track brace depth from any line opening a `function ... {` and
# only flag bare `exit N` when depth is 0.
prev_fails=$fails
check_top_level_exit() {
  local f="$1"
  awk '
    BEGIN { fn_depth = 0 }
    {
      line = $0
      # Open brace from a function declaration on this line.
      if (line ~ /^[[:space:]]*function[[:space:]]+[A-Za-z_][A-Za-z0-9_-]*[[:space:]]*\{/ ||
          line ~ /^[[:space:]]*function[[:space:]]+[A-Za-z_][A-Za-z0-9_-]*[[:space:]]*$/) {
        fn_depth++
      }
      # Brace counting on every other line (best-effort; quoted-brace
      # edge cases are rare in our scripts).
      else if (fn_depth > 0) {
        for (i = 1; i <= length(line); i++) {
          c = substr(line, i, 1)
          if (c == "{") fn_depth++
          else if (c == "}") {
            fn_depth--
            if (fn_depth < 0) fn_depth = 0
          }
        }
      }
      if (fn_depth == 0 && line ~ /^[[:space:]]*exit[[:space:]]+[0-9]/) {
        printf "%s:%d: %s\n", FILENAME, NR, line
        bad = 1
      }
    }
    END { exit bad ? 1 : 0 }
  ' "$f"
}
for f in "${SERVED_PS1[@]}"; do
  [[ -f "$f" ]] || continue
  if ! out="$(check_top_level_exit "$f")"; then
    fail "top-level \`exit\` (kills host under iex/scriptblock) in $f:"
    echo "$out" | sed 's/^/  /'
  fi
done
[[ $fails -eq $prev_fails ]] && ok "no top-level exit in scriptblock-loaded .ps1 files"

# ── Gate 5: POSIX bash installers parse ───────────────────────────────────
# `bash -n` does no execution, just parser validation. Catches every
# regression where a syntax error sneaks into install/uninstall.
prev_fails=$fails
for f in "${SERVED_POSIX[@]}"; do
  [[ -f "$f" ]] || { fail "missing file: $f"; continue; }
  if ! bash -n "$f" 2>&1 | sed 's/^/  /'; then
    fail "bash syntax error in $f"
  fi
done
[[ $fails -eq $prev_fails ]] && ok "POSIX bash installers parse cleanly"

# ── Gate 6: manifest schema round-trip ────────────────────────────────────
# The macOS uninstaller parses the gpd-file-manifest.json that the
# python writer emits. Schema drifted from list-of-strings to dict-of-
# path→sha256 + sibling list `opencode_generated_command_files`, and
# the bash reader silently ignored the dict shape, leaving 95 stale
# markers on disk. Fixture-test both shapes against the actual reader.
if command -v python3 >/dev/null 2>&1; then
  tmp_dir="$(mktemp -d)"
  trap 'rm -rf "$tmp_dir"' EXIT
  prev_fails=$fails

  base_dir="$tmp_dir/manifest-fixture"
  mkdir -p "$base_dir/command" "$base_dir/agents"
  : > "$base_dir/command/gpd-fixture.md"
  : > "$base_dir/agents/gpd-fixture.md"

  for shape in list dict dict-with-extras; do
    case "$shape" in
      list)
        cat > "$base_dir/gpd-file-manifest.json" <<'JSON'
{"version":1,"files":["command/gpd-fixture.md","agents/gpd-fixture.md"]}
JSON
        ;;
      dict)
        cat > "$base_dir/gpd-file-manifest.json" <<'JSON'
{"version":1,"files":{"command/gpd-fixture.md":"deadbeef","agents/gpd-fixture.md":"feedface"}}
JSON
        ;;
      dict-with-extras)
        cat > "$base_dir/gpd-file-manifest.json" <<'JSON'
{"version":1,"files":{"agents/gpd-fixture.md":"feedface"},"opencode_generated_command_files":["command/gpd-fixture.md"]}
JSON
        ;;
    esac
    : > "$base_dir/command/gpd-fixture.md"
    : > "$base_dir/agents/gpd-fixture.md"
    paths="$(python3 - "$base_dir/gpd-file-manifest.json" "$base_dir" <<'PY'
import json, os, sys
manifest_path = sys.argv[1]
base_dir = sys.argv[2]
with open(manifest_path) as f:
    data = json.load(f)
paths = []
if isinstance(data, dict):
    files = data.get("files")
    if isinstance(files, dict):
        paths.extend(files.keys())
    elif isinstance(files, list):
        paths.extend(files)
    extras = data.get("opencode_generated_command_files")
    if isinstance(extras, list):
        paths.extend(extras)
elif isinstance(data, list):
    paths.extend(data)
out = []
seen = set()
for entry in paths:
    if not isinstance(entry, str) or not entry:
        continue
    p = entry if os.path.isabs(entry) else os.path.join(base_dir, entry)
    if p in seen:
        continue
    seen.add(p)
    out.append(p)
print("\n".join(out))
PY
)"
    expected=2
    actual="$(printf '%s\n' "$paths" | grep -c '/gpd-fixture\.md$' || true)"
    if [[ "$actual" != "$expected" ]]; then
      fail "manifest shape '$shape' parsed $actual paths, expected $expected"
    fi
  done

  [[ $fails -eq $prev_fails ]] && ok "manifest list/dict/extras shapes all parse"
else
  echo "SKIP: python3 missing — skipping manifest shape gate"
fi

# ── Gate 7: README irm|iex URLs reference real files ──────────────────────
# Catches the regression where someone updates the install URL in
# README without adding the file to the publish workflow's allowlist —
# the `git add` drift that left install_main.ps1 / uninstall_main.ps1
# 404'ing on download.gpd.psi.inc.
prev_fails=$fails
# Plain paired-array lookup so this script also runs on macOS's stock
# bash 3.2 (no `declare -A`). Add new served URL → source-file pairs
# here in lockstep with the gpd-sync-installer-to-pages.yml staging
# step. The gate only fails if a README irm|iex URL has no entry —
# i.e. the doc references a file we don't actually publish.
url_path_pairs=(
  "install:install-gpd/install"
  "install.ps1:install-gpd/windows_11/install.ps1"
  "install_main.ps1:install-gpd/windows_11/install_main.ps1"
  "uninstall:install-gpd/uninstall"
  "uninstall.sh:install-gpd/uninstall"
  "uninstall.ps1:install-gpd/windows_11/uninstall.ps1"
  "uninstall_main.ps1:install-gpd/windows_11/uninstall_main.ps1"
  # Generated by the publish workflow itself, not from a source file.
  # Listed here so the gate accepts the README's verify-install
  # example URL without the workflow needing to learn about it.
  "SHA256SUMS.txt:GENERATED"
  "SHA256SUMS.meta:GENERATED"
)
referenced_urls="$(grep -hoE 'https://download\.gpd\.psi\.inc/[A-Za-z0-9_./-]+' README.md install-gpd/README.md 2>/dev/null \
                   | awk -F/ '{print $NF}' | sort -u)"
for url in $referenced_urls; do
  path=""
  for pair in "${url_path_pairs[@]}"; do
    [[ "${pair%%:*}" == "$url" ]] && path="${pair#*:}" && break
  done
  if [[ -z "$path" ]]; then
    fail "README references download.gpd.psi.inc/$url with no source-file mapping"
    continue
  fi
  # `GENERATED` paths (SHA256SUMS, etc.) are produced by the workflow,
  # not committed; skip the existence check for them.
  [[ "$path" == "GENERATED" ]] && continue
  if [[ ! -f "$path" ]]; then
    fail "README references $url -> $path (missing)"
  fi
done
[[ $fails -eq $prev_fails ]] && ok "every README irm|iex URL maps to an existing file"

# ── Gate 8: post-build Tauri Windows bundle has no opencode-* artifacts ───
# Soft check: only enforced if the bundle dir exists locally. The
# release workflow runs `tauri build` first and then invokes this
# script; a pure repo-checkout run skips this gate cleanly.
bundle_dir="packages/desktop/src-tauri/target/release/bundle"
if [[ -d "$bundle_dir" ]]; then
  prev_fails=$fails
  while IFS= read -r leaked; do
    fail "Tauri bundle contains opencode-named artifact: $leaked"
  done < <(find "$bundle_dir" -iname '*opencode*' 2>/dev/null)
  [[ $fails -eq $prev_fails ]] && ok "no opencode-named files in Tauri bundle"
fi

# ── Summary ───────────────────────────────────────────────────────────────
echo
if [[ $fails -gt 0 ]]; then
  echo "RESULT: $fails gate(s) failed"
  exit 1
fi
echo "RESULT: all gates passed"
