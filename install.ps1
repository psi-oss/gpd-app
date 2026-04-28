# GPD CLI installer bootstrap (Windows)
#
# Pure ASCII, no BOM. Designed to run cleanly under
#   irm https://download.gpd.psi.inc/install.ps1 | iex
# on PowerShell 5.1 (Portuguese, German, Russian, etc. locales) where
# Invoke-RestMethod defaults to ISO-8859-1 decoding for response bodies
# without an explicit charset, which previously turned every UTF-8 byte
# in the real installer (BOM, banner box-drawing, accented comments)
# into mojibake that the parser rejected.
#
# This file does ONE thing: download install_main.ps1 with explicit
# UTF-8 decoding, then evaluate it as a scriptblock so the
# [CmdletBinding()] + param() block at top of install_main.ps1 stays
# legal under iex.
#
# Flags via env vars (iex strips caller args, so flags must be set
# before the pipe):
#   $env:GPD_SKIP_LAUNCH   = "1"  -> suppress GPD auto-launch
#   $env:GPD_NO_EXPORT_KEY = "1"  -> skip writing GPD_API_KEY to User env

$ErrorActionPreference = "Stop"

# TLS 1.2: required for https github.io / gh-pages downloads on PS 5.1
# default. PS 7+ already negotiates 1.2/1.3, so the |= is a no-op there.
try {
    $sec = [Net.ServicePointManager]::SecurityProtocol
    if (($sec -band [Net.SecurityProtocolType]::Tls12) -eq 0) {
        [Net.ServicePointManager]::SecurityProtocol = $sec -bor [Net.SecurityProtocolType]::Tls12
    }
} catch {
    # Older .NET runtimes may not support Tls12; fall through and let
    # the download attempt surface the real error.
}

$mainUrl = if ($env:GPD_INSTALL_MAIN_URL) {
    $env:GPD_INSTALL_MAIN_URL
} else {
    "https://download.gpd.psi.inc/install_main.ps1"
}

# WebClient.DownloadString with Encoding=UTF8 forces UTF-8 decoding
# regardless of the response Content-Type header. This is the encoding
# bug that broke `irm | iex` on PS 5.1 in non-English locales.
$wc = New-Object Net.WebClient
$wc.Encoding = [System.Text.Encoding]::UTF8
$body = $wc.DownloadString($mainUrl)

# Evaluate as a scriptblock instead of via iex. Scriptblock parsing
# accepts [CmdletBinding()] + param() at top of the body (the same
# constructs iex rejects when they appear in piped script text).
& ([scriptblock]::Create($body)) @args
