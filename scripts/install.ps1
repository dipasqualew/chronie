# Installs the newest rolling Chronie development build for the current Windows user.
# Run from PowerShell:
#   irm https://raw.githubusercontent.com/dipasqualew/chronie/main/scripts/install.ps1 | iex
# Run it again to update; it replaces the files and leaves the recorded history alone.
#
# This unpacks an archive instead of running a downloaded installer, and that is the whole
# point of it. Windows Defender signatures the NSIS stub that self-extracting installers are
# built from — not anything in Chronie — so the `-setup.exe` this used to fetch was refused
# on download and again on launch, with "the file contains a virus or potentially unwanted
# software". Rebuilding does not help and neither does asking; the only thing that makes such
# a stub trustworthy is a code-signing certificate, and there is not one. A zip has no stub,
# so there is nothing left to misidentify. Everything the installer used to do — the folder,
# the shortcut, the entry under Apps & Features — is done below instead.
$ErrorActionPreference = "Stop"

$repository = "dipasqualew/chronie"
$release = Invoke-RestMethod `
    -Headers @{ "User-Agent" = "chronie-installer"; "Accept" = "application/vnd.github+json" } `
    -Uri "https://api.github.com/repos/$repository/releases/tags/dev"
$asset = $release.assets | Where-Object { $_.name -like "*-portable.zip" } | Select-Object -First 1

if (-not $asset) {
    throw "The dev release does not contain a Windows build yet."
}

$installRoot = Join-Path $env:LOCALAPPDATA "Chronie"
$executable = Join-Path $installRoot "Chronie.exe"
$uninstaller = Join-Path $installRoot "uninstall.ps1"
$shortcut = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Chronie.lnk"
$uninstallKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Chronie"
$archive = Join-Path ([System.IO.Path]::GetTempPath()) $asset.name
$version = if ($asset.name -match "_(\d+(\.\d+)+)_") { $Matches[1] } else { $release.name }

Write-Host "Downloading Chronie $($release.name)..."
Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $archive

# A running Chronie holds its own executable open and Windows will not write over one that is
# open, so an update onto a running copy fails halfway. Nothing is lost by closing it: the
# database and the settings live under %APPDATA%\dev.chronie.wow, which nothing here touches.
Get-Process -Name "Chronie" -ErrorAction SilentlyContinue | ForEach-Object {
    $_.CloseMainWindow() | Out-Null
    if (-not $_.WaitForExit(5000)) { $_.Kill() }
    $_.WaitForExit()
}

# Earlier runs of this script ran an NSIS installer, which left an `uninstall.exe` in this
# folder and an entry of its own under Apps & Features. Both are about to point at files that
# have stopped existing, so they go with the rest of the old install rather than sitting
# beside the new one offering to uninstall nothing.
Get-ChildItem "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall" -ErrorAction SilentlyContinue |
    Where-Object {
        $location = (Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue).InstallLocation
        $location -and $location.TrimEnd("\") -eq $installRoot.TrimEnd("\")
    } | ForEach-Object { Remove-Item $_.PSPath -Recurse -Force -ErrorAction SilentlyContinue }

Write-Host "Installing into $installRoot..."
if (Test-Path $installRoot) { Remove-Item $installRoot -Recurse -Force }
# `Invoke-WebRequest` writes no zone marker, so nothing unpacked from here inherits one and
# SmartScreen has no reason to interrupt the first launch either.
Expand-Archive -Path $archive -DestinationPath $installRoot -Force
Remove-Item $archive -ErrorAction SilentlyContinue

$link = (New-Object -ComObject WScript.Shell).CreateShortcut($shortcut)
$link.TargetPath = $executable
$link.WorkingDirectory = $installRoot
$link.Description = "Chronie"
$link.Save()

# Without this Chronie is a folder nobody can find their way out of: it asks to start with
# Windows every time it launches, and Apps & Features is where a person goes to stop that.
New-Item -Path $uninstallKey -Force | Out-Null
$entries = [ordered]@{
    DisplayName     = "Chronie"
    DisplayVersion  = $version
    DisplayIcon     = $executable
    Publisher       = $repository.Split("/")[0]
    InstallLocation = $installRoot
    UninstallString = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$uninstaller`""
    EstimatedSize   = [int]((Get-Item $executable).Length / 1KB)
    NoModify        = 1
    NoRepair        = 1
}
foreach ($entry in $entries.GetEnumerator()) {
    New-ItemProperty -Path $uninstallKey -Name $entry.Key -Value $entry.Value -Force | Out-Null
}

Start-Process -FilePath $executable -WorkingDirectory $installRoot
Write-Host "Chronie $version is installed and running. Open it from the Start menu."
