# One-time setup for signed rolling development updates.
# Requires GitHub CLI (`gh auth login`) and Bun.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$keyDirectory = Join-Path $root ".tauri"
$privateKey = Join-Path $keyDirectory "wdp.key"
$publicKey = "$privateKey.pub"

New-Item -ItemType Directory -Force -Path $keyDirectory | Out-Null
if (Test-Path $privateKey) {
    throw "A signing key already exists at $privateKey. Back it up; do not overwrite it."
}

$secure = Read-Host "Choose a signing-key password" -AsSecureString
$password = [System.Net.NetworkCredential]::new("", $secure).Password
if (-not $password) { throw "The signing-key password cannot be empty." }

Push-Location (Join-Path $root "apps\desktop")
try {
    bun run tauri signer generate --ci --password $password --write-keys $privateKey
} finally {
    Pop-Location
}

gh secret set TAURI_SIGNING_PRIVATE_KEY --body (Get-Content $privateKey -Raw)
gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD --body $password
gh variable set TAURI_SIGNING_PUBLIC_KEY --body ((Get-Content $publicKey -Raw).Trim())
$password = $null

Write-Host "Signing is configured for this repository."
Write-Host "Back up $privateKey and its password somewhere secure; losing them breaks updates for installed builds."
