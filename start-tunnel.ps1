$ErrorActionPreference = "Stop"

Set-Location -LiteralPath $PSScriptRoot
[System.Environment]::SetEnvironmentVariable("PATH", $null, "Process")

$packageExe = "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\Cloudflare.cloudflared_Microsoft.Winget.Source_8wekyb3d8bbwe\cloudflared.exe"
if (Test-Path -LiteralPath $packageExe) {
  $cloudflared = $packageExe
} else {
  $cmd = Get-Command cloudflared -ErrorAction SilentlyContinue
  if (-not $cmd) {
    Write-Host "cloudflared is not installed. Install it with:" -ForegroundColor Red
    Write-Host "winget install --id Cloudflare.cloudflared" -ForegroundColor Yellow
    exit 1
  }
  $cloudflared = $cmd.Source
}

function Update-PublicBaseUrl {
  param([string]$Url)

  $envPath = Join-Path $PSScriptRoot ".env"
  if (-not (Test-Path -LiteralPath $envPath)) {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot ".env.example") -Destination $envPath
  }

  $lines = Get-Content -LiteralPath $envPath -Encoding UTF8
  $found = $false
  $updated = foreach ($line in $lines) {
    if ($line -match "^PUBLIC_BASE_URL=") {
      $found = $true
      "PUBLIC_BASE_URL=$Url"
    } else {
      $line
    }
  }

  if (-not $found) {
    $updated += "PUBLIC_BASE_URL=$Url"
  }

  Set-Content -LiteralPath $envPath -Value $updated -Encoding UTF8
}

$urlPath = Join-Path $PSScriptRoot "tunnel-url.txt"
$logPath = Join-Path $PSScriptRoot "tunnel.err.log"
Remove-Item -LiteralPath $urlPath, $logPath -Force -ErrorAction SilentlyContinue

Write-Host "Starting Cloudflare Quick Tunnel for http://localhost:3000" -ForegroundColor Cyan
Write-Host "Keep this window open." -ForegroundColor Yellow
Write-Host ""

$detectedUrl = ""

& $cloudflared tunnel --protocol http2 --url http://localhost:3000 2>&1 | ForEach-Object {
  $line = [string]$_
  Add-Content -LiteralPath $logPath -Value $line -Encoding UTF8
  Write-Host $line

  if (-not $detectedUrl -and $line -match "https://[a-zA-Z0-9-]+\.trycloudflare\.com") {
    $detectedUrl = $matches[0]
    Set-Content -LiteralPath $urlPath -Value $detectedUrl -Encoding ASCII
    Update-PublicBaseUrl -Url $detectedUrl
    Write-Host ""
    Write-Host "Tunnel URL detected:" -ForegroundColor Green
    Write-Host $detectedUrl -ForegroundColor Green
    Write-Host ""
    Write-Host "PUBLIC_BASE_URL has been written to .env." -ForegroundColor Green
    Write-Host "Restart start-server.cmd, then open this URL in your browser." -ForegroundColor Yellow
    Write-Host ""
  }
}
