# One-time setup of the Hindrishi label printer on this laptop.
# Double-click INSTALL.bat (it runs this script with the right settings).
#
# 1. Asks for the CRM secret (AUTOMATION_CRON_SECRET) and printer
# 2. Downloads SumatraPDF (free, used to print PDFs silently)
# 3. Starts the agent now and every time you log in

$ErrorActionPreference = 'Stop'
trap {
  Write-Host ''
  Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
  Read-Host 'Press Enter to close'
  exit 1
}
$src = Split-Path -Parent $MyInvocation.MyCommand.Path
$dir = Join-Path $env:LOCALAPPDATA 'HindrishiPrint'
New-Item -ItemType Directory -Force -Path $dir | Out-Null

Write-Host ''
Write-Host 'Hindrishi label printer setup' -ForegroundColor Yellow
$secret = Read-Host 'Paste the CRM secret (AUTOMATION_CRON_SECRET)'
if (-not $secret) { throw 'Secret is required.' }

$printers = Get-Printer | Select-Object -ExpandProperty Name
Write-Host ''
Write-Host 'Printers on this laptop:'
for ($i = 0; $i -lt $printers.Count; $i++) { Write-Host ("  {0}. {1}" -f ($i + 1), $printers[$i]) }
$pick = Read-Host 'Number of the label printer (press Enter for the default printer)'
$printer = ''
if ($pick -match '^\d+$' -and [int]$pick -ge 1 -and [int]$pick -le $printers.Count) {
  $printer = $printers[[int]$pick - 1]
} elseif ($pick) {
  # Also accept the printer's name typed out (e.g. "TSC TE244").
  $printer = $printers | Where-Object { $_ -eq $pick.Trim() -or $_ -like "*$($pick.Trim())*" } |
    Select-Object -First 1
  if (-not $printer) { throw "No printer called '$pick'. Run INSTALL.bat again and type its number." }
}

@{ appUrl = 'https://wacrm-zwrx-1.vercel.app'; secret = $secret; printer = $printer } |
  ConvertTo-Json | Set-Content (Join-Path $dir 'config.json')
Copy-Item (Join-Path $src 'hindrishi-print-agent.ps1') $dir -Force

$sumatra = Join-Path $dir 'SumatraPDF.exe'
if (-not (Test-Path $sumatra)) {
  Write-Host 'Downloading SumatraPDF...'
  $zip = Join-Path $env:TEMP 'sumatra.zip'
  Invoke-WebRequest -UseBasicParsing -OutFile $zip `
    -Uri 'https://www.sumatrapdfreader.org/dl/rel/3.5.2/SumatraPDF-3.5.2-64.zip'
  Expand-Archive $zip -DestinationPath $dir -Force
  Get-ChildItem $dir -Filter 'SumatraPDF*.exe' | Select-Object -First 1 |
    Rename-Item -NewName 'SumatraPDF.exe' -ErrorAction SilentlyContinue
  Remove-Item $zip -ErrorAction SilentlyContinue
}

# Check the secret works before installing.
try {
  Invoke-RestMethod -Uri 'https://wacrm-zwrx-1.vercel.app/api/print/labels' `
    -Headers @{ 'x-cron-secret' = $secret } -TimeoutSec 30 | Out-Null
} catch {
  throw "The CRM refused the secret or can't be reached: $($_.Exception.Message)"
}

$agent = Join-Path $dir 'hindrishi-print-agent.ps1'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$agent`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 99 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName 'Hindrishi Label Printer' -Action $action -Trigger $trigger `
  -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName 'Hindrishi Label Printer'

Write-Host ''
Write-Host "Done. Labels will print on: $(if ($printer) { $printer } else { 'default printer' })" -ForegroundColor Green
Write-Host "Log file: $dir\print-agent.log"
Read-Host 'Press Enter to close'
