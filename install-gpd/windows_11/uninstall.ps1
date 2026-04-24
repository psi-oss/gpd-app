# GPD CLI uninstaller for Windows 11
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File uninstall.ps1
#   powershell -ExecutionPolicy Bypass -File uninstall.ps1 -Yes
#
# Removes everything created by install.ps1:
#   - $HOME\.gpd\ directory (bin, python, venv, config)
#   - User PATH entry pointing to .gpd\bin (registry split-and-filter;
#     no sentinel handling -- sentinel blocks are POSIX rc-file only)
#   - GPD desktop app (runs Tauri NSIS uninstaller silently)
#   - Tauri GUI state at %APPDATA%\inc.psi.gpd\
#   - Tauri WebView data (localStorage/cookies/cache) at %LOCALAPPDATA%\inc.psi.gpd\
#   - "gpd" entry in auth.json under .local\share\opencode and the legacy
#     %APPDATA%\opencode path (preserving other providers)
#   - "gpd" provider in opencode.json (preserving other providers)
#   - Files listed in gpd-file-manifest.json and the manifest itself
#
# Does NOT remove:
#   - The rest of opencode's config/data dir (other providers' auth,
#     chat history, custom prompts stay put).
#   - Git or MiKTeX -- many things depend on them. Instructions for
#     manual removal are printed at the end.
#
# POSIX note: AC-3 (sentinel-bracketed rc-file block removal) applies to
# the bash uninstallers only. Windows stores PATH in the registry, so
# Remove-GpdFromPath does a direct split-and-filter -- see that function.

#Requires -Version 5.1
[CmdletBinding()]
param(
    [switch]$Yes
)

$ErrorActionPreference = "Stop"

# -- Configuration ---------------------------------------------------------

$GpdHome   = if ($env:GPD_HOME) { $env:GPD_HOME } else { Join-Path $HOME ".gpd" }
$GpdBinDir = Join-Path $GpdHome "bin"

# Tauri NSIS installs to %LOCALAPPDATA%\GPD\ by default (NOT the Electron
# convention of %LOCALAPPDATA%\Programs\GPD\). Verified via HKCU Uninstall
# key on a fresh install — InstallLocation reports AppData\Local\GPD.
$TauriInstallDir = Join-Path $env:LOCALAPPDATA "GPD"
$TauriUninstaller = Join-Path $TauriInstallDir "uninstall.exe"

$TauriStateDir = Join-Path $env:APPDATA "inc.psi.gpd"

# Tauri on Windows stores WebView2 data (localStorage incl. the
# "gpd.key.saved" flag, cookies, cache, IndexedDB) under LocalAppData.
# Without wiping this, a reinstall keeps the previous run's
# "already-onboarded" signal and the GUI skips its own welcome -- which
# looks like a bug to users re-testing after an uninstall.
$TauriWebViewDir = Join-Path $env:LOCALAPPDATA "inc.psi.gpd"

# opencode uses xdg-basedir v5 which ignores platform and always
# resolves xdgData to "$HOME/.local/share" — so on Windows auth.json
# lives at %USERPROFILE%\.local\share\opencode\auth.json, NOT under
# %APPDATA%. Match the installer's path exactly.
$XdgData    = if ($env:XDG_DATA_HOME) { $env:XDG_DATA_HOME } else { Join-Path $HOME ".local\share" }
$OpenCodeDir = Join-Path $XdgData "opencode"
$AuthFile    = Join-Path $OpenCodeDir "auth.json"

# Legacy path: previous installer versions wrote auth.json to
# %APPDATA%\opencode\auth.json. Clean that up too if present.
$LegacyOpenCodeDir = Join-Path $env:APPDATA "opencode"
$LegacyAuthFile    = Join-Path $LegacyOpenCodeDir "auth.json"

# We intentionally do NOT clean up opencode's state/cache dirs
# (%XDG_STATE_HOME%\opencode, %XDG_CACHE_HOME%\opencode, etc.): users
# who also run plain opencode have chat history and session state there.
# Surgical cleanup only (see Remove-OpenCodeGpdFiles).

# Files in the opencode config dir that are gpd-specific and safe to remove.
$GpdManifestFile = Join-Path $OpenCodeDir "gpd-file-manifest.json"
$OpenCodeJson    = Join-Path $OpenCodeDir "opencode.json"

# -- Logging ---------------------------------------------------------------

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

function Write-Skip {
    param([string]$Message)
    Write-Host "  - " -ForegroundColor DarkGray -NoNewline
    Write-Host $Message -ForegroundColor DarkGray
}

# -- Banner ----------------------------------------------------------------

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
    Write-Host " -- CLI Uninstaller" -ForegroundColor DarkGray
    Write-Host ""
}

# -- Discovery -------------------------------------------------------------

function Get-PathContainsGpd {
    # Discovery-pass check. Read the registry with raw (unexpanded) values
    # so the body matches whatever form the actual removal path uses.
    # Previously used [Environment]::GetEnvironmentVariable which expands
    # env-var references — that read + exact-compare-against-expanded-
    # $GpdBinDir happened to work for the literal case but silently
    # missed an env-var form we would then fail to actually remove.
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey("Environment", $false)
    if (-not $key) { return $false }
    try {
        $raw = [string]$key.GetValue("Path", "", [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    } finally {
        $key.Close()
    }
    if (-not $raw) { return $false }
    foreach ($p in $raw.Split(";")) {
        if (Test-PathPartMatchesGpdBin -Entry $p -Target $GpdBinDir) {
            return $true
        }
    }
    return $false
}

# Inspect auth.json and decide whether the "gpd" entry is present. Returns
# $true if at least one key needs to be removed, $false otherwise.
function Test-AuthHasGpd {
    foreach ($candidate in @($AuthFile, $LegacyAuthFile)) {
        if (-not (Test-Path $candidate)) { continue }
        try {
            $data = Get-Content $candidate -Raw | ConvertFrom-Json
        } catch {
            continue
        }
        if ($null -eq $data) { continue }
        $names = @()
        $data.PSObject.Properties | ForEach-Object { $names += $_.Name }
        if ($names -contains "gpd") { return $true }
    }
    return $false
}

# Does opencode.json reference the gpd provider in any way that the
# uninstaller will touch? Used purely as a "found" signal for the
# discovery banner.
function Test-OpenCodeJsonHasGpd {
    if (-not (Test-Path $OpenCodeJson)) { return $false }
    try {
        $data = Get-Content $OpenCodeJson -Raw | ConvertFrom-Json
    } catch {
        return $false
    }
    if ($null -eq $data) { return $false }

    $provider = $data.PSObject.Properties | Where-Object { $_.Name -eq "provider" }
    if ($provider -and $provider.Value) {
        $names = @()
        $provider.Value.PSObject.Properties | ForEach-Object { $names += $_.Name }
        if ($names -contains "gpd") { return $true }
    }
    if ($data.PSObject.Properties.Name -contains "model" `
        -and $data.model -is [string] -and $data.model.StartsWith("gpd/")) {
        return $true
    }
    if ($data.PSObject.Properties.Name -contains "enabled_providers" `
        -and $data.enabled_providers -is [array] -and $data.enabled_providers -contains "gpd") {
        return $true
    }
    return $false
}

# -- Removal actions -------------------------------------------------------

function Remove-TauriDesktop {
    if (Test-Path $TauriUninstaller) {
        Write-Log "Running GPD desktop uninstaller..."
        try {
            $proc = Start-Process -FilePath $TauriUninstaller `
                -ArgumentList "/S" -Wait -PassThru
            if ($proc.ExitCode -ne 0) {
                Write-Warn "Desktop uninstaller exit code $($proc.ExitCode)"
            } else {
                Write-Success "GPD desktop app uninstalled"
            }
        } catch {
            Write-Warn "Failed to run desktop uninstaller: $_"
        }

        # Clean up the install dir if the uninstaller left it behind.
        if (Test-Path $TauriInstallDir) {
            try {
                Remove-Item -Path $TauriInstallDir -Recurse -Force -ErrorAction Stop
                Write-Success "Removed leftover $TauriInstallDir"
            } catch {
                Write-Warn "Could not remove $TauriInstallDir -- $_"
            }
        }
    }
    elseif (Test-Path $TauriInstallDir) {
        # Install dir exists but no uninstaller.exe -- just wipe it.
        Write-Log "Removing GPD desktop install directory (no uninstaller found)..."
        try {
            Remove-Item -Path $TauriInstallDir -Recurse -Force -ErrorAction Stop
            Write-Success "Removed $TauriInstallDir"
        } catch {
            Write-Warn "Could not remove $TauriInstallDir -- $_"
        }
    }
    else {
        Write-Skip "GPD desktop app not installed"
    }
}

function Remove-TauriState {
    if (Test-Path $TauriStateDir) {
        try {
            Remove-Item -Path $TauriStateDir -Recurse -Force -ErrorAction Stop
            Write-Success "Removed Tauri state dir $TauriStateDir"
        } catch {
            Write-Warn "Could not remove $TauriStateDir -- $_"
        }
    } else {
        Write-Skip "No Tauri state dir at $TauriStateDir"
    }

    # WebView2 data dir (localStorage, cookies, cache) — see explanation
    # where $TauriWebViewDir is declared.
    if (Test-Path $TauriWebViewDir) {
        try {
            Remove-Item -Path $TauriWebViewDir -Recurse -Force -ErrorAction Stop
            Write-Success "Removed Tauri WebView data $TauriWebViewDir"
        } catch {
            Write-Warn "Could not remove $TauriWebViewDir -- $_"
        }
    } else {
        Write-Skip "No Tauri WebView data at $TauriWebViewDir"
    }
}

function Get-UserPathRaw {
    # Match the installer's helper: read User PATH with %VAR% references
    # preserved. Using [Environment]::GetEnvironmentVariable here would
    # expand them, and then the SetEnvironmentVariable write below would
    # persist the expansion, flattening unrelated user entries like
    # %JAVA_HOME%\bin on every uninstall.
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey("Environment", $false)
    if (-not $key) { return "" }
    try {
        $raw = $key.GetValue("Path", "", [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
        return [string]$raw
    } finally {
        $key.Close()
    }
}

function Set-UserPathExpandable {
    param([Parameter(Mandatory=$true)][string]$Value)
    # Write as REG_EXPAND_SZ so %VAR% references we preserved above stay
    # intact. Broadcast WM_SETTINGCHANGE so open terminals refresh
    # without logoff.
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey("Environment", $true)
    try {
        $key.SetValue("Path", $Value, [Microsoft.Win32.RegistryValueKind]::ExpandString)
    } finally {
        $key.Close()
    }
    try {
        $sig = '[DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Auto)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);'
        $type = Add-Type -MemberDefinition $sig -Name NativeMethods -Namespace GpdUninstaller -PassThru -ErrorAction Stop
        $HWND_BROADCAST = [IntPtr]0xffff
        $WM_SETTINGCHANGE = 0x001A
        $SMTO_ABORTIFHUNG = 0x0002
        [UIntPtr]$result = [UIntPtr]::Zero
        [void]$type::SendMessageTimeout($HWND_BROADCAST, $WM_SETTINGCHANGE, [UIntPtr]::Zero, "Environment", $SMTO_ABORTIFHUNG, 5000, [ref]$result)
    } catch { }
}

function Test-PathPartMatchesGpdBin {
    # Mirror of the helper in install.ps1. Compare a PATH entry against
    # $GpdBinDir by expanding env vars in the entry, trimming trailing
    # separators, and doing a case-insensitive compare. This catches
    # both literal ("C:\Users\x\.gpd\bin") and env-var ("%USERPROFILE%
    # \.gpd\bin") forms — a prior installer version or a user hand-edit
    # might have written the entry in either form.
    param([string]$Entry, [string]$Target)
    if ([string]::IsNullOrEmpty($Entry)) { return $false }
    $expanded = [Environment]::ExpandEnvironmentVariables($Entry)
    return ($expanded.TrimEnd('\','/') -ieq $Target.TrimEnd('\','/'))
}

function Remove-GpdFromPath {
    $currentPath = Get-UserPathRaw
    if (-not $currentPath) {
        Write-Skip "User PATH is empty"
        return
    }

    $parts = $currentPath.Split(";")
    $present = $false
    foreach ($p in $parts) {
        if (Test-PathPartMatchesGpdBin -Entry $p -Target $GpdBinDir) {
            $present = $true
            break
        }
    }
    if (-not $present) {
        Write-Skip "$GpdBinDir not on user PATH"
        return
    }

    # Keep the RAW value of each non-matching part so pre-existing
    # env-var references like `%JAVA_HOME%\bin` survive verbatim.
    $newParts = $parts | Where-Object {
        $_ -and -not (Test-PathPartMatchesGpdBin -Entry $_ -Target $GpdBinDir)
    }
    $newPath = ($newParts -join ";")

    try {
        Set-UserPathExpandable -Value $newPath
        Write-Success "Removed $GpdBinDir from user PATH"
    } catch {
        Write-Warn "Could not update user PATH -- $_"
    }

    # Also update this session so the caller sees the change immediately.
    $sessionParts = $env:PATH.Split(";") | Where-Object {
        $_ -and -not (Test-PathPartMatchesGpdBin -Entry $_ -Target $GpdBinDir)
    }
    $env:PATH = ($sessionParts -join ";")
}

function Remove-AuthJsonGpdEntry {
    param([string]$Path)

    if (-not (Test-Path $Path)) {
        Write-Skip "No auth.json at $Path"
        return
    }

    try {
        $data = Get-Content $Path -Raw | ConvertFrom-Json
    } catch {
        Write-Warn "Could not parse $Path -- leaving alone"
        return
    }

    if ($null -eq $data) {
        Write-Skip "auth.json is empty"
        return
    }

    $hasGpd = $false
    $data.PSObject.Properties | ForEach-Object {
        if ($_.Name -eq "gpd") { $hasGpd = $true }
    }

    if (-not $hasGpd) {
        Write-Skip "auth.json has no 'gpd' entry"
        return
    }

    # Strip the "gpd" property in-place on the PSCustomObject. We do NOT
    # copy values into a hashtable — PS 5.1's ConvertTo-Json emits any
    # hashtable value that happens to be a PSCustomObject as the string
    # "@{type=api; key=...}" rather than nested JSON, silently corrupting
    # other providers' auth entries (bug found during Windows installer
    # review, 2026-04-21).
    $data.PSObject.Properties.Remove("gpd")
    $remaining = @($data.PSObject.Properties).Count

    try {
        if ($remaining -eq 0) {
            # If that was the only provider, write an empty object rather
            # than deleting the file -- opencode expects auth.json to exist
            # (or be absent entirely; we err on the side of "no surprise").
            "{}" | Set-Content -Path $Path -Encoding UTF8
        } else {
            $data | ConvertTo-Json -Depth 5 | Set-Content -Path $Path -Encoding UTF8
        }
        Write-Success "Removed 'gpd' entry from $Path"
    } catch {
        Write-Warn "Could not rewrite $Path -- $_"
    }
}

# Guard against manifest path traversal. We treat manifest entries as
# untrusted input even though the installer writes them: a corrupted or
# malicious manifest with entries like "..\..\..\Users\victim\..." or an
# absolute path outside the allowlist would let us Remove-Item arbitrary
# user files. Resolves the target via [System.IO.Path]::GetFullPath and
# requires it to start with one of the allowed prefixes (case-insensitive
# ordinal, per Windows filesystem rules). `..` segments are refused
# up-front before any path joining.
function Test-SafeManifestPath {
    param(
        [Parameter(Mandatory=$true)][string]$Target,
        [Parameter(Mandatory=$true)][string[]]$AllowPrefixes
    )
    # Reject entries containing a `..` path segment.
    $segments = $Target -split '[/\\]'
    foreach ($seg in $segments) {
        if ($seg -eq "..") { return $false }
    }
    $resolved = $null
    try {
        $resolved = [System.IO.Path]::GetFullPath($Target)
    } catch {
        return $false
    }
    foreach ($prefix in $AllowPrefixes) {
        if (-not $prefix) { continue }
        $prefixResolved = $null
        try {
            $prefixResolved = [System.IO.Path]::GetFullPath($prefix)
        } catch {
            continue
        }
        if ($resolved.Equals($prefixResolved, [System.StringComparison]::OrdinalIgnoreCase)) {
            return $true
        }
        $withSep = $prefixResolved.TrimEnd('\','/') + [System.IO.Path]::DirectorySeparatorChar
        if ($resolved.StartsWith($withSep, [System.StringComparison]::OrdinalIgnoreCase)) {
            return $true
        }
    }
    return $false
}

# AC-9: iterate gpd-file-manifest.json and remove each listed file.
# Accepts either a top-level {"files": [...]} or a bare array of paths.
# Relative paths resolve against the manifest's parent dir. Unparseable
# manifests produce a warning, remove the manifest itself, and move on.
function Invoke-GpdManifestRemoval {
    param([string]$ManifestPath)

    if (-not (Test-Path $ManifestPath)) {
        Write-Skip "No gpd-file-manifest.json at $ManifestPath"
        return
    }

    $baseDir = Split-Path -Parent $ManifestPath
    $entries = @()

    try {
        $data = Get-Content $ManifestPath -Raw | ConvertFrom-Json
    } catch {
        Write-Warn "Could not parse $ManifestPath -- leaving listed files in place"
        try {
            Remove-Item -Path $ManifestPath -Force -ErrorAction Stop
            Write-Success "Removed $ManifestPath"
        } catch {
            Write-Warn "Could not remove $ManifestPath -- $_"
        }
        return
    }

    if ($null -eq $data) {
        # Empty manifest -- nothing to iterate, just remove the file.
        try {
            Remove-Item -Path $ManifestPath -Force -ErrorAction Stop
            Write-Success "Removed $ManifestPath (empty)"
        } catch {
            Write-Warn "Could not remove $ManifestPath -- $_"
        }
        return
    }

    if ($data -is [array]) {
        $entries = $data
    } elseif ($data.PSObject.Properties.Name -contains "files") {
        $entries = $data.files
    }

    # Allowlist: every manifest entry must resolve to a path inside one
    # of these prefixes. Anything outside is treated as a manifest-
    # traversal attack (or a dangerous manifest we won't honor) and is
    # skipped with a warning.
    $allowPrefixes = @($baseDir, $GpdHome, $OpenCodeDir) | Where-Object { $_ }

    $missing = 0
    foreach ($entry in $entries) {
        if (-not ($entry -is [string]) -or [string]::IsNullOrWhiteSpace($entry)) {
            continue
        }
        $target = if ([System.IO.Path]::IsPathRooted($entry)) {
            $entry
        } else {
            Join-Path $baseDir $entry
        }
        if (-not (Test-SafeManifestPath -Target $target -AllowPrefixes $allowPrefixes)) {
            Write-Warn "Refusing to remove manifest entry outside allowed dirs: $target"
            continue
        }
        if (Test-Path $target) {
            try {
                Remove-Item -Path $target -Force -Recurse -ErrorAction Stop
                Write-Success "Removed manifest file: $target"
            } catch {
                Write-Warn "Could not remove manifest file: $target -- $_"
            }
        } else {
            $missing++
        }
    }

    if ($missing -gt 0) {
        Write-Skip "$missing manifest entry(ies) already gone"
    }

    try {
        Remove-Item -Path $ManifestPath -Force -ErrorAction Stop
        Write-Success "Removed $ManifestPath"
    } catch {
        Write-Warn "Could not remove $ManifestPath -- $_"
    }
}

# AC-10: strip `provider.gpd` from opencode.json, keep everything else.
# If `provider` becomes empty, drop the key. If the whole object becomes
# {}, delete the file. Non-JSON content produces a warning and is left
# alone.
function Remove-OpenCodeJsonGpdEntry {
    if (-not (Test-Path $OpenCodeJson)) {
        Write-Skip "No opencode.json at $OpenCodeJson"
        return
    }

    try {
        $data = Get-Content $OpenCodeJson -Raw | ConvertFrom-Json
    } catch {
        Write-Warn "Could not parse $OpenCodeJson -- leaving alone"
        return
    }
    if ($null -eq $data) {
        Write-Skip "opencode.json is empty"
        return
    }

    $changed = $false

    # provider.gpd
    $providerProp = $data.PSObject.Properties | Where-Object { $_.Name -eq "provider" }
    if ($providerProp -and $providerProp.Value) {
        $hasGpd = $false
        $providerProp.Value.PSObject.Properties | ForEach-Object {
            if ($_.Name -eq "gpd") { $hasGpd = $true }
        }
        if ($hasGpd) {
            $providerProp.Value.PSObject.Properties.Remove("gpd")
            $changed = $true
            $remainingProviders = @($providerProp.Value.PSObject.Properties).Count
            if ($remainingProviders -eq 0) {
                $data.PSObject.Properties.Remove("provider")
            }
        }
    }

    # top-level model pointing at gpd/*
    if ($data.PSObject.Properties.Name -contains "model" `
        -and $data.model -is [string] -and $data.model.StartsWith("gpd/")) {
        $data.PSObject.Properties.Remove("model")
        $changed = $true
    }

    # enabled_providers list
    if ($data.PSObject.Properties.Name -contains "enabled_providers" `
        -and $data.enabled_providers -is [array] `
        -and $data.enabled_providers -contains "gpd") {
        $filtered = @($data.enabled_providers | Where-Object { $_ -ne "gpd" })
        if ($filtered.Count -eq 0) {
            $data.PSObject.Properties.Remove("enabled_providers")
        } else {
            $data.enabled_providers = $filtered
        }
        $changed = $true
    }

    if (-not $changed) {
        Write-Skip "No GPD entries to clean from $OpenCodeJson"
        return
    }

    $remainingKeys = @($data.PSObject.Properties).Count
    try {
        if ($remainingKeys -eq 0) {
            Remove-Item -Path $OpenCodeJson -Force -ErrorAction Stop
            Write-Success "Removed $OpenCodeJson (only contained GPD entries)"
        } else {
            $data | ConvertTo-Json -Depth 10 | Set-Content -Path $OpenCodeJson -Encoding UTF8
            Write-Success "Cleaned GPD entries from $OpenCodeJson (opencode config preserved)"
        }
    } catch {
        Write-Warn "Could not rewrite $OpenCodeJson -- $_"
    }
}

function Remove-OpenCodeGpdFiles {
    # Manifest sweep runs regardless of whether $OpenCodeDir exists -- a
    # manifest might live in a non-standard location if the installer
    # was told to use one, but defensively check $OpenCodeDir too.
    if (Test-Path $OpenCodeDir) {
        Invoke-GpdManifestRemoval -ManifestPath $GpdManifestFile
        Remove-OpenCodeJsonGpdEntry
    } else {
        Write-Skip "No opencode config dir at $OpenCodeDir"
    }
}

function Remove-GpdHome {
    if (Test-Path $GpdHome) {
        try {
            Remove-Item -Path $GpdHome -Recurse -Force -ErrorAction Stop
            Write-Success "Removed $GpdHome"
        } catch {
            Write-Warn "Could not remove $GpdHome -- $_"
            Write-Warn "Some files may be in use. Close all gpd/opencode processes and retry."
        }
    } else {
        Write-Skip "$GpdHome already removed"
    }
}

# -- Main ------------------------------------------------------------------

function Test-IsAdministrator {
    # Same helper as install.ps1. Gates the Remove-MpPreference calls
    # below so we don't silently try-and-swallow the CimException that
    # Defender throws on a non-elevated invocation. An earlier version
    # had empty `catch { }` blocks that left Defender exclusions in the
    # registry forever when an admin-ran install was later uninstalled
    # as a regular user.
    $principal = New-Object Security.Principal.WindowsPrincipal(
        [Security.Principal.WindowsIdentity]::GetCurrent())
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Remove-GpdDefenderExclusions {
    # Mirror of Add-GpdDefenderExclusions in install.ps1. Drops the
    # Defender path+process exclusions the installer added, so a full
    # uninstall leaves no residual AV-policy footprint.
    if (-not (Get-Command "Remove-MpPreference" -ErrorAction SilentlyContinue)) {
        return
    }
    if (-not (Test-IsAdministrator)) {
        # If the installer was run with admin, but the uninstaller wasn't,
        # the exclusions remain in HKLM\SOFTWARE\Microsoft\Windows Defender
        # \Exclusions and there is nothing we can do from here. Tell the
        # user exactly how to clean them up manually instead of silently
        # swallowing the CimException the cmdlet would throw.
        Write-Warn "Skipping Defender exclusion removal (uninstaller not running as administrator)."
        Write-Warn "  If the installer was run as admin, leftover exclusions remain in:"
        Write-Warn "    HKLM\SOFTWARE\Microsoft\Windows Defender\Exclusions"
        Write-Warn "  Re-run this uninstaller from an elevated PowerShell to clean them, or run:"
        Write-Warn "    Remove-MpPreference -ExclusionPath `"$env:LOCALAPPDATA\GPD`",`"$GpdHome`""
        Write-Warn "    Remove-MpPreference -ExclusionProcess GPD.exe,opencode.exe,opencode-cli.exe,gpd.exe"
        return
    }
    $tauriInstallRoot = Join-Path $env:LOCALAPPDATA "GPD"
    $paths = @($tauriInstallRoot, $GpdHome) | Select-Object -Unique
    $processes = @("GPD.exe", "opencode.exe", "opencode-cli.exe", "gpd.exe")
    foreach ($p in $paths) {
        try {
            Remove-MpPreference -ExclusionPath $p -ErrorAction Stop
        } catch {
            # "The property PreferenceInconsistent: does not exist in the
            # Exclusions set" is the cmdlet's way of saying the exclusion
            # was already absent. Filter that from real errors so we only
            # warn on genuinely stuck state (Tamper Protection, policy).
            if ($_.Exception.Message -notmatch "does not exist|cannot be found|PreferenceInconsistent") {
                Write-Warn "Could not remove Defender exclusion $p -- $($_.Exception.Message)"
            }
        }
    }
    foreach ($proc in $processes) {
        try {
            Remove-MpPreference -ExclusionProcess $proc -ErrorAction Stop
        } catch {
            if ($_.Exception.Message -notmatch "does not exist|cannot be found|PreferenceInconsistent") {
                Write-Warn "Could not remove Defender exclusion process $proc -- $($_.Exception.Message)"
            }
        }
    }
}

function Invoke-GpdUninstall {
    Write-Banner

    # Discovery pass -- print what will be touched.
    $found = $false

    if (Test-Path $GpdHome) {
        Write-Log "Found GPD directory: $GpdHome"
        $found = $true
    }

    if ((Test-Path $TauriUninstaller) -or (Test-Path $TauriInstallDir)) {
        Write-Log "Found GPD desktop app: $TauriInstallDir"
        $found = $true
    }

    if (Test-Path $TauriStateDir) {
        Write-Log "Found Tauri state dir: $TauriStateDir"
        $found = $true
    }

    if (Test-Path $TauriWebViewDir) {
        Write-Log "Found Tauri WebView data: $TauriWebViewDir"
        $found = $true
    }

    if (Get-PathContainsGpd) {
        Write-Log "Found PATH entry: $GpdBinDir"
        $found = $true
    }

    if (Test-AuthHasGpd) {
        Write-Log "Found 'gpd' entry in $AuthFile"
        $found = $true
    }

    if (Test-Path $GpdManifestFile) {
        Write-Log "Found gpd-file-manifest.json in $OpenCodeDir"
        $found = $true
    }

    if ((Test-Path $OpenCodeJson) -and (Test-OpenCodeJsonHasGpd)) {
        Write-Log "Found GPD entries in $OpenCodeJson"
        $found = $true
    }

    if (-not $found) {
        Write-Host ""
        Write-Host "  Nothing to remove -- GPD does not appear to be installed." -ForegroundColor DarkGray
        Write-Host ""
        return
    }

    # Confirm.
    Write-Host ""
    if (-not $Yes) {
        if (-not [Environment]::UserInteractive -or [Console]::IsInputRedirected) {
            Write-Warn "Non-interactive session -- re-run with -Yes to confirm removal."
            return
        }
        Write-Host "  Remove GPD and all its files? " -NoNewline -ForegroundColor White
        Write-Host "[y/N] " -NoNewline
        $confirm = Read-Host
        if ($confirm -notmatch '^[Yy]$') {
            Write-Host "  Cancelled." -ForegroundColor DarkGray
            Write-Host ""
            return
        }
    }
    Write-Host ""

    # Order matters:
    #   1. Tauri desktop uninstaller -- needs its own files intact.
    #   2. Tauri state dir.
    #   3. PATH entry -- harmless before .gpd removal, but cleanest first.
    #   4. auth.json / opencode.json / manifest cleanup -- surgical only;
    #      we never rm -rf opencode's config/state/cache dirs (AC-2).
    #   5. .gpd dir -- last, since anything else could live inside it.
    Remove-TauriDesktop
    Remove-TauriState
    Remove-GpdFromPath
    Remove-AuthJsonGpdEntry -Path $AuthFile
    Remove-AuthJsonGpdEntry -Path $LegacyAuthFile
    Remove-OpenCodeGpdFiles
    Remove-GpdHome
    # Last — Defender exclusions reference paths that are now gone, so
    # dropping them has no user-visible effect on scanning, it just
    # keeps the registry clean for uninstall-and-reinstall cycles.
    Remove-GpdDefenderExclusions

    # Final message.
    Write-Host ""
    Write-Host "  GPD has been uninstalled." -ForegroundColor Green
    Write-Host ""
    Write-Host "  Git and MiKTeX were NOT removed -- other tools likely depend on them." -ForegroundColor DarkGray
    Write-Host "  To remove them manually:" -ForegroundColor DarkGray
    Write-Host "    winget uninstall Git.Git" -ForegroundColor White
    Write-Host "    winget uninstall MiKTeX.MiKTeX" -ForegroundColor White
    Write-Host ""
    Write-Host "  Open a new terminal to clear the cached PATH." -ForegroundColor DarkGray
    Write-Host ""
}

# -- Entry point -----------------------------------------------------------

Invoke-GpdUninstall
