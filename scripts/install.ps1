# Installs or updates wdp-wow into the retail AddOns folder. Idempotent.
#   powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -RepoUrl <url>
param(
    [string]$RepoUrl = "",
    [string]$WowPath = "C:\Program Files (x86)\World of Warcraft\_retail_"
)
$ErrorActionPreference = "Stop"

$addons = Join-Path $WowPath "Interface\AddOns"
if (-not (Test-Path $addons)) { throw "AddOns folder not found: $addons  (pass -WowPath)" }

# Folder name must match wdp-wow.toc for the client to detect the addon.
$target = Join-Path $addons "wdp-wow"

if (Test-Path (Join-Path $target ".git")) {
    Write-Host "==> updating $target"
    git -C $target pull --ff-only
} else {
    if (-not $RepoUrl) { throw "not installed yet; pass -RepoUrl <clone url>" }
    Write-Host "==> cloning into $target"
    git clone $RepoUrl $target
}

Write-Host "==> done. Use /reload in game to pick up changes."
