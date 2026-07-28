# Removes the per-user Chronie install that `install.ps1` placed, and nothing else.
#
# This ships inside the release archive rather than being fetched, because `install.ps1`
# arrives through `irm | iex` and has no checkout beside it to copy from. It is what the
# entry under Apps & Features runs; to run it by hand:
#   powershell -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\Chronie\uninstall.ps1"
$ErrorActionPreference = "Stop"

$installRoot = Join-Path $env:LOCALAPPDATA "Chronie"
$shortcut = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Chronie.lnk"
$uninstallKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Chronie"
$runKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"

# This script is inside the folder it is about to delete. PowerShell has already read the
# whole file, so that part is fine, but Windows will not remove a directory that a process is
# sitting in — and the shell's working directory is wherever Apps & Features left it.
Set-Location $env:USERPROFILE

Get-Process -Name "Chronie" -ErrorAction SilentlyContinue | ForEach-Object {
    $_.CloseMainWindow() | Out-Null
    if (-not $_.WaitForExit(5000)) { $_.Kill() }
    $_.WaitForExit()
}

# Chronie asks to start with Windows on every launch, so the autostart entry outlives the
# files unless it is taken out too, and what is left is a machine trying to start a program
# that is not there any more. It is matched by where it points rather than by its name: the
# name is the autostart plugin's to choose, the path is ours.
$entries = Get-ItemProperty -Path $runKey -ErrorAction SilentlyContinue
if ($entries) {
    $entries.PSObject.Properties |
        Where-Object { $_.Value -is [string] -and $_.Value -like "*$installRoot*" } |
        ForEach-Object { Remove-ItemProperty -Path $runKey -Name $_.Name -ErrorAction SilentlyContinue }
}

Remove-Item $shortcut -Force -ErrorAction SilentlyContinue
Remove-Item $uninstallKey -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item $installRoot -Recurse -Force -ErrorAction SilentlyContinue

Write-Host "Chronie is removed."
# Deliberately left where it is. Removing the application is not a request to throw away
# however many months of recorded sessions, and there is no undoing it if it were.
Write-Host "Its history is still in $env:APPDATA\dev.chronie.wow; delete that folder to discard it."
