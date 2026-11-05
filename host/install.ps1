# Registers the helper with Firefox (current user only, no admin needed).
# Re-run it if you move this folder. Use -Uninstall to remove it.
param([switch]$Uninstall)
$ErrorActionPreference = 'Stop'
$dir = $PSScriptRoot
$key = 'HKCU:\Software\Mozilla\NativeMessagingHosts\yt_dlp_host'

if ($Uninstall) {
    if (Test-Path $key) { Remove-Item $key -Recurse -Force }
    Write-Host 'Helper unregistered.' -ForegroundColor Yellow
    return
}

# Files unzipped from the internet can carry a "blocked" mark; clear it.
Get-ChildItem -LiteralPath (Split-Path $dir -Parent) -Recurse -File | Unblock-File -ErrorAction SilentlyContinue

$manifestPath = Join-Path $dir 'yt_dlp_host.json'
$manifest = [ordered]@{
    name               = 'yt_dlp_host'
    description        = 'Runs yt-dlp for the yt-dlp Launcher extension'
    path               = (Join-Path $dir 'host.bat')
    type               = 'stdio'
    allowed_extensions = @('ytdlp-launcher@local')
} | ConvertTo-Json
# UTF-8 without a BOM, which is what Firefox expects.
[IO.File]::WriteAllText($manifestPath, $manifest, (New-Object Text.UTF8Encoding $false))

New-Item -Path $key -Force | Out-Null
Set-ItemProperty -Path $key -Name '(Default)' -Value $manifestPath

Write-Host 'Helper registered for Firefox.' -ForegroundColor Green
$y = Get-Command yt-dlp -ErrorAction SilentlyContinue
if ($y) { Write-Host "yt-dlp found: $($y.Source)" }
else    { Write-Host 'yt-dlp not found. Install it with:  winget install yt-dlp.yt-dlp' -ForegroundColor Yellow }
Write-Host 'Next: load the extension in Firefox (see README.txt).'
