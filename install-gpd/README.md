# GPD Installers

Installers that set up GPD (Get Physics Done) — desktop app + CLI + Python
runtime + LaTeX — on Ubuntu, macOS, and Windows. Nothing else is required;
each installer handles every dependency.

## Quick Start

Installer scripts are served from `download.gpd.psi.inc`, a PSI-owned
GitHub Pages domain backed by the `gh-pages` branch. Every push to
`gpd` that touches these scripts republishes them and regenerates a
signed-by-Pages `SHA256SUMS.txt` manifest at
<https://download.gpd.psi.inc/SHA256SUMS.txt> so users can verify the
content they're about to execute against a hash under PSI's DNS.

### Ubuntu / macOS (recommended)

```bash
curl -fsSL https://download.gpd.psi.inc/install | bash
```

Stdin is the curl pipe rather than the terminal, so the install-time
PSI-key prompt is skipped — the key gets entered through the desktop
app's welcome screen on first launch instead, which is the expected
GPD flow. On **Ubuntu** this installs the GPD desktop `.deb` (GUI +
CLI); on **other Linux** and **macOS** it installs the standalone CLI.

`sudo` is invoked only on Ubuntu (for `apt-get install -y` of git +
LaTeX + the `.deb`). Re-running the installer is idempotent.

If you want to enter the PSI key at install time (rare; CI / scripted
onboarding only), preset the env var:
```bash
curl -fsSL https://download.gpd.psi.inc/install | GPD_API_KEY=sk-... bash
```

Or use process substitution to keep an interactive prompt connected to
your terminal:
```bash
bash <(curl -fsSL https://download.gpd.psi.inc/install)
```

Flags: `--skip-key`, `--no-modify-path`, `--version <v>`.

### Windows 11

Run in **non-admin** PowerShell (admin is not required — all installs
are per-user):

```powershell
irm https://download.gpd.psi.inc/install.ps1 | iex
```

`irm | iex` runs the script in the current PowerShell session, so it
bypasses ExecutionPolicy without needing a `Set-ExecutionPolicy` line
(no `.ps1` file is being executed). Stdin is the irm pipe rather than
the terminal, so the install-time PSI-key prompt is skipped — the key
gets entered through the desktop app's welcome screen on first launch
instead, which is the expected GPD flow.

If you want to enter the key at install time (rare; CI / scripted
onboarding only), preset the env var first:
```powershell
$env:GPD_API_KEY = "sk-your-key"
irm https://download.gpd.psi.inc/install.ps1 | iex
```

Or download-then-run for an interactive prompt connected to your
terminal:
```powershell
Set-ExecutionPolicy Bypass -Scope Process -Force
irm https://download.gpd.psi.inc/install.ps1 -OutFile $env:TEMP\install.ps1
& $env:TEMP\install.ps1
```

Windows-specific flags: `-SkipLaunch` (suppress auto-launching GPD at the
end — useful for CI).

### Verify the installer before executing (optional, recommended)

The one-liners above go straight from download to execution, so an
attacker who compromised a PSI maintainer token or GitHub infrastructure
could in principle replace the script between when you read it and when
you run it. For extra assurance, fetch the script + the hash manifest
separately and verify by hand before running.

**macOS / Linux:**
```bash
curl -fsSL https://download.gpd.psi.inc/install       -o /tmp/gpd-install
curl -fsSL https://download.gpd.psi.inc/SHA256SUMS.txt -o /tmp/gpd-sums
( cd /tmp && grep ' install$' gpd-sums | awk '{print $1"  gpd-install"}' | shasum -a 256 -c )
bash /tmp/gpd-install
```

**Windows PowerShell:**
```powershell
Invoke-WebRequest https://download.gpd.psi.inc/install.ps1      -OutFile $env:TEMP\gpd-install.ps1
$sums = (Invoke-WebRequest https://download.gpd.psi.inc/SHA256SUMS.txt).Content
$expected = ($sums -split "`n" | Where-Object { $_ -match 'install\.ps1$' } | ForEach-Object { $_.Split()[0] })
$actual   = (Get-FileHash $env:TEMP\gpd-install.ps1 -Algorithm SHA256).Hash.ToLower()
if ($expected -ne $actual) { throw "SHA256 mismatch - not running installer." }
& $env:TEMP\gpd-install.ps1
```

`SHA256SUMS.meta` alongside the hashes records the source commit on the
`gpd` branch of `psi-oss/gpd-app` that the published scripts were built
from, if you want to diff the published script against the repo.

### Local testing (developers only)

```bash
bash install                              # Run local version
GPD_API_KEY=sk-test bash install          # Non-interactive
```

## What Gets Installed

Everything GPD-related goes into one directory per user:

```
~/.gpd/                          # Linux + macOS; %USERPROFILE%\.gpd on Windows
├── bin/
│   ├── opencode                 # Runtime binary (symlink on Ubuntu)
│   └── gpd                      # The `gpd` CLI command (gpd.cmd + gpd.ps1 on Windows)
├── python/                      # App-local Python 3.13 (only if system Python < 3.11)
├── venv/                        # Python venv with the GPD package (shared with desktop app)
├── config/
│   └── litellm.env              # PSI API key (user-only permissions)
└── .gpd-initialized             # Marker so the desktop app skips its first-run setup
```

Plus the desktop app is installed system- or user-wide:

| Platform | Path |
|----------|------|
| Ubuntu | `/usr/bin/GPD` (via `.deb`) |
| macOS | `/Applications/GPD.app` (via `.dmg`) |
| Windows | `%LOCALAPPDATA%\GPD\GPD.exe` (per-user Tauri NSIS) |

The installer also ensures these system dependencies:

| Tool | Ubuntu | macOS | Windows |
|------|--------|-------|---------|
| git | apt (if missing) | warn + suggest xcode-select | winget --scope user |
| LaTeX (pdflatex, bibtex, latexmk, kpsewhich) | apt `texlive-latex-base texlive-binaries latexmk` | Homebrew `basictex` + `tlmgr install latexmk` | winget MiKTeX --scope user |
| Python 3.11+ | system or app-local standalone | system or app-local | app-local standalone |

Git, LaTeX, and Python are installed **per-user** where possible so the
installer does not require admin on Windows.

## Prerequisites

- **Ubuntu/Debian**: `curl` (`sudo apt install curl` if missing). Everything else is auto-installed.
- **macOS**: `curl`, `unzip`, `tar` (all ship with macOS; install Xcode CLT if missing).
- **Windows 11**: PowerShell 5.1+. No admin required.

## Installation Steps

Each installer performs these steps:

1. **System dependencies** — git + LaTeX + Python 3.11+ via the platform's package manager.
2. **GPD desktop app + CLI runtime** — the platform's Tauri bundle (`.deb` / `.dmg` / NSIS `.exe`).
3. **Python venv** — creates `~/.gpd/venv/` with `get-physics-done` installed from GitHub.
4. **PSI key** — prompts for your virtual key (get it from your lab administrator), or reads `GPD_API_KEY` env var for non-interactive installs. Writes it to both `~/.gpd/config/litellm.env` and opencode's `auth.json`.
5. **`gpd` command** — creates the `gpd` wrapper on PATH.
6. **PATH** — adds `~/.gpd/bin` to your shell / user PATH.
7. **Runtime config** — runs `gpd install opencode --global` to deploy agents, commands, and the GPD provider config.
8. **First-run marker** — writes `~/.gpd/.gpd-initialized` so the desktop app skips its own setup and launches instantly.
9. **Windows only**: auto-launches GPD at the end so the child process inherits the fresh PATH (works around a Windows Explorer env-caching issue — see `--SkipLaunch` to disable).

## Configuration

### PSI Key

The installer prompts during setup. To change later:

```bash
nano ~/.gpd/config/litellm.env       # Linux/macOS
notepad $HOME\.gpd\config\litellm.env # Windows
```

File contents:
```
GPD_API_KEY=sk-your-key-here
LITELLM_API_BASE=https://litellm-production-46bb.up.railway.app
```

### Custom Install Location

Set `GPD_HOME` before running:
```bash
GPD_HOME=/opt/gpd bash install
```

## Re-running the Installer

Installers are idempotent — each step short-circuits if already done.
Safe to re-run after updates or if a step previously failed.

## Uninstalling

### Linux

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/psi-oss/opencode/gpd/install-gpd/uninstall.sh)
```

Add `--yes` to skip the confirmation prompt.

### macOS

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/psi-oss/opencode/gpd/install-gpd/uninstall_macos.sh)
```

### Windows

```powershell
Set-ExecutionPolicy Bypass -Scope Process -Force
irm https://raw.githubusercontent.com/psi-oss/opencode/gpd/install-gpd/windows_11/uninstall.ps1 -OutFile $env:TEMP\uninstall.ps1
& $env:TEMP\uninstall.ps1
```

Add `-Yes` to skip confirmation.

### What uninstall removes

| | Linux | macOS | Windows |
|---|---|---|---|
| `~/.gpd/` | ✓ | ✓ | ✓ |
| Desktop app | `.deb` removed | `/Applications/GPD.app` removed | NSIS uninstaller runs |
| PATH entries in shell rc / user PATH | ✓ | ✓ | ✓ |
| `GPD_API_KEY` export from login profile | ✓ | ✓ | n/a |
| `gpd` entry stripped from opencode `auth.json` | ✓ | ✓ | ✓ |
| GUI app state, WebView data, cache dirs | ✓ | ✓ | ✓ |
| opencode config/data dirs (when GPD-only) | ✓ | ✓ | ✓ |

**Not removed** (other tools may depend on them):
- git
- LaTeX (`texlive-*` / BasicTeX / MiKTeX)
- Homebrew, Xcode CLT, WinGet

The final message includes copy-pasteable commands if you want to
remove these manually.

## File Structure

```
install-gpd/
├── install                      # Unified installer (Ubuntu + macOS + other Linux)
├── uninstall.sh                 # Linux uninstaller
├── uninstall_macos.sh           # macOS uninstaller (BasicTeX / .app / Library paths)
├── windows_11/
│   ├── install.ps1              # Windows PowerShell installer
│   └── uninstall.ps1            # Windows uninstaller
├── README.md                    # This file
├── TODO.md                      # Known gaps and follow-ups
└── VM_TESTING.md                # Notes on the test VMs (u3, u4, win11)
```

`install` is a self-contained script suitable for piping from curl. It
detects the platform at runtime, handles `.deb` install on Debian/Ubuntu,
and falls back to the standalone CLI on other Linux.

## Troubleshooting

### "curl: command not found"
Install curl: `sudo apt install curl` (Ubuntu) or install Xcode Command Line Tools (macOS).

### "Python extraction failed"
The python-build-standalone download may have failed. Check your network and retry. The installer uses Python 3.13.3 from [astral-sh/python-build-standalone](https://github.com/astral-sh/python-build-standalone).

### "gpd: command not found" after install
Open a new terminal. Shell rc updates only apply to new sessions. On Windows, open a new PowerShell (the installer's own process has the right PATH, but your existing shells don't).

### Re-configuring the PSI key
Edit `~/.gpd/config/litellm.env` directly (set `GPD_API_KEY=sk-...`), or delete the file and re-run the installer.

### Windows: GPD app can't find git on first launch
Windows Explorer caches PATH at login, so `GPD.exe` launched from the Start menu inherits a stale PATH that doesn't include newly-installed git. The installer works around this by launching `GPD.exe` directly at the end of install (so it inherits the fresh PATH). If you close that window and re-launch from the Start menu before logging out, restart Explorer:
```powershell
Stop-Process -Name explorer -Force; Start-Process explorer
```

### Windows: "You cannot call a method on a null-valued expression" during irm | iex
Happens when running `irm | iex` without `GPD_API_KEY` preset. The script falls back to `Read-Host` for the key but the iex pipeline has stdin redirected. Use the download-then-run form instead (see Quick Start above).

### macOS: no LaTeX after install
BasicTeX was installed but `tlmgr install latexmk` needs `/Library/TeX/texbin` on PATH, which happens only in new login shells. Open a new Terminal tab and try again, or run:
```bash
export PATH="/Library/TeX/texbin:$PATH"
```
