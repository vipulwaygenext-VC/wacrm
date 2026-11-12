# Hindrishi label print agent
# Runs on the office laptop. Every 20 seconds it asks the CRM for new
# Shiprocket labels, prints each PDF on the default printer, and marks
# the order "Label-Printed" in Shopify so it never prints twice.
#
# Installed by install-print-agent.ps1 (config + SumatraPDF live in the
# same folder). Log: print-agent.log in this folder.

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$config = Get-Content (Join-Path $here 'config.json') -Raw | ConvertFrom-Json
$log = Join-Path $here 'print-agent.log'
$sumatra = Join-Path $here 'SumatraPDF.exe'
$headers = @{ 'x-cron-secret' = $config.secret }

function Write-Log($msg) {
  $line = "{0}  {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
  Add-Content -Path $log -Value $line
  # keep the log small
  if ((Get-Item $log).Length -gt 1MB) {
    Get-Content $log -Tail 2000 | Set-Content $log
  }
}

function Print-Pdf($file) {
  if ($config.printer) {
    & $sumatra -print-to $config.printer -print-settings 'fit' -silent $file
  } else {
    & $sumatra -print-to-default -print-settings 'fit' -silent $file
  }
  return $LASTEXITCODE -eq 0
}

Write-Log "agent started (printer: $(if ($config.printer) { $config.printer } else { 'default' }))"

while ($true) {
  try {
    $res = Invoke-RestMethod -Uri "$($config.appUrl)/api/print/labels" -Headers $headers -TimeoutSec 30
    foreach ($label in $res.labels) {
      $file = Join-Path $env:TEMP ("label-{0}.pdf" -f $label.orderId)
      try {
        Invoke-WebRequest -Uri $label.labelUrl -OutFile $file -TimeoutSec 60 -UseBasicParsing
        if (Print-Pdf $file) {
          Invoke-RestMethod -Method Post -Uri "$($config.appUrl)/api/print/labels/$($label.orderId)" -Headers $headers -TimeoutSec 30 | Out-Null
          Write-Log "printed $($label.name)"
        } else {
          Write-Log "PRINT FAILED $($label.name) - is the printer on?"
        }
      } catch {
        Write-Log "error on $($label.name): $($_.Exception.Message)"
      } finally {
        Remove-Item $file -ErrorAction SilentlyContinue
      }
    }
  } catch {
    Write-Log "cannot reach CRM: $($_.Exception.Message)"
  }
  Start-Sleep -Seconds 20
}
