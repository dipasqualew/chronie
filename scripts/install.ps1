# Installs the newest rolling Chronie development build for the current Windows user.
# Run from PowerShell:
#   irm https://raw.githubusercontent.com/dipasqualew/chronie/main/scripts/install.ps1 | iex
$ErrorActionPreference = "Stop"

$repository = "dipasqualew/chronie"
$release = Invoke-RestMethod `
    -Headers @{ "User-Agent" = "chronie-installer"; "Accept" = "application/vnd.github+json" } `
    -Uri "https://api.github.com/repos/$repository/releases/tags/dev"
$installer = $release.assets | Where-Object {
    $_.name -match "-setup\.exe$" -and $_.name -notmatch "\.sig$"
} | Select-Object -First 1

if (-not $installer) {
    throw "The dev release does not contain a Windows installer yet."
}

$destination = Join-Path ([System.IO.Path]::GetTempPath()) $installer.name
Write-Host "Downloading Chronie $($release.name)..."
Invoke-WebRequest -Uri $installer.browser_download_url -OutFile $destination
Write-Host "Starting the installer..."
Start-Process -FilePath $destination -Wait
Remove-Item $destination -ErrorAction SilentlyContinue
Write-Host "Chronie is installed. Open it from the Start menu."
