# GPD CLI uninstaller bootstrap (Windows)
#
# Pure ASCII, no BOM. Same rationale as install.ps1: run cleanly under
#   irm https://download.gpd.psi.inc/uninstall.ps1 | iex
# on PowerShell 5.1 in non-English locales where irm defaults to
# ISO-8859-1 decoding and corrupts UTF-8 script bodies.
#
# Flags via env vars (iex strips caller args):
#   $env:GPD_YES = "1"  -> skip the y/N confirmation prompt

$ErrorActionPreference = "Stop"

try {
    $sec = [Net.ServicePointManager]::SecurityProtocol
    if (($sec -band [Net.SecurityProtocolType]::Tls12) -eq 0) {
        [Net.ServicePointManager]::SecurityProtocol = $sec -bor [Net.SecurityProtocolType]::Tls12
    }
} catch {}

$mainUrl = if ($env:GPD_UNINSTALL_MAIN_URL) {
    $env:GPD_UNINSTALL_MAIN_URL
} else {
    "https://download.gpd.psi.inc/uninstall_main.ps1"
}

$wc = New-Object Net.WebClient
$wc.Encoding = [System.Text.Encoding]::UTF8
$body = $wc.DownloadString($mainUrl)

& ([scriptblock]::Create($body)) @args
