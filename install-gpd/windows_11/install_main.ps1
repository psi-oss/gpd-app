# GPD CLI installer for Windows 11 (main script)
#
# Direct usage:
#   powershell -ExecutionPolicy Bypass -File install_main.ps1
#   powershell -ExecutionPolicy Bypass -File install_main.ps1 -SkipLaunch -NoExportKey
#
# Indirect usage (the recommended path users actually type):
#   irm https://download.gpd.psi.inc/install.ps1 | iex
#   This URL serves a tiny ASCII-only bootstrap (install.ps1) that
#   downloads THIS file with explicit UTF-8 decoding and runs it as
#   a scriptblock. The bootstrap step is what makes [CmdletBinding()]
#   + param() at top of this file legal under iex — without it, iex
#   parses statements in the caller's scope where attribute and param
#   declarations are syntactically rejected.
#
# Flags via env vars (for the `irm | iex` invocation, since iex doesn't
# propagate caller arguments to the evaluated string):
#   $env:GPD_SKIP_LAUNCH   = "1"  -> suppress auto-launch
#   $env:GPD_NO_EXPORT_KEY = "1"  -> skip writing GPD_API_KEY to User env
#
# Installs: OpenCode CLI, Python 3.11+ (app-local), GPD package, gpd command.
# Everything goes into $HOME\.gpd\ -- no system-wide changes except user PATH.
# Does not require administrator privileges.

#Requires -Version 5.1
[CmdletBinding()]
param(
    # Suppress the automatic GPD.exe launch at the end of install.
    # Useful for CI / scripted installs that just want the files in
    # place without a window popping up.
    [switch]$SkipLaunch,

    # Skip writing GPD_API_KEY into the user environment. The key is
    # still saved to $env:USERPROFILE\.gpd\config\litellm.env and to
    # opencode's auth.json so the CLI wrapper and desktop app both
    # keep working; only the User-scope environment variable is
    # skipped. Mirrors the Unix --no-export-key flag.
    [switch]$NoExportKey,

    # Prompt for the PSI API key during install. Default behavior is to
    # skip the prompt and let the desktop welcome screen capture the
    # key on first launch. $env:GPD_API_KEY is still honored if preset.
    [switch]$PromptKey
)

# Env-var fallback for the `irm | iex` -> bootstrap -> scriptblock path.
# `iex` does not propagate caller $args, so the bootstrap can't pass
# `-SkipLaunch` through even when the user wants it. Treating any
# non-empty value other than "0"/"false"/"no" as truthy.
$envTruthy = { param($v) $v -and $v -notmatch '^(0|false|no)$' }
if (& $envTruthy $env:GPD_SKIP_LAUNCH)   { $SkipLaunch  = $true }
if (& $envTruthy $env:GPD_NO_EXPORT_KEY) { $NoExportKey = $true }
if (& $envTruthy $env:GPD_PROMPT_KEY)    { $PromptKey   = $true }

$ErrorActionPreference = "Stop"

# Force the console to UTF-8 for output so the Unicode box-drawing chars
# in the GPD banner render correctly on PowerShell 5.1. Without this,
# PS 5.1 writes to the OEM codepage (CP850/CP1252) which doesn't contain
# U+2500-257F (box drawing) — users see mojibake like "�����ۻ" instead
# of "██████╗". PS 7+ already uses UTF-8 by default; this is a no-op
# there.
try {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
} catch {
    # Non-fatal if the console doesn't let us change encoding (rare)
}

# Disable QuickEdit / Insert mode on the console input handle for the
# duration of the install. Default Windows powershell.exe consoles ship
# with QuickEdit ON, which means a single accidental click anywhere in
# the window enters "mark/select" mode and freezes ALL stdout until the
# user presses a key — visible to users as "the installer hangs until
# I press the down arrow". The clear-QuickEdit pattern requires also
# setting ENABLE_EXTENDED_FLAGS (0x0080) in the same SetConsoleMode
# call; without that flag the input-mode change is silently ignored.
# Best-effort — failures (Windows Terminal in conpty, redirected
# stdin, sandboxed contexts) are non-fatal.
try {
    if (-not ('GpdInstall.ConsoleMode' -as [type])) {
        Add-Type -Namespace 'GpdInstall' -Name 'ConsoleMode' -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)]
public static extern System.IntPtr GetStdHandle(int nStdHandle);
[System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)]
public static extern bool GetConsoleMode(System.IntPtr hConsoleHandle, out uint lpMode);
[System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)]
public static extern bool SetConsoleMode(System.IntPtr hConsoleHandle, uint dwMode);
'@ -ErrorAction Stop
    }
    $hStdIn = [GpdInstall.ConsoleMode]::GetStdHandle(-10) # STD_INPUT_HANDLE
    if ($hStdIn -ne [System.IntPtr]::Zero -and $hStdIn -ne ([System.IntPtr]::new(-1))) {
        $mode = 0
        if ([GpdInstall.ConsoleMode]::GetConsoleMode($hStdIn, [ref]$mode)) {
            # ENABLE_QUICK_EDIT_MODE = 0x0040 (clear)
            # ENABLE_INSERT_MODE     = 0x0020 (clear; otherwise paste-during-output can deadlock)
            # ENABLE_EXTENDED_FLAGS  = 0x0080 (must be set for the above changes to apply)
            $newMode = ($mode -band (-bnot 0x0060)) -bor 0x0080
            if ($newMode -ne $mode) {
                [GpdInstall.ConsoleMode]::SetConsoleMode($hStdIn, $newMode) | Out-Null
            }
        }
    }
} catch {
    # Console handle inaccessible (Windows Terminal / conpty, ISE,
    # redirected stdin). Falling back to the user's default mode means
    # they may still see the QuickEdit-pause behavior; nothing else
    # depends on this succeeding.
}

# ── Configuration ──────────────────────────────────────────────────────────

$GpdHome      = if ($env:GPD_HOME) { $env:GPD_HOME } else { Join-Path $HOME ".gpd" }
$GpdBinDir    = Join-Path $GpdHome "bin"
$GpdPythonDir = Join-Path $GpdHome "python"
$GpdVenvDir   = Join-Path $GpdHome "venv"
$GpdConfigDir = Join-Path $GpdHome "config"

$OpenCodeOrg         = "psi-oss"
$OpenCodeRepo        = "opencode"
$OpenCodeFallbackOrg = "anomalyco"
$OpenCodeFallbackRepo = "opencode"

# PyPI source: the published get-physics-done wheel. We track latest
# rather than pin so pilot users always get the newest agent + MCP
# server set without waiting for an installer release. Tradeoff:
# install reproducibility drops; set $env:GPD_PACKAGE_VERSION="X.Y.Z"
# before running to pin a specific release if needed.
#
# Why PyPI over the GitHub source tarball or the npm bootstrap
# (`npx -y get-physics-done`):
#   * PyPI: pre-built wheel, no GitHub dependency at install time, no
#     Node.js needed.
#   * GitHub tarball: requires running setup.py / building from source.
#   * npm bootstrap: would add a Node.js prereq just to delegate the
#     venv + pip step we already do natively.
$GpdPackageName    = "get-physics-done"
# Optional pin override via env. Empty = install latest from PyPI.
$GpdPackageVersion = if ($env:GPD_PACKAGE_VERSION) { $env:GPD_PACKAGE_VERSION } else { "" }

$LiteLlmProxyUrl = "https://litellm-production-46bb.up.railway.app"

# Python provisioning is delegated to uv. uv ships its own per-platform
# installer (`irm https://astral.sh/uv/install.ps1 | iex`) that always
# resolves the latest stable uv binary for the host triple, including
# x86_64-pc-windows-msvc + aarch64-pc-windows-msvc + i686-pc-windows-msvc.
# `uv python install <X.Y>` then fetches the matching python-build-
# standalone tarball via uv's internal manifest, which always tracks
# the latest patch release and supports every triple uv runs on. By
# delegating, we drop the hand-pinned $PbsSha256 hashtable + the
# bespoke tar extractor + the per-tag URL composition.
#
# Required Python minor release. uv resolves the latest patch release
# matching this minor version (3.13.13 today via PBS 20260414). We do
# not pin a patch number — uv refreshes its manifest when astral-sh
# ships a new build, so installer reruns pull the latest fixes for free.
$RequiredPythonMinorRelease = "3.13"

# Sentinel constants for any user-environment change we make. Phase 2's
# uninstaller keys off the exact same strings — do not change wording or
# spacing. (The Windows installer currently only writes to the User PATH
# environment variable, not to a profile file, so these are reserved for
# future use when profile-file edits become necessary.)
$GpdSentinelOpen  = '# >>> GPD CLI >>>'
$GpdSentinelClose = '# <<< GPD CLI <<<'

$RequiredPythonMajor = 3
$RequiredPythonMinor = 11

# ── Logging ────────────────────────────────────────────────────────────────

function Write-Log {
    param([string]$Message)
    Write-Host "  i " -ForegroundColor Cyan -NoNewline
    Write-Host $Message
}

function Write-Success {
    param([string]$Message)
    Write-Host "  + " -ForegroundColor Green -NoNewline
    Write-Host $Message
}

function Write-Warn {
    param([string]$Message)
    Write-Host "  ! " -ForegroundColor Yellow -NoNewline
    Write-Host $Message
}

function Write-Err {
    param([string]$Message)
    Write-Host "  x " -ForegroundColor Red -NoNewline
    Write-Host $Message
}

function Stop-WithError {
    param([string]$Message)
    Write-Err $Message
    # `throw` instead of `exit 1` because this script runs as a scriptblock
    # under the `irm | iex` -> bootstrap path. PowerShell's `exit` from a
    # scriptblock kills the entire host process, which closes the
    # PowerShell window mid-install with no visible error so users can't
    # see what went wrong. Throwing propagates a terminating error that
    # PowerShell prints in red and leaves the window open.
    throw $Message
}

# ── Banner ─────────────────────────────────────────────────────────────────

function Write-Banner {
    Write-Host ""
    Write-Host " ██████╗ ██████╗ ██████╗ " -ForegroundColor Cyan
    Write-Host "██╔════╝ ██╔══██╗██╔══██╗" -ForegroundColor Cyan
    Write-Host "██║  ███╗██████╔╝██║  ██║" -ForegroundColor Cyan
    Write-Host "██║   ██║██╔═══╝ ██║  ██║" -ForegroundColor Cyan
    Write-Host "╚██████╔╝██║     ██████╔╝" -ForegroundColor Cyan
    Write-Host " ╚═════╝ ╚═╝     ╚═════╝ " -ForegroundColor Cyan
    Write-Host ""
    Write-Host " Get Physics Done" -NoNewline -ForegroundColor White
    Write-Host " -- CLI Installer" -ForegroundColor DarkGray
    Write-Host " Open-source AI copilot for physics research" -ForegroundColor DarkGray
    Write-Host ""
}

function Write-SuccessBanner {
    # NSIS drops GPD.exe under %LOCALAPPDATA%\GPD\GPD.exe (per-user
    # install). We always install the desktop bundle (x64 binary
    # runs on ARM via Windows emulation), so the success message
    # always points at the GUI. If the .exe is somehow missing
    # (download skipped, network failure handled non-fatally), fall
    # back to telling the user how to invoke the CLI wrapper.
    $gpdExePath = Join-Path $env:LOCALAPPDATA "GPD\GPD.exe"
    $hasDesktop = Test-Path $gpdExePath

    Write-Host ""
    Write-Success "GPD installed successfully!"
    Write-Host ""
    if ($hasDesktop) {
        Write-Host "  Open the " -NoNewline
        Write-Host "GPD" -NoNewline -ForegroundColor White
        Write-Host " app from the Start menu to get started."
        Write-Host "  First launch walks you through TOS acceptance + your PSI key." -ForegroundColor DarkGray
    } else {
        Write-Host "  GPD desktop app NOT installed at $gpdExePath." -ForegroundColor Red
        Write-Host "  The desktop installer step failed earlier. Re-run the installer or open" -ForegroundColor Red
        Write-Host "  an issue at https://github.com/psi-oss/gpd-app/issues with the log above." -ForegroundColor Red
    }
    Write-Host ""
    Write-Host "  Installation directory: $GpdHome" -ForegroundColor DarkGray
    Write-Host ""
}

# ── Utilities ──────────────────────────────────────────────────────────────

function Get-Arch {
    # Use $env:PROCESSOR_ARCHITECTURE (always set by Windows) instead of
    # [RuntimeInformation]::OSArchitecture. The latter returns $null in
    # PowerShell 5.1 + .NET Framework 4.x combinations we've seen on
    # Windows 11 25H2, causing a "null method call" on .ToString().
    # PROCESSOR_ARCHITECTURE is reliable across all Windows versions.
    #
    # On 64-bit Windows: AMD64 (x64) or ARM64
    # Under WOW64 (32-bit process on 64-bit host): PROCESSOR_ARCHITECTURE
    # reports x86, but PROCESSOR_ARCHITEW6432 has the real value — check
    # both since PowerShell 5.1 is a 64-bit process by default but
    # scheduled/remote contexts can run 32-bit.
    $arch = $env:PROCESSOR_ARCHITEW6432
    if (-not $arch) { $arch = $env:PROCESSOR_ARCHITECTURE }
    switch ($arch) {
        "AMD64" { return "x64" }
        "ARM64" { return "arm64" }
        "x86"   { Stop-WithError "32-bit Windows is not supported. Use 64-bit Windows." }
        default { Stop-WithError "Unsupported architecture: $arch" }
    }
}

function Test-UrlExists {
    param([string]$Url)
    try {
        $request = [System.Net.WebRequest]::Create($Url)
        $request.Method = "HEAD"
        $request.AllowAutoRedirect = $true
        $request.Timeout = 10000
        $response = $request.GetResponse()
        $statusCode = [int]$response.StatusCode
        $response.Close()
        return ($statusCode -ge 200 -and $statusCode -lt 400)
    }
    catch {
        return $false
    }
}

function Test-FileSha256 {
    param(
        [Parameter(Mandatory=$true)][string]$Path,
        [Parameter(Mandatory=$true)][string]$Expected
    )
    # Compare case-insensitively — Get-FileHash returns uppercase hex,
    # upstream SHA256SUMS are lowercase.
    $actual = (Get-FileHash -Path $Path -Algorithm SHA256).Hash
    return ($actual -ieq $Expected)
}

function Test-GpdRunning {
    # Pre-flight: terminate any process running out of $GpdHome before
    # touching python/venv dirs. Windows file locking on python.exe and
    # venv scripts otherwise turns later extract/copy steps into mid-
    # install failures with no clean way back to the prior state.
    #
    # The previous version asked the user to "Quit GPD" — but quitting
    # the desktop app doesn't always reap orphaned children: the
    # bun/opencode-cli sidecar (Tauri externalBin) and any venv python
    # subprocess (gpd MCP tools) can outlive the GUI parent on Windows
    # because Tauri doesn't put them in a Job Object. Users hit a loop
    # of "I closed GPD, why is it still detecting one?".
    #
    # Since every binary under $GpdHome ships from THIS installer, we
    # own it and can safely kill it. Try Stop-Process with a short wait
    # for graceful exit, escalate to -Force, and only Stop-WithError if
    # that still fails (process held by something we can't terminate
    # without admin rights).
    if (-not (Test-Path $GpdHome)) { return }

    $running = @()
    foreach ($proc in (Get-Process -ErrorAction SilentlyContinue)) {
        $path = $null
        try { $path = $proc.Path } catch { continue }
        if ($path -and $path.StartsWith($GpdHome, [System.StringComparison]::OrdinalIgnoreCase)) {
            $running += $proc
        }
    }

    if ($running.Count -eq 0) { return }

    $names = ($running | ForEach-Object { $_.ProcessName } | Sort-Object -Unique) -join ", "
    Write-Log "Stopping leftover GPD processes from a previous install: $names"

    foreach ($proc in $running) {
        try { Stop-Process -Id $proc.Id -ErrorAction SilentlyContinue } catch { }
    }
    Start-Sleep -Milliseconds 500
    foreach ($proc in $running) {
        try {
            $still = Get-Process -Id $proc.Id -ErrorAction SilentlyContinue
            if ($still) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
        } catch { }
    }
    Start-Sleep -Milliseconds 500

    $stillRunning = @()
    foreach ($proc in $running) {
        $live = Get-Process -Id $proc.Id -ErrorAction SilentlyContinue
        if ($live) { $stillRunning += $live }
    }
    if ($stillRunning.Count -gt 0) {
        $remaining = ($stillRunning | ForEach-Object { "$($_.ProcessName) (pid $($_.Id))" }) -join ", "
        Stop-WithError "Couldn't stop GPD processes: $remaining. Open Task Manager, end them, then re-run the installer."
    }
}

function Invoke-Download {
    param(
        [string]$Url,
        [string]$Destination
    )
    Write-Log "Downloading $(Split-Path $Destination -Leaf)..."
    try {
        # Force TLS 1.2 minimum for GitHub (it rejects TLS 1.0/1.1). TLS 1.3
        # is not guaranteed: PS 5.1 on .NET 4.7.x ships without the Tls13
        # enum value, so referencing it throws at parse/dispatch time and
        # every download fails. Probe for Tls13 dynamically and OR it in
        # only when present.
        $proto = [Net.SecurityProtocolType]::Tls12
        try { $proto = $proto -bor [Net.SecurityProtocolType]::Tls13 } catch { }
        [Net.ServicePointManager]::SecurityProtocol = $proto
        $ProgressPreference = "SilentlyContinue"
        Invoke-WebRequest -Uri $Url -OutFile $Destination -UseBasicParsing
    }
    catch {
        Stop-WithError "Download failed: $Url -- $_"
    }
}

# ── OpenCode CLI ───────────────────────────────────────────────────────────

# Install the GPD desktop app via the Tauri NSIS .exe installer.
# The filename includes the version so we use the web redirect on
# /releases/latest to discover the tag without hitting the rate-limited API.
function Get-GpdLatestTag {
    # GitHub's /releases/latest URL redirects twice for repos that have
    # been renamed: the first hop goes from the old repo name to the new
    # one (repo rename redirect), and only the second hop has /tag/... in
    # the Location. Example chain as of 2026-04:
    #   github.com/psi-oss/opencode/releases/latest
    #     --> github.com/psi-oss/gpd-app/releases/latest   (rename)
    #     --> github.com/psi-oss/gpd-app/releases/tag/gpd-desktop-v1.1.4
    # So follow up to 3 redirects, parsing the tag from whichever hop
    # actually has it. Using AllowAutoRedirect=true + ResponseUri is the
    # simplest correct path; .NET follows all 3xx for us and lands on
    # the tagged URL which we can regex on directly.
    try {
        $req = [System.Net.WebRequest]::Create("https://github.com/$OpenCodeOrg/$OpenCodeRepo/releases/latest")
        $req.Method = "HEAD"
        $req.AllowAutoRedirect = $true
        $req.MaximumAutomaticRedirections = 5
        $r = $req.GetResponse()
        $finalUri = $r.ResponseUri.AbsoluteUri
        $r.Close()
        if ($finalUri -match 'tag/([^/]+)') { return $Matches[1] }
    } catch {
        return $null
    }
    return $null
}

function Install-GpdDesktop {
    param([string]$Arch)

    # Pick the native installer for the user's CPU when available, with a
    # graceful fallback to x64-via-emulation if the ARM bundle hasn't
    # been published yet. Both Tauri NSIS bundles install transparently
    # under %LOCALAPPDATA%\GPD\GPD.exe; the only difference is which
    # binary the OS executes.
    #
    # Why we prefer native ARM64: the x64 bundle runs under Windows'
    # x86-on-ARM emulator, and bun in that emulator hit the
    # RADAR_PRE_LEAK_64 memory-leak detector mid-session, killing the
    # sidecar. Reproduced 2026-04-29 on Parallels Win 11 ARM (WER event
    # 1001, P1 opencode-cli.exe v1.3.11.0). Switching to the native
    # ARM64 bundle avoids the emulator entirely.
    #
    # Fallback rationale: until the first release that includes the
    # arm64-setup.exe artifact lands, Test-UrlExists will 404 on ARM
    # hosts and we'd skip the desktop install entirely. Falling back to
    # x64 keeps users unblocked with a less-stable but still-working
    # build (auto-recovery is handled by the Rust-side sidecar
    # watchdog; see packages/desktop/src-tauri/src/lib.rs).
    if ($Arch -eq "arm64") {
        $preferredArchSuffix = "arm64"
        $fallbackArchSuffix = "x64"
    } else {
        $preferredArchSuffix = "x64"
        $fallbackArchSuffix = $null
    }

    # Tauri NSIS per-user install path. The default is %LOCALAPPDATA%\GPD\
    # (confirmed via HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall
    # on a fresh install — InstallLocation = "C:\Users\<user>\AppData\Local\GPD").
    # An earlier version of this script checked %LOCALAPPDATA%\Programs\GPD\
    # which is the Electron convention — Tauri uses the non-Programs path.
    $tauriPath = Join-Path $env:LOCALAPPDATA "GPD\GPD.exe"
    if (Test-Path $tauriPath) {
        Write-Success "GPD desktop app already installed at $tauriPath"
        return $true
    }

    $tag = Get-GpdLatestTag
    if (-not $tag) {
        Write-Warn "Could not discover GPD release tag - skipping desktop app."
        return $false
    }

    # Extract semver from tags like "gpd-desktop-v1.1.6" or "v1.1.6". The
    # previous -replace '.*-v','' was greedy — "v1.1.6" (no dash-v) left
    # $ver equal to the whole tag, then the download URL 404'd.
    if ($tag -match 'v(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)') {
        $ver = $Matches[1]
    } else {
        Write-Warn "Could not parse version from tag '$tag' - skipping desktop app."
        return $false
    }

    $setupFile = "GPD_" + $ver + "_$preferredArchSuffix-setup.exe"
    $setupUrl = "https://github.com/$OpenCodeOrg/$OpenCodeRepo/releases/download/$tag/$setupFile"

    if (-not (Test-UrlExists $setupUrl)) {
        if ($fallbackArchSuffix) {
            Write-Log "Native $preferredArchSuffix bundle not found at $setupUrl; falling back to $fallbackArchSuffix (Windows x64 emulation)..."
            $setupFile = "GPD_" + $ver + "_$fallbackArchSuffix-setup.exe"
            $setupUrl = "https://github.com/$OpenCodeOrg/$OpenCodeRepo/releases/download/$tag/$setupFile"
            if (-not (Test-UrlExists $setupUrl)) {
                Write-Warn "GPD desktop .exe not found for $preferredArchSuffix or $fallbackArchSuffix at $setupUrl"
                return $false
            }
        } else {
            Write-Warn "GPD desktop .exe not found at $setupUrl"
            return $false
        }
    } elseif ($Arch -eq "arm64") {
        Write-Log "Installing native ARM64 GPD desktop app..."
    }

    $tmpDir = Join-Path ([System.IO.Path]::GetTempPath()) "gpd-desktop-$(Get-Random)"
    New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null
    $dlPath = Join-Path $tmpDir $setupFile

    try {
        Invoke-Download -Url $setupUrl -Destination $dlPath
        Write-Log "Installing GPD desktop app (silent install, ~40MB)..."
        $proc = Start-Process -FilePath $dlPath -ArgumentList "/S" -Wait -PassThru
        if ($proc.ExitCode -ne 0) {
            Write-Warn "GPD desktop installer exit code $($proc.ExitCode)"
            return $false
        }
        Write-Success "GPD desktop app installed"
        return $true
    } catch {
        Write-Warn "GPD desktop install failed: $_"
        return $false
    } finally {
        Remove-Item -Path $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Install-OpenCode {
    param([string]$Arch)

    $dest = Join-Path $GpdBinDir "opencode.exe"

    if (Test-Path $dest) {
        Write-Success "OpenCode CLI already installed at $dest"
        return
    }

    # Force x64 on Windows ARM. The native aarch64 build of opencode-cli
    # ships a bun runtime whose Windows-ARM port is unofficial / not in
    # bun's CI matrix; under real workloads it crashes with
    # STATUS_ACCESS_VIOLATION (0xC0000005) mid-stream — observed
    # 2026-04-29 on a Parallels Win 11 ARM VM, surfaced in the GUI as
    # ERR_CONNECTION_REFUSED on 127.0.0.1:<sidecar_port>/global/event
    # after the bun process disappears. Windows runs x64 binaries on ARM
    # via the OS emulator with no install ceremony and the perf cost is
    # negligible for a streaming HTTP client. We can drop this when bun
    # ships a stable Windows-ARM build (track upstream bun#11161).
    $cliArch = if ($Arch -eq "arm64") { "x64" } else { $Arch }
    if ($cliArch -ne $Arch) {
        Write-Log "Using x64 OpenCode CLI on Windows ARM (bun ARM64-Windows is unstable; runs under x64 emulation)"
    }
    $asset = "opencode-windows-${cliArch}.zip"
    $gpdUrl      = "https://github.com/${OpenCodeOrg}/${OpenCodeRepo}/releases/latest/download/${asset}"
    $fallbackUrl = "https://github.com/${OpenCodeFallbackOrg}/${OpenCodeFallbackRepo}/releases/latest/download/${asset}"

    $url = $null
    Write-Log "Checking for GPD-branded OpenCode CLI release..."
    if (Test-UrlExists $gpdUrl) {
        $url = $gpdUrl
        Write-Log "Found GPD release"
    }
    else {
        Write-Log "GPD CLI release not found, using upstream OpenCode"
        if (Test-UrlExists $fallbackUrl) {
            $url = $fallbackUrl
        }
        else {
            Stop-WithError "Could not find OpenCode CLI binary for windows/${Arch}. Check network connectivity."
        }
    }

    $tmpDir = Join-Path ([System.IO.Path]::GetTempPath()) "gpd-opencode-$(Get-Random)"
    New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null

    try {
        $archive = Join-Path $tmpDir $asset
        Invoke-Download -Url $url -Destination $archive

        Write-Log "Extracting OpenCode CLI..."
        Expand-Archive -Path $archive -DestinationPath $tmpDir -Force

        # Find the opencode.exe binary in the extracted files
        $binary = Get-ChildItem -Path $tmpDir -Filter "opencode.exe" -Recurse -File |
            Where-Object { $_.FullName -ne $archive } |
            Select-Object -First 1

        if (-not $binary) {
            Stop-WithError "Could not find opencode.exe in downloaded archive"
        }

        Move-Item -Path $binary.FullName -Destination $dest -Force
    }
    finally {
        Remove-Item -Path $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
    }

    Write-Success "OpenCode CLI installed to $dest"
}

# ── Python ─────────────────────────────────────────────────────────────────

function Test-PythonVersionOk {
    param([string]$PythonPath)
    try {
        $output = & $PythonPath --version 2>&1
        if ($output -match "Python (\d+)\.(\d+)") {
            $major = [int]$Matches[1]
            $minor = [int]$Matches[2]
            return ($major -gt $RequiredPythonMajor -or
                   ($major -eq $RequiredPythonMajor -and $minor -ge $RequiredPythonMinor))
        }
        return $false
    }
    catch {
        return $false
    }
}

function Find-SystemPython {
    # Check common Python command names on Windows
    foreach ($cmd in @("python3", "python")) {
        $pythonPath = Get-Command $cmd -ErrorAction SilentlyContinue
        if ($pythonPath -and (Test-PythonVersionOk $pythonPath.Source)) {
            return $pythonPath.Source
        }
    }
    return $null
}

# Install uv into a private prefix so we don't pollute the user's
# system PATH. Idempotent: if uv.exe is present and runnable we don't
# redownload. astral-sh's installer respects $env:UV_INSTALL_DIR +
# $env:INSTALLER_NO_MODIFY_PATH so we keep the install fully scoped.
function Install-UvBootstrap {
    $uvDir = Join-Path $GpdHome "uv-bootstrap"
    $uvBin = Join-Path $uvDir "uv.exe"

    if ((Test-Path $uvBin)) {
        try {
            & $uvBin --version | Out-Null
            if ($LASTEXITCODE -eq 0) { return $uvBin }
        } catch { }
    }

    if (-not (Test-Path $uvDir)) {
        New-Item -ItemType Directory -Path $uvDir -Force | Out-Null
    }

    Write-Log "Installing uv (manages app-local Python)..."
    $env:UV_INSTALL_DIR = $uvDir
    $env:INSTALLER_NO_MODIFY_PATH = "1"
    # uv's PowerShell installer fetches a shim and invokes a child
    # `powershell -File ...` which IS subject to the host's
    # ExecutionPolicy — Windows VMs default to Restricted, so the
    # inner invocation aborts with "PowerShell requires an execution
    # policy in [Unrestricted, RemoteSigned, Bypass]". Lift the
    # policy to Bypass for the duration of the install at Process
    # scope (no admin required, doesn't persist past this PS
    # session). Reset on the way out so we don't leak the elevated
    # state into anything else our caller runs.
    $prevPolicy = Get-ExecutionPolicy -Scope Process
    try {
        Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force
        Invoke-Expression (Invoke-RestMethod "https://astral.sh/uv/install.ps1")
    } catch {
        Stop-WithError "uv installer failed: $_"
    } finally {
        # Restore the prior Process-scope policy. Undefined collapses
        # back to whatever the parent scope dictates, which is the
        # right default — only set explicitly if the user had set a
        # non-Undefined policy before our call.
        if ($prevPolicy -and $prevPolicy -ne 'Undefined') {
            Set-ExecutionPolicy -Scope Process -ExecutionPolicy $prevPolicy -Force -ErrorAction SilentlyContinue
        }
        Remove-Item Env:UV_INSTALL_DIR -ErrorAction SilentlyContinue
        Remove-Item Env:INSTALLER_NO_MODIFY_PATH -ErrorAction SilentlyContinue
    }

    if (-not (Test-Path $uvBin)) {
        Stop-WithError "uv installer ran but $uvBin is missing."
    }
    return $uvBin
}

function Install-LocalPython {
    param([string]$Arch)

    $pythonBin = Join-Path $GpdPythonDir "python.exe"

    if ((Test-Path $pythonBin) -and (Test-PythonVersionOk $pythonBin)) {
        Write-Success "App-local Python already installed at $GpdPythonDir"
        return $pythonBin
    }

    # Provision Python via uv. uv resolves the host triple
    # (incl. aarch64-pc-windows-msvc on Windows ARM) + the latest
    # patch release of $RequiredPythonMinorRelease against its own
    # manifest of python-build-standalone tarballs. Replaces our
    # hand-pinned PBS hash table + bespoke tar extractor.
    $uvBin = Install-UvBootstrap
    $versionsDir = Join-Path $GpdHome "python-versions"
    if (-not (Test-Path $versionsDir)) {
        New-Item -ItemType Directory -Path $versionsDir -Force | Out-Null
    }

    Write-Log "Installing Python $RequiredPythonMinorRelease via uv (app-local)..."
    $env:UV_PYTHON_INSTALL_DIR = $versionsDir
    # uv writes its download/install progress to stderr. With our
    # script-level `$ErrorActionPreference = 'Stop'`, `& $uv ...`
    # piped through `2>&1 | ForEach-Object` was promoting every
    # stderr line into a NativeCommandError that aborted the
    # function mid-download. Drop the merge + relax EAP just for
    # the native call so uv can stream progress to its own
    # stdout/stderr without our wrapper interpreting it as a
    # terminating error.
    $prevEAP = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $uvBin python install $RequiredPythonMinorRelease
        $installCode = $LASTEXITCODE
        # `uv python find` prints the absolute path to python.exe for
        # the requested version. `--python-preference only-managed`
        # forces it to consider only uv-managed installs (not whatever
        # system Python may also satisfy the version).
        $resolvedPython = & $uvBin python find $RequiredPythonMinorRelease --python-preference only-managed 2>$null
    } finally {
        $ErrorActionPreference = $prevEAP
        Remove-Item Env:UV_PYTHON_INSTALL_DIR -ErrorAction SilentlyContinue
    }
    if ($installCode -ne 0) {
        Stop-WithError "uv python install $RequiredPythonMinorRelease failed (exit $installCode)"
    }

    if (-not $resolvedPython -or -not (Test-Path $resolvedPython)) {
        Stop-WithError "uv could not locate the installed Python $RequiredPythonMinorRelease interpreter"
    }

    # Liveness probe before we publish the symlink. Empty-string args
    # get stripped by PS 5.1 before native invoke, so we use `pass`.
    & $resolvedPython -c "pass" 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Stop-WithError "uv-installed Python is not runnable: $resolvedPython"
    }

    # uv lays out Pythons under
    # <versions>\cpython-3.13.13-x86_64-pc-windows-msvc-none\python.exe
    # so the prefix dir is the parent of the resolved python.exe.
    $prefix = Split-Path -Parent $resolvedPython

    # Atomic swap: stage a directory junction (mklink /J) at
    # $GpdPythonDir.new pointing at the uv-managed prefix, move the
    # old tree aside, then move the junction into place. Junctions
    # behave like symlinks for filesystem traversal but don't require
    # SeCreateSymbolicLinkPrivilege (admin-only by default on Windows).
    $newPath = "$GpdPythonDir.new"
    $oldPath = "$GpdPythonDir.old"
    if (Test-Path $newPath) { Remove-Item -Path $newPath -Recurse -Force -ErrorAction SilentlyContinue }
    if (Test-Path $oldPath) { Remove-Item -Path $oldPath -Recurse -Force -ErrorAction SilentlyContinue }

    # `cmd /c mklink /J <link> <target>` is the most reliable junction
    # creation API across PS 5.1 + 7. New-Item -ItemType Junction works
    # on PS 5.1 too but emits noisy verbose output; mklink stays quiet.
    & cmd /c mklink /J "$newPath" "$prefix" | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Stop-WithError "Could not create junction $newPath -> $prefix"
    }

    if (Test-Path $GpdPythonDir) {
        Move-Item -Path $GpdPythonDir -Destination $oldPath -Force
    }
    try {
        Move-Item -Path $newPath -Destination $GpdPythonDir -Force
    } catch {
        # Roll back so the user isn't left without a Python.
        if (Test-Path $oldPath) {
            Move-Item -Path $oldPath -Destination $GpdPythonDir -Force -ErrorAction SilentlyContinue
        }
        Stop-WithError "Python junction swap failed: $_"
    }
    if (Test-Path $oldPath) {
        Remove-Item -Path $oldPath -Recurse -Force -ErrorAction SilentlyContinue
    }

    if (-not (Test-Path $pythonBin)) {
        Stop-WithError "Python install failed -- $pythonBin not found"
    }

    $installedVer = (& $pythonBin --version 2>&1) -replace '^Python\s+',''
    Write-Success "Python $installedVer installed via uv to $GpdPythonDir"
    return $pythonBin
}

function Get-Python {
    param([string]$Arch)

    # Prefer app-local Python if already installed
    $localPython = Join-Path $GpdPythonDir "python.exe"
    if ((Test-Path $localPython) -and (Test-PythonVersionOk $localPython)) {
        Write-Success "Using app-local Python at $localPython"
        return $localPython
    }

    # Check system Python
    $sysPython = Find-SystemPython
    if ($sysPython) {
        $ver = & $sysPython --version 2>&1
        Write-Success "Found system $ver"
        return $sysPython
    }

    # Download standalone Python
    Write-Log "No Python ${RequiredPythonMajor}.${RequiredPythonMinor}+ found -- installing app-local Python"
    return (Install-LocalPython -Arch $Arch)
}

# ── Venv & GPD package ─────────────────────────────────────────────────────

function New-GpdVenv {
    param([string]$PythonPath)

    # Existing-venv reuse must verify the venv is actually USABLE before
    # we trust it. Three failure modes the script has to recover from:
    #
    #   1. uv-managed venv: the desktop app's first-run flow creates the
    #      venv via `uv venv`, which produces a pip-less venv. Install-Gpd
    #      shells out to `python -m pip` and fails immediately.
    #
    #   2. Broken interpreter: the venv's Scripts\python.exe is stranded
    #      (e.g. user deleted ~\.gpd\python\ manually, upgraded the PBS
    #      Python, or system Python was uninstalled). The interpreter
    #      fails to start at all.
    #
    #   3. Half-finished previous install: pip-install of get-physics-done
    #      bailed mid-run, leaving python.exe but no gpd.exe.
    #
    # All three are recoverable by removing the venv and recreating with
    # the stdlib `venv` module (which bundles pip via ensurepip).
    $venvPython = Join-Path $GpdVenvDir "Scripts\python.exe"
    if (Test-Path $venvPython) {
        & $venvPython -c "pass" 2>$null | Out-Null
        if ($LASTEXITCODE -ne 0) {
            Write-Warn "Existing venv interpreter is broken -- recreating..."
            Remove-Item -Recurse -Force $GpdVenvDir -ErrorAction SilentlyContinue
        } else {
            & $venvPython -m pip --version 2>$null | Out-Null
            if ($LASTEXITCODE -eq 0) {
                Write-Success "Python venv already exists at $GpdVenvDir"
                return
            }
            Write-Warn "Existing venv has no pip (uv-managed?) -- recreating with stdlib venv..."
            Remove-Item -Recurse -Force $GpdVenvDir -ErrorAction SilentlyContinue
        }
    }

    Write-Log "Creating Python virtual environment..."
    & $PythonPath -m venv $GpdVenvDir
    if ($LASTEXITCODE -ne 0) {
        Stop-WithError "Failed to create virtual environment"
    }
    Write-Success "Virtual environment created at $GpdVenvDir"
}

function Install-Gpd {
    $venvPython = Join-Path $GpdVenvDir "Scripts\python.exe"
    $venvPip    = Join-Path $GpdVenvDir "Scripts\pip.exe"

    # Upgrade pip first
    & $venvPython -m pip install --upgrade --quiet pip
    if ($LASTEXITCODE -ne 0) {
        Write-Warn "pip upgrade returned non-zero exit code, continuing..."
    }

    if ($GpdPackageVersion) {
        Write-Log "Installing ${GpdPackageName}==${GpdPackageVersion} from PyPI..."
        & $venvPip install --upgrade --quiet "${GpdPackageName}==${GpdPackageVersion}"
    } else {
        Write-Log "Installing ${GpdPackageName} (latest) from PyPI..."
        & $venvPip install --upgrade --quiet "${GpdPackageName}"
    }
    if ($LASTEXITCODE -ne 0) {
        Stop-WithError "Failed to install GPD package"
    }

    $gpdExe = Join-Path $GpdVenvDir "Scripts\gpd.exe"
    if (Test-Path $gpdExe) {
        Write-Success "GPD package installed"
    }
    else {
        Stop-WithError "GPD package installation failed -- gpd.exe not found in venv"
    }

    # Physics-research scratchpad libraries. Not strict dependencies of
    # get-physics-done, but every research session ends up wanting them
    # within 5 minutes (numerical integration, ODE solvers, plotting,
    # symbolic math). ~120 MB extra; one-time download.
    Write-Log "Installing physics scratchpad libs (numpy, scipy, matplotlib, sympy)..."
    & $venvPip install --upgrade --quiet "numpy>=2" "scipy>=1.13" "matplotlib>=3.8" "sympy>=1.13"
    if ($LASTEXITCODE -ne 0) {
        Write-Warn "Physics libs install failed -- agent code that imports scipy/numpy may break. Retry: ~\.gpd\venv\Scripts\pip.exe install scipy numpy matplotlib sympy"
    }

    # arxiv-mcp-server: upstream package the gpd-arxiv MCP bridge imports
    # at process startup. Without it, gpd.mcp.servers.arxiv_bridge raises
    # ModuleNotFoundError on first run and the desktop app shows a red
    # dot next to gpd-arxiv in the Tools panel.
    #
    # The `[pdf]` extra pulls pymupdf4llm + pymupdf — required for the
    # PDF-conversion fallback path in arxiv_mcp_server's download_paper
    # tool (HTML 404 -> PDF). Mirrors the install-gpd/install macOS/Linux
    # branch. Without `[pdf]`, ~45% of download_paper calls error out
    # with "HTML version not available and PDF conversion requires the
    # pdf extra" once arxiv.org/html lacks the paper.
    Write-Log "Installing arxiv-mcp-server[pdf] (powers the gpd-arxiv MCP bridge)..."
    & $venvPip install --upgrade --quiet "arxiv-mcp-server[pdf]>=0.4"
    if ($LASTEXITCODE -ne 0) {
        Write-Warn "arxiv-mcp-server[pdf] install failed -- gpd-arxiv MCP will show red-dot/disconnected. Retry: ~\.gpd\venv\Scripts\pip.exe install 'arxiv-mcp-server[pdf]'"
    }

}

function Test-GpdInstall {
    # Two-step liveness probe, split for actionable error messages.
    $venvPython = Join-Path $GpdVenvDir "Scripts\python.exe"
    # `-c "pass"` instead of `-c ""` — PS 5.1 strips empty-string native
    # command args and python would see `-c` with no value.
    & $venvPython -c "pass" 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Stop-WithError "GPD venv is not runnable -- the Python interpreter inside $GpdVenvDir failed to start. Re-run the installer."
    }
    & $venvPython -c "import gpd" 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Stop-WithError "GPD package import failed -- 'get-physics-done' was installed but 'import gpd' does not work. Re-run the installer."
    }
}

# ── LiteLLM key ────────────────────────────────────────────────────────────

function Read-LiteLlmKey {
    $envFile = Join-Path $GpdConfigDir "litellm.env"

    if (Test-Path $envFile) {
        Write-Success "PSI key already configured at $envFile"
        return
    }

    # Key validation regex: matches the Unix installer so the same keys
    # are accepted on both platforms. sk-<>=10 chars from [A-Za-z0-9_-].
    $keyPattern = '^sk-[A-Za-z0-9_-]{10,}$'

    $key = if ($env:GPD_API_KEY) { $env:GPD_API_KEY } else { "" }
    if (-not [string]::IsNullOrWhiteSpace($key)) {
        # Env-var preset: normalize AND validate. Non-interactive callers
        # (CI, scripted installs) can't be re-prompted, so fail fast when
        # the env-provided key doesn't match the shape check rather than
        # silently writing a broken key into litellm.env + auth.json.
        $key = $key -replace "`r",''
        $key = $key -replace '\s',''
        if ($key -notmatch $keyPattern) {
            Stop-WithError "GPD_API_KEY env var does not match expected format sk-<10+ alphanumeric/underscore/hyphen>. Check for typos."
        }
    }
    if ([string]::IsNullOrWhiteSpace($key)) {
        # Default behavior: defer to the desktop welcome screen, which
        # captures + validates the key on first launch. Pass -PromptKey
        # (or set $env:GPD_PROMPT_KEY=1) to opt back into the inline
        # interactive prompt for users who want litellm.env populated
        # before ever opening the desktop app.
        if (-not $PromptKey) {
            # Silent. Welcome screen captures the key on first launch.
            return
        }
        if (-not [Environment]::UserInteractive -or [Console]::IsInputRedirected) {
            Write-Warn "Non-interactive session and GPD_API_KEY not set -- skipping key configuration."
            Write-Warn "Set `$env:GPD_API_KEY and re-run, or run interactively to be prompted."
            return
        }
        Write-Host ""
        Write-Host "  PSI API Key Configuration" -ForegroundColor White
        Write-Host "  Your PSI key connects GPD to AI models." -ForegroundColor DarkGray
        Write-Host ""
        # Up to 3 attempts. Echo the key as the user types so they can
        # verify what they pasted (per user request; users generally
        # want to confirm a sk-... key is intact before hitting Enter).
        # This does leave the key in the PowerShell transcript/history
        # if transcription is enabled, which is acceptable on a trusted
        # local install.
        $attempts = 0
        $maxAttempts = 3
        while ($attempts -lt $maxAttempts) {
            $plain = Read-Host "  Enter your PSI key (sk-...)"
            $plain = $plain -replace "`r",''
            $plain = $plain -replace '\s',''
            if ([string]::IsNullOrWhiteSpace($plain)) {
                Write-Warn "Key cannot be empty. Press Ctrl+C to skip and configure later."
            } elseif ($plain -notmatch $keyPattern) {
                Write-Warn "Key format looks wrong. Expected sk-<letters/digits/_-> (min 10 chars after prefix)."
            } else {
                $key = $plain
                break
            }
            $attempts++
        }
        if ([string]::IsNullOrWhiteSpace($key) -or ($key -notmatch $keyPattern)) {
            Stop-WithError "Failed to enter a valid PSI key after $maxAttempts attempts."
        }
    }

    $content = @"
# GPD configuration -- used by CLI wrapper and desktop app
GPD_API_KEY=$key
LITELLM_API_BASE=$LiteLlmProxyUrl
"@

    Set-Content -Path $envFile -Value $content -Encoding UTF8

    # Restrict file permissions to current user only
    try {
        $acl = Get-Acl $envFile
        $acl.SetAccessRuleProtection($true, $false)
        $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
            [System.Security.Principal.WindowsIdentity]::GetCurrent().Name,
            "FullControl",
            "Allow"
        )
        $acl.SetAccessRule($rule)
        Set-Acl -Path $envFile -AclObject $acl
    }
    catch {
        Write-Warn "Could not restrict file permissions on $envFile"
    }

    # Also write the key into opencode's auth.json so the GPD desktop app
    # can see an existing auth entry on first launch and skip its own
    # "enter your key" welcome screen. Without this, users who install via
    # the CLI installer and enter their PSI key here still get prompted
    # again when they open the desktop app (matching fix in
    # packages/app/src/app.tsx:SetupGate).
    #
    # auth.json path: opencode uses the xdg-basedir npm package (v5.x),
    # which does NOT special-case Windows — it always resolves xdgData
    # to "$HOME/.local/share", i.e. %USERPROFILE%\.local\share on
    # Windows. Writing to %APPDATA%\opencode (conventional for Windows)
    # leaves the file invisible to opencode; the desktop app then re-
    # prompts for the PSI key on first launch even though the installer
    # "saved" it. Honor $XDG_DATA_HOME when set, else match xdg-basedir.
    $xdgData = if ($env:XDG_DATA_HOME) { $env:XDG_DATA_HOME } else { Join-Path $HOME ".local\share" }
    $authDir = Join-Path $xdgData "opencode"
    $authFile = Join-Path $authDir "auth.json"
    New-Item -ItemType Directory -Path $authDir -Force | Out-Null

    # If auth.json already has other providers, merge (don't clobber).
    # Otherwise write fresh. We keep the container as a PSCustomObject
    # (not a hashtable) because PS 5.1's ConvertTo-Json serializes
    # hashtable values that happen to be PSCustomObjects as the string
    # "@{type=api; key=sk-...}" instead of nested JSON — which would
    # silently corrupt any other provider entries already in auth.json
    # (bug found during Windows installer review, 2026-04-21).
    $authData = if (Test-Path $authFile) {
        try {
            Get-Content $authFile -Raw | ConvertFrom-Json
        } catch {
            Write-Warn "Couldn't parse existing $authFile; overwriting."
            [PSCustomObject]@{}
        }
    } else {
        [PSCustomObject]@{}
    }
    $gpdEntry = [PSCustomObject]@{ type = "api"; key = $key }
    if ($authData.PSObject.Properties.Name -contains "gpd") {
        $authData.gpd = $gpdEntry
    } else {
        $authData | Add-Member -MemberType NoteProperty -Name "gpd" -Value $gpdEntry -Force
    }
    $authData | ConvertTo-Json -Depth 5 | Set-Content -Path $authFile -Encoding UTF8

    # Intentionally NOT writing GPD_API_KEY to the user-scope env var.
    # - Desktop app: reads the key from auth.json (path-matched to opencode
    #   in v1.1.7). No env var needed.
    # - CLI via the `gpd` wrapper: sources litellm.env. No env var needed.
    # - CLI via raw `opencode.exe`: reads auth.json. No env var needed.
    # A User env var would broadcast the key to every process the user
    # ever launches (browser, editors, npm scripts, screen recorders)
    # for zero functional benefit. The -NoExportKey flag is kept as a
    # documented no-op for CLI symmetry with the POSIX installer.
    if (-not $NoExportKey) {
        Write-Log "Key stored in $envFile and auth.json; not exported to user env."
    }

    Write-Success "PSI key saved to $envFile"
}

# ── Git & LaTeX ────────────────────────────────────────────────────────────
#
# Git is required (OpenCode/GPD use it). LaTeX is needed to compile physics
# papers. Both install via winget if present; fallback is a warn-and-skip.

function Test-CommandExists {
    param([string]$Name)
    return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Update-SessionPath {
    # winget installs update the user PATH registry key but not the current
    # session. Re-read so subsequent commands can find the new binaries.
    $user = [Environment]::GetEnvironmentVariable("PATH", "User")
    $machine = [Environment]::GetEnvironmentVariable("PATH", "Machine")
    $env:PATH = "$user;$machine"
}

function Install-Git {
    if (Test-CommandExists "git") {
        Write-Success "git already installed ($(git --version))"
        return
    }

    if (-not (Test-CommandExists "winget")) {
        Write-Warn "git not found and winget unavailable. Install git manually from https://git-scm.com/"
        return
    }

    Write-Log "Installing git via winget..."
    try {
        # --scope user installs per-user (no UAC admin prompt needed).
        # Default scope for Git.Git is machine, which would require admin.
        # Capture stdout+stderr so a non-zero exit gives the user a real
        # diagnostic (previously we piped to Out-Null and failed silently).
        $wingetOut = & winget install --id Git.Git -e --silent --scope user --accept-package-agreements --accept-source-agreements 2>&1
        $wingetExit = $LASTEXITCODE
        Update-SessionPath
        if (Test-CommandExists "git") {
            Write-Success "git installed"
        } elseif ($wingetExit -ne 0) {
            Write-Warn "git install via winget failed (exit $wingetExit):"
            ($wingetOut | Select-Object -Last 15) | ForEach-Object { Write-Warn "  $_" }
        } else {
            Write-Warn "git installed but not on PATH yet -- open a new terminal"
        }
    } catch {
        Write-Warn "git install via winget failed: $_"
    }
}

function Install-LaTeX {
    if (Test-CommandExists "pdflatex") {
        Write-Success "LaTeX already installed"
        return
    }

    if (-not (Test-CommandExists "winget")) {
        Write-Warn "LaTeX not found and winget unavailable."
        Write-Warn "Install MiKTeX manually from https://miktex.org/download"
        return
    }

    Write-Log "Installing MiKTeX via winget (~200MB download, takes several minutes)..."
    try {
        # --scope user installs MiKTeX per-user (no UAC prompt).
        $wingetOut = & winget install --id MiKTeX.MiKTeX -e --silent --scope user --accept-package-agreements --accept-source-agreements 2>&1
        $wingetExit = $LASTEXITCODE
        Update-SessionPath
        if (Test-CommandExists "pdflatex") {
            Write-Success "LaTeX (MiKTeX) installed"
        } elseif ($wingetExit -ne 0) {
            Write-Warn "MiKTeX install via winget failed (exit $wingetExit):"
            ($wingetOut | Select-Object -Last 15) | ForEach-Object { Write-Warn "  $_" }
        } else {
            Write-Warn "MiKTeX installed but not on PATH yet -- open a new terminal"
        }
    } catch {
        Write-Warn "MiKTeX install via winget failed: $_"
        Write-Warn "Install manually from https://miktex.org/download"
    }
}

# ── GPD wrappers ───────────────────────────────────────────────────────────

function New-GpdWrappers {
    # PowerShell wrapper: gpd.ps1
    $ps1Wrapper = Join-Path $GpdBinDir "gpd.ps1"
    $ps1Content = @'
$GpdHome = if ($env:GPD_HOME) { $env:GPD_HOME } else { "$HOME\.gpd" }
$envFile = Join-Path $GpdHome "config\litellm.env"
if (Test-Path $envFile) {
    Get-Content $envFile | ForEach-Object {
        if ($_ -match '^([^#]\S+?)=(.*)$') {
            [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2], 'Process')
        }
    }
}
$env:PATH = "$GpdHome\venv\Scripts;$GpdHome\bin;$env:PATH"
& "$GpdHome\bin\opencode.exe" @args
'@
    Set-Content -Path $ps1Wrapper -Value $ps1Content -Encoding UTF8
    Write-Success "PowerShell wrapper created at $ps1Wrapper"

    # CMD wrapper: gpd.cmd
    $cmdWrapper = Join-Path $GpdBinDir "gpd.cmd"
    $cmdContent = @'
@echo off
set "GPD_HOME=%USERPROFILE%\.gpd"
if exist "%GPD_HOME%\config\litellm.env" (
    for /f "usebackq eol=# tokens=1,* delims==" %%a in ("%GPD_HOME%\config\litellm.env") do (
        if not "%%a"=="" set "%%a=%%b"
    )
)
set "PATH=%GPD_HOME%\venv\Scripts;%GPD_HOME%\bin;%PATH%"
"%GPD_HOME%\bin\opencode.exe" %*
'@
    Set-Content -Path $cmdWrapper -Value $cmdContent -Encoding UTF8
    Write-Success "CMD wrapper created at $cmdWrapper"
}

# ── PATH ───────────────────────────────────────────────────────────────────

function Add-GpdToPath {
    $currentPath = [Environment]::GetEnvironmentVariable("PATH", "User")

    # Check if already present
    if ($currentPath -and $currentPath.Split(";") -contains $GpdBinDir) {
        Write-Success "$GpdBinDir is already on PATH"
        return
    }

    # Add to user PATH
    $newPath = if ($currentPath) { "${GpdBinDir};${currentPath}" } else { $GpdBinDir }
    [Environment]::SetEnvironmentVariable("PATH", $newPath, "User")

    # Also update current session
    $env:PATH = "${GpdBinDir};${env:PATH}"

    Write-Success "Added $GpdBinDir to user PATH"
}

# ── Main install orchestrator ──────────────────────────────────────────────

function Invoke-GpdInstall {
    $arch = Get-Arch

    Write-Banner

    Write-Log "Installing GPD to $GpdHome"
    Write-Log "Platform: windows/${arch}"
    Write-Host ""

    # Pre-flight: abort before touching the python/venv dirs if a GPD
    # process is currently running. Windows file locks on python.exe
    # would turn a later extract step into a mid-install failure with
    # no clean way back to the prior state.
    Test-GpdRunning

    # Create directory structure
    foreach ($dir in @($GpdBinDir, $GpdPythonDir, $GpdVenvDir, $GpdConfigDir)) {
        if (-not (Test-Path $dir)) {
            New-Item -ItemType Directory -Path $dir -Force | Out-Null
        }
    }

    # Step 1: git + LaTeX (install first so later steps see them on PATH)
    Write-Log "Step 1/6: Installing git and LaTeX..."
    Install-Git
    Install-LaTeX
    Write-Host ""

    # Step 2: GPD desktop + CLI binary
    Write-Log "Step 2/6: Installing GPD desktop app and CLI..."
    Install-GpdDesktop -Arch $arch | Out-Null
    Install-OpenCode -Arch $arch
    Write-Host ""

    # Step 3: Python
    Write-Log "Step 3/6: Ensuring Python ${RequiredPythonMajor}.${RequiredPythonMinor}+..."
    $python = Get-Python -Arch $arch
    Write-Host ""

    # Step 4: Venv + GPD package
    Write-Log "Step 4/6: Installing GPD package..."
    New-GpdVenv -PythonPath $python
    Install-Gpd
    # Two-step liveness + import probe. Must pass before we proceed;
    # also gates the .gpd-initialized marker written later.
    Test-GpdInstall
    Write-Host ""

    # PSI key — silent in the default-skip path. Only logs/prompts when
    # $env:GPD_API_KEY is preset or -PromptKey was passed; otherwise we
    # rely on the desktop welcome screen to capture + validate the key
    # on first launch. Removed from the visible step sequence so users
    # don't see a phantom "Configuring PSI key" header that does
    # nothing.
    Read-LiteLlmKey

    # Step 5: Wrapper scripts
    Write-Log "Step 5/6: Creating gpd command..."
    New-GpdWrappers
    Write-Host ""

    # Step 6: PATH
    Write-Log "Step 6/6: Configuring PATH..."
    Add-GpdToPath
    Write-Host ""

    # Run GPD install for OpenCode runtime configuration.
    # Switch to $HOME so gpd's checkout-root detection doesn't walk into
    # system dirs and hit a permission error. "opencode" is a positional
    # runtime arg, not a --opencode flag.
    $gpdExe = Join-Path $GpdVenvDir "Scripts\gpd.exe"
    if (Test-Path $gpdExe) {
        # Recover from "untrusted GPD manifest" state. gpd 1.2.x refuses
        # to install into a config dir that has GPD-managed markers but
        # no `gpd-file-manifest.json`. That state is reached when an
        # earlier GPD install left files behind without writing a
        # manifest, OR when a user wiped %USERPROFILE%\.gpd without
        # running the uninstall script (markers in opencode's config
        # dir survive).
        #
        # The marker policy for opencode is declared in the gpd runtime
        # catalog (`adapters/runtime_catalog.json` ->
        # `runtime_name: "opencode"` ->
        # `managed_install_surface.flat_command_globs:
        # ["command/gpd-*.md"]`). On Windows opencode lives under
        # `$HOME\.config\opencode` per the catalog's `home_subpath`,
        # but `xdg_app` strategy can also resolve to
        # `$HOME\.local\share\opencode` depending on env vars; sweep
        # both candidate paths so whichever is in use is cleaned. Files
        # that don't match these patterns are user-owned and untouched.
        $opencodeCandidates = @(
            (Join-Path $HOME ".config\opencode"),
            (Join-Path $HOME ".local\share\opencode")
        )
        if ($env:OPENCODE_CONFIG_DIR) {
            $opencodeCandidates = @($env:OPENCODE_CONFIG_DIR) + $opencodeCandidates
        }
        foreach ($oc in $opencodeCandidates) {
            if (-not (Test-Path $oc)) { continue }
            $manifest = Join-Path $oc "gpd-file-manifest.json"
            if (Test-Path $manifest) { continue }
            $hasMarker = $false
            foreach ($pat in @("command\gpd-*.md", "agents\gpd-*.md", "hooks\gpd-*")) {
                if (Get-ChildItem -Path (Join-Path $oc $pat) -ErrorAction SilentlyContinue | Select-Object -First 1) {
                    $hasMarker = $true
                    break
                }
            }
            if ($hasMarker -or (Test-Path (Join-Path $oc "get-physics-done"))) {
                Write-Log "Cleaning stale GPD markers in $oc (no manifest, prior install or partial uninstall)..."
                # Patterns mirror runtime_catalog.json + the opencode
                # adapter's deploy paths. If gpd's catalog grows new
                # globs, this list needs updating in lockstep.
                foreach ($pat in @("command\gpd-*.md", "agents\gpd-*.md", "hooks\gpd-*")) {
                    Get-ChildItem -Path (Join-Path $oc $pat) -ErrorAction SilentlyContinue |
                        Where-Object { -not $_.PSIsContainer } |
                        Remove-Item -Force -ErrorAction SilentlyContinue
                }
                Remove-Item -Recurse -Force (Join-Path $oc "get-physics-done") -ErrorAction SilentlyContinue
            }
        }

        Write-Log "Configuring GPD for OpenCode runtime..."
        Push-Location $HOME
        try {
            # Suppress stdout (rich-formatted summary table + "/gpd-help"
            # hint that confuses desktop-first users) but capture both
            # streams so a real failure surfaces last-N lines for debug.
            $runtimeLog = [System.IO.Path]::GetTempFileName()
            try {
                & $gpdExe install opencode --global *> $runtimeLog
                if ($LASTEXITCODE -eq 0) {
                    Write-Success "GPD runtime configured for OpenCode"
                } else {
                    Write-Warn "GPD runtime configuration failed. Last lines:"
                    Get-Content $runtimeLog -Tail 20 | ForEach-Object { Write-Host $_ }
                    Write-Warn "Re-run manually from your home dir:"
                    Write-Warn "  cd ~ ; ~\.gpd\venv\Scripts\gpd.exe install opencode --global"
                }
            } finally {
                Remove-Item -Force $runtimeLog -ErrorAction SilentlyContinue
            }
        }
        catch {
            Write-Warn "GPD runtime configuration failed: $_"
            Write-Warn "Run manually: cd ~ && ~\.gpd\venv\Scripts\gpd.exe install opencode --global"
        }
        finally {
            Pop-Location
        }
    }

    # Write the .gpd-initialized marker so the GPD desktop app's first-run
    # setup short-circuits via is_venv_valid() -- no uv/python/pip cascade
    # of console windows, no ~3 minutes of re-downloading what we just
    # installed. The app looks for this file at $GpdHome\.gpd-initialized
    # (matches the unified path in packages/desktop/src-tauri/src/gpd_setup.rs).
    if ((Test-Path $gpdExe) -or (Test-Path (Join-Path $GpdVenvDir "Scripts\python.exe"))) {
        $marker = Join-Path $GpdHome ".gpd-initialized"
        if (-not (Test-Path $marker)) {
            Set-Content -Path $marker -Value "initialized" -Encoding ASCII
            Write-Success "GPD desktop app will skip first-run setup"
        }
    }

    Write-SuccessBanner

    # ── Auto-launch GPD.exe to work around Windows PATH caching ───────────
    #
    # Problem: git (and LaTeX / MiKTeX) were just installed via winget.
    # winget updates the Machine/User PATH registry values, but Windows
    # Explorer caches its environment at login — so Explorer's PATH does
    # NOT include C:\Program Files\Git\cmd until the user restarts
    # Explorer or reboots. Any app Explorer launches (e.g. GPD from the
    # Start Menu) inherits Explorer's stale PATH and can't find git,
    # which breaks GPD's first-run setup (it shells out to `git` when
    # installing get-physics-done from GitHub).
    #
    # Workaround: launch GPD.exe directly from THIS installer process.
    # Our PATH was refreshed by Update-SessionPath after each winget
    # install, so the child process inherits the correct env. This
    # gives the user a working app immediately without asking them to
    # reboot or manually restart Explorer.
    #
    # Skipped when -SkipLaunch is set or when we're non-interactive
    # (CI / scripted installs often don't want a GUI popping up).
    $gpdExePath = Join-Path $env:LOCALAPPDATA "GPD\GPD.exe"
    if ($SkipLaunch) {
        Write-Log "Skipping auto-launch (-SkipLaunch set)"
    } elseif (-not [Environment]::UserInteractive -or [Console]::IsInputRedirected) {
        # UserInteractive alone is insufficient: PowerShell itself is
        # "interactive" even when launched via `irm | iex`, where stdin is
        # actually redirected from the pipe. CI runners that pipe the
        # installer through would otherwise spawn GPD.exe unexpectedly.
        Write-Log "Skipping auto-launch (non-interactive session)"
    } elseif (Test-Path $gpdExePath) {
        Write-Log "Launching GPD desktop app..."
        try {
            Start-Process -FilePath $gpdExePath
        } catch {
            Write-Warn "Couldn't auto-launch GPD ($_). Open it from the Start menu."
        }
    }
}

# ── Entry point ────────────────────────────────────────────────────────────

Invoke-GpdInstall
