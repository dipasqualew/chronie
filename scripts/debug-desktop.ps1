# Diagnoses a Chronie desktop build that will not stay open on Windows.
# Runs the installed executable in the foreground so a startup failure is visible instead
# of vanishing with the process, then reports everything it left behind.
# Run from PowerShell:
#   powershell -ExecutionPolicy Bypass -File scripts/debug-desktop.ps1
$ErrorActionPreference = "Stop"

$executable = Join-Path $env:LOCALAPPDATA "Chronie\Chronie.exe"
$log = Join-Path $env:LOCALAPPDATA "Chronie\startup-error.log"
$data = Join-Path $env:APPDATA "dev.chronie.wow"

if (-not (Test-Path $executable)) {
    throw "Chronie is not installed for this user. Expected $executable - run scripts/install.ps1 first."
}

Write-Host "== build ==" -ForegroundColor Cyan
(Get-Item $executable) | Select-Object FullName, Length, LastWriteTime, VersionInfo | Format-List

Write-Host "== running in the foreground (close the window to continue) ==" -ForegroundColor Cyan
$stdout = New-TemporaryFile
$stderr = New-TemporaryFile
$process = Start-Process -FilePath $executable -PassThru -Wait -NoNewWindow `
    -RedirectStandardOutput $stdout -RedirectStandardError $stderr
Write-Host "exit code: $($process.ExitCode)"
foreach ($stream in @{ stdout = $stdout; stderr = $stderr }.GetEnumerator()) {
    $text = (Get-Content $stream.Value -Raw -ErrorAction SilentlyContinue)
    if ($text) { Write-Host "--- $($stream.Key) ---"; Write-Host $text }
}
Remove-Item $stdout, $stderr -ErrorAction SilentlyContinue

Write-Host "== startup error log ==" -ForegroundColor Cyan
if (Test-Path $log) { Get-Content $log -Tail 20 } else { Write-Host "none at $log" }

Write-Host "== application data ==" -ForegroundColor Cyan
if (Test-Path $data) { Get-ChildItem $data | Format-Table Name, Length, LastWriteTime } `
    else { Write-Host "none at $data - the app never finished starting" }

Write-Host "== WebView2 runtime ==" -ForegroundColor Cyan
$webview = Get-ItemProperty -ErrorAction SilentlyContinue -Path @(
    "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
    "HKCU:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
) | Select-Object -First 1
if ($webview) { Write-Host "version $($webview.pv)" } else { Write-Host "MISSING - the webview cannot start" }

Write-Host "== recent Windows error reports ==" -ForegroundColor Cyan
Get-WinEvent -ErrorAction SilentlyContinue -FilterHashtable @{
    LogName = "Application"; ProviderName = @("Application Error", ".NET Runtime", "Application Hang")
    StartTime = (Get-Date).AddMinutes(-10)
} | Where-Object { $_.Message -match "Chronie" } | Select-Object TimeCreated, Message | Format-List
