# GPD CLI installer for Windows 11
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File install.ps1
#   irm https://<url>/install/windows_11/install.ps1 | iex
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
    [switch]$NoExportKey
)
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

$GpdPackageRepo    = "psi-oss/get-physics-done"
# Pin to a specific tag rather than a moving branch so installs are
# reproducible: every v1.1.8 installer run fetches the exact same tarball.
$GpdPackageVersion = "v1.1.0"

$LiteLlmProxyUrl = "https://litellm-production-46bb.up.railway.app"

# Python-build-standalone: portable, relocatable CPython builds from Astral.
$PbsTag    = "20250409"
$PbsPython = "3.13.3"
$PbsBaseUrl = "https://github.com/astral-sh/python-build-standalone/releases/download/$PbsTag"

# Pinned SHA256 of each PBS tarball we might download. Verified against
# the file we actually pull over the wire; mismatch aborts the install.
# Regenerate via install-gpd/scripts/verify-pbs-hashes.sh when bumping
# $PbsTag or $PbsPython. Values sourced from upstream SHA256SUMS:
# https://github.com/astral-sh/python-build-standalone/releases/download/20250409/SHA256SUMS
#
# NB: upstream does not publish an aarch64-pc-windows-msvc build for the
# 20250409 tag, so there is no entry for that triple. Install-LocalPython
# already calls Stop-WithError for unsupported arches earlier.
$PbsSha256 = @{
    "x86_64-pc-windows-msvc" = "6012f9b1530d5cb45fd59b116e24b35ad51d7c957d119b60b5fefff4b2a60977"
}

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
    exit 1
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
    Write-Host ""
    Write-Success "GPD installed successfully!"
    Write-Host ""
    Write-Host "  Start a new session:  " -NoNewline
    Write-Host "gpd" -ForegroundColor White
    Write-Host "  Show help:            " -NoNewline
    Write-Host "gpd --help" -ForegroundColor White
    Write-Host ""
    Write-Host "  Installation directory: $GpdHome" -ForegroundColor DarkGray
    Write-Host ""
    Write-Warn "Open a new terminal (or run 'refreshenv') to use the gpd command."
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
    # Pre-flight: abort if GPD is currently running under $GpdHome. Windows
    # file locking would make in-place overwrites of python.exe / venv
    # scripts fail with cryptic "access denied" errors mid-install. Better
    # to bail early with a clear message so the user can quit the app
    # first.
    try {
        $running = Get-Process -ErrorAction SilentlyContinue | Where-Object {
            $_.Path -and $_.Path.StartsWith($GpdHome, [System.StringComparison]::OrdinalIgnoreCase)
        }
        if ($running) {
            Stop-WithError "Detected a running GPD process. Quit GPD before running the installer again."
        }
    } catch {
        # Non-fatal: some processes deny access to .Path (e.g. protected
        # services). We're only trying to catch GPD itself, which we own,
        # so access denials on unrelated processes are expected.
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

    if ($Arch -ne "x64") {
        Write-Warn "GPD desktop .exe only available for x64 - skipping."
        return $false
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
    $setupFile = "GPD_" + $ver + "_x64-setup.exe"
    $setupUrl = "https://github.com/$OpenCodeOrg/$OpenCodeRepo/releases/download/$tag/$setupFile"

    if (-not (Test-UrlExists $setupUrl)) {
        Write-Warn "GPD desktop .exe not found at $setupUrl"
        return $false
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

    $asset = "opencode-windows-${Arch}.zip"
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

function Install-LocalPython {
    param([string]$Arch)

    $pythonBin = Join-Path $GpdPythonDir "python.exe"

    if ((Test-Path $pythonBin) -and (Test-PythonVersionOk $pythonBin)) {
        Write-Success "App-local Python already installed at $GpdPythonDir"
        return $pythonBin
    }

    # Map architecture to python-build-standalone triple
    $triple = switch ($Arch) {
        "x64"   { "x86_64-pc-windows-msvc" }
        "arm64" { "aarch64-pc-windows-msvc" }
        default { Stop-WithError "No python-build-standalone build for windows/${Arch}" }
    }

    $filename = "cpython-${PbsPython}+${PbsTag}-${triple}-install_only.tar.gz"
    $url = "${PbsBaseUrl}/${filename}"

    Write-Log "Downloading Python ${PbsPython} (app-local, not system-wide)..."

    $tmpDir = Join-Path ([System.IO.Path]::GetTempPath()) "gpd-python-$(Get-Random)"
    New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null

    # Atomic extract targets — we stage into .new, verify, then swap.
    # Never touch the existing $GpdPythonDir until the new tree is
    # proven runnable. If anything fails, roll back to .old (or leave
    # the old tree in place if it exists).
    $newDir = "$GpdPythonDir.new"
    $oldDir = "$GpdPythonDir.old"
    if (Test-Path $newDir) { Remove-Item -Path $newDir -Recurse -Force }
    if (Test-Path $oldDir) { Remove-Item -Path $oldDir -Recurse -Force }
    New-Item -ItemType Directory -Path $newDir -Force | Out-Null

    try {
        $archive = Join-Path $tmpDir $filename
        Invoke-Download -Url $url -Destination $archive

        # SHA256 pin check BEFORE we invest any time in extraction.
        # Mismatch aborts before we touch the live tree.
        $expected = $PbsSha256[$triple]
        if (-not $expected) {
            Remove-Item -Path $newDir -Recurse -Force -ErrorAction SilentlyContinue
            Stop-WithError "No PBS SHA256 pin for triple '$triple'. Update `$PbsSha256."
        }
        if (-not (Test-FileSha256 -Path $archive -Expected $expected)) {
            Remove-Item -Path $newDir -Recurse -Force -ErrorAction SilentlyContinue
            Stop-WithError "PBS checksum mismatch -- suspected tampering or stale pin. Aborting."
        }

        Write-Log "Extracting Python to $newDir..."

        # Use tar (available on Windows 10+) to extract .tar.gz
        $tarAvailable = Get-Command "tar" -ErrorAction SilentlyContinue
        if ($tarAvailable) {
            & tar -xzf $archive -C $newDir --strip-components=1
            if ($LASTEXITCODE -ne 0) {
                Remove-Item -Path $newDir -Recurse -Force -ErrorAction SilentlyContinue
                Stop-WithError "Python extract failed"
            }
        }
        else {
            # Fallback: decompress gzip then extract tar using .NET
            Write-Log "tar not found, using .NET extraction fallback..."

            $tarFile = Join-Path $tmpDir "python.tar"

            # Decompress gzip
            $gzipStream = [System.IO.File]::OpenRead($archive)
            $decompStream = New-Object System.IO.Compression.GZipStream($gzipStream, [System.IO.Compression.CompressionMode]::Decompress)
            $tarStream = [System.IO.File]::Create($tarFile)
            $decompStream.CopyTo($tarStream)
            $tarStream.Close()
            $decompStream.Close()
            $gzipStream.Close()

            # Extract tar -- minimal tar reader for install_only archives
            # These archives have a single top-level directory (python/) that we strip
            $stream = [System.IO.File]::OpenRead($tarFile)
            $buffer = New-Object byte[] 512
            while ($true) {
                $read = $stream.Read($buffer, 0, 512)
                if ($read -lt 512) { break }

                # Check for end-of-archive (two 512-byte blocks of zeros)
                $allZero = $true
                for ($i = 0; $i -lt 512; $i++) {
                    if ($buffer[$i] -ne 0) { $allZero = $false; break }
                }
                if ($allZero) { break }

                # Parse header: name at offset 0 (100 bytes), size at offset 124 (12 bytes), typeflag at offset 156
                $nameBytes = $buffer[0..99]
                $nameEnd = [Array]::IndexOf($nameBytes, [byte]0)
                if ($nameEnd -lt 0) { $nameEnd = 100 }
                $name = [System.Text.Encoding]::ASCII.GetString($nameBytes, 0, $nameEnd).Trim()

                $sizeStr = [System.Text.Encoding]::ASCII.GetString($buffer[124..135]).Trim().TrimEnd([char]0)
                $size = if ($sizeStr) { [Convert]::ToInt64($sizeStr, 8) } else { 0 }

                $typeFlag = [char]$buffer[156]

                # Strip first path component (e.g., "python/")
                $strippedName = $name
                $slashIdx = $name.IndexOf("/")
                if ($slashIdx -ge 0) {
                    $strippedName = $name.Substring($slashIdx + 1)
                }
                else {
                    # Top-level entry with no slash -- skip
                    $blocks = [math]::Ceiling($size / 512)
                    if ($blocks -gt 0) { [void]$stream.Seek($blocks * 512, [System.IO.SeekOrigin]::Current) }
                    continue
                }

                if ([string]::IsNullOrWhiteSpace($strippedName)) {
                    $blocks = [math]::Ceiling($size / 512)
                    if ($blocks -gt 0) { [void]$stream.Seek($blocks * 512, [System.IO.SeekOrigin]::Current) }
                    continue
                }

                # Zip-slip guard: reject any `..` or empty segment in the
                # archive's stripped entry path BEFORE we Join-Path, then
                # re-check that the resolved absolute path still lives
                # inside $newDir. Defense in depth for the case where the
                # SHA256 pin drifts away from a known-good PBS archive.
                $entrySegments = $strippedName -split '[/\\]'
                foreach ($seg in $entrySegments) {
                    if ($seg -eq ".." -or $seg -eq "") {
                        Remove-Item -Path $newDir -Recurse -Force -ErrorAction SilentlyContinue
                        Stop-WithError "Refusing to extract archive entry with traversal segment: $strippedName"
                    }
                }

                $outPath = Join-Path $newDir $strippedName.Replace("/", "\")
                $newDirFull = [System.IO.Path]::GetFullPath($newDir)
                $outPathFull = [System.IO.Path]::GetFullPath($outPath)
                $newDirWithSep = $newDirFull.TrimEnd('\','/') + [System.IO.Path]::DirectorySeparatorChar
                if (-not (
                    $outPathFull.Equals($newDirFull, [System.StringComparison]::OrdinalIgnoreCase) -or
                    $outPathFull.StartsWith($newDirWithSep, [System.StringComparison]::OrdinalIgnoreCase)
                )) {
                    Remove-Item -Path $newDir -Recurse -Force -ErrorAction SilentlyContinue
                    Stop-WithError "Refusing to extract archive entry outside target dir: $strippedName"
                }

                if ($typeFlag -eq "5" -or $name.EndsWith("/")) {
                    # Directory
                    New-Item -ItemType Directory -Path $outPath -Force | Out-Null
                }
                elseif ($typeFlag -eq "0" -or $typeFlag -eq [char]0) {
                    # Regular file
                    $parentDir = Split-Path $outPath -Parent
                    if (-not (Test-Path $parentDir)) {
                        New-Item -ItemType Directory -Path $parentDir -Force | Out-Null
                    }

                    $fileStream = [System.IO.File]::Create($outPath)
                    $remaining = $size
                    $readBuf = New-Object byte[] 65536
                    while ($remaining -gt 0) {
                        $toRead = [math]::Min($remaining, 65536)
                        $bytesRead = $stream.Read($readBuf, 0, $toRead)
                        $fileStream.Write($readBuf, 0, $bytesRead)
                        $remaining -= $bytesRead
                    }
                    $fileStream.Close()

                    # Skip padding to next 512-byte boundary
                    $pad = (512 - ($size % 512)) % 512
                    if ($pad -gt 0) { [void]$stream.Seek($pad, [System.IO.SeekOrigin]::Current) }
                    continue
                }

                # Skip data blocks for this entry
                $blocks = [math]::Ceiling($size / 512)
                if ($blocks -gt 0) { [void]$stream.Seek($blocks * 512, [System.IO.SeekOrigin]::Current) }
            }
            $stream.Close()
        }

        # Liveness probe against the staged tree before we swap it into
        # place. Catches wrong-arch archives, missing CRT DLLs, etc.
        $newPython = Join-Path $newDir "python.exe"
        if (-not (Test-Path $newPython)) {
            Remove-Item -Path $newDir -Recurse -Force -ErrorAction SilentlyContinue
            Stop-WithError "Python extract failed -- $newPython not found"
        }
        # Liveness probe: `-c "pass"` is a minimal valid Python program.
        # We can't use `-c ""` here because PowerShell 5.1 strips
        # empty-string args before passing them to native commands, so
        # python would see `-c` with no value and error out.
        & $newPython -c "pass" 2>$null | Out-Null
        if ($LASTEXITCODE -ne 0) {
            Remove-Item -Path $newDir -Recurse -Force -ErrorAction SilentlyContinue
            Stop-WithError "Extracted Python is not runnable"
        }

        # Swap: move old aside, then new into place. Roll back to the old
        # tree if the move fails so the user isn't left with no Python.
        if (Test-Path $GpdPythonDir) {
            Move-Item -Path $GpdPythonDir -Destination $oldDir -Force
        }
        try {
            Move-Item -Path $newDir -Destination $GpdPythonDir -Force
        } catch {
            if (Test-Path $oldDir) {
                Move-Item -Path $oldDir -Destination $GpdPythonDir -Force -ErrorAction SilentlyContinue
            }
            Stop-WithError "Python swap failed: $_"
        }
        if (Test-Path $oldDir) {
            Remove-Item -Path $oldDir -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
    finally {
        Remove-Item -Path $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
    }

    if (-not (Test-Path $pythonBin)) {
        Stop-WithError "Python extraction failed -- $pythonBin not found"
    }

    Write-Success "Python ${PbsPython} installed to $GpdPythonDir"
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

    $venvPython = Join-Path $GpdVenvDir "Scripts\python.exe"
    if (Test-Path $venvPython) {
        Write-Success "Python venv already exists at $GpdVenvDir"
        return
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

    # Pinned to a tagged release so every installer run fetches the same
    # tarball. Bump $GpdPackageVersion when cutting a new release.
    $sourceUrl = "https://github.com/${GpdPackageRepo}/archive/refs/tags/${GpdPackageVersion}.tar.gz"

    # Pre-flight: fail loudly with a GPD-specific message if the tag was
    # deleted upstream, rather than letting pip swallow the 404.
    if (-not (Test-UrlExists $sourceUrl)) {
        Stop-WithError "GPD package tag $GpdPackageVersion not found -- aborting."
    }

    Write-Log "Installing get-physics-done $GpdPackageVersion from GitHub..."
    & $venvPip install --upgrade --quiet $sourceUrl
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

    Write-Host ""
    Write-Host "  PSI API Key Configuration" -ForegroundColor White
    Write-Host "  Your PSI key connects GPD to AI models." -ForegroundColor DarkGray
    Write-Host "  Get your key from your lab administrator." -ForegroundColor DarkGray
    Write-Host ""

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
        if (-not [Environment]::UserInteractive -or [Console]::IsInputRedirected) {
            Write-Warn "Non-interactive session and GPD_API_KEY not set -- skipping key configuration."
            Write-Warn "Set `$env:GPD_API_KEY and re-run, or run interactively to be prompted."
            return
        }
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
    Write-Log "Step 1/7: Installing git and LaTeX..."
    Install-Git
    Install-LaTeX
    Write-Host ""

    # Step 2: GPD desktop + CLI binary
    Write-Log "Step 2/7: Installing GPD desktop app and CLI..."
    Install-GpdDesktop -Arch $arch | Out-Null
    Install-OpenCode -Arch $arch
    Write-Host ""

    # Step 3: Python
    Write-Log "Step 3/7: Ensuring Python ${RequiredPythonMajor}.${RequiredPythonMinor}+..."
    $python = Get-Python -Arch $arch
    Write-Host ""

    # Step 4: Venv + GPD package
    Write-Log "Step 4/7: Installing GPD package..."
    New-GpdVenv -PythonPath $python
    Install-Gpd
    # Two-step liveness + import probe. Must pass before we proceed;
    # also gates the .gpd-initialized marker written later.
    Test-GpdInstall
    Write-Host ""

    # Step 5: PSI key
    Write-Log "Step 5/7: Configuring PSI key..."
    Read-LiteLlmKey
    Write-Host ""

    # Step 6: Wrapper scripts
    Write-Log "Step 6/7: Creating gpd command..."
    New-GpdWrappers
    Write-Host ""

    # Step 7: PATH
    Write-Log "Step 7/7: Configuring PATH..."
    Add-GpdToPath
    Write-Host ""

    # Run GPD install for OpenCode runtime configuration.
    # Switch to $HOME so gpd's checkout-root detection doesn't walk into
    # system dirs and hit a permission error. "opencode" is a positional
    # runtime arg, not a --opencode flag.
    $gpdExe = Join-Path $GpdVenvDir "Scripts\gpd.exe"
    if (Test-Path $gpdExe) {
        Write-Log "Configuring GPD for OpenCode runtime..."
        Push-Location $HOME
        try {
            # --skip-readiness-check was added to gpd.cli on main AFTER the
            # v1.1.0 tag our installer pins to. Don't pass it; bump back in
            # once get-physics-done cuts v1.2.0+.
            & $gpdExe install opencode --global
            if ($LASTEXITCODE -ne 0) {
                Write-Warn "GPD runtime configuration failed. Run manually from your home dir:"
                Write-Warn "  cd ~ && ~\.gpd\venv\Scripts\gpd.exe install opencode --global"
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
