# Supervise the DSH relay agent so a crash or a DSH restart cannot leave the tunnel down.
#
# Why a loop instead of relying on Task Scheduler's RestartCount: RestartCount only fires
# when the task's action FAILS. A script that runs the agent and exits 0 on its exit marks
# the task completed, and nothing restarts it. Looping here keeps the task alive forever
# and makes every agent exit a restart instead of the end of the task.
#
# ASCII only: PowerShell 5.1 reads BOM-less files as ANSI, and non-ASCII comments break it.

$ErrorActionPreference = 'Stop'
$root = Join-Path $env:USERPROFILE '.dsh-relay'
$engine = Join-Path $root 'dsh-relay.mjs'
$log = Join-Path $root 'agent.log'

if (-not (Test-Path $engine)) {
    Write-Output "missing engine: $engine"
    exit 2
}

function Write-Log([string]$line) {
    $stamp = (Get-Date).ToString('s')
    Add-Content -Path $log -Value "$stamp $line" -Encoding ascii
}

Write-Log 'supervisor started'
$backoff = 3
while ($true) {
    $started = Get-Date
    try {
        # Foreground so this process lives exactly as long as the agent does.
        & node $engine start 2>&1 | ForEach-Object { Write-Log $_ }
        Write-Log "agent exited with code $LASTEXITCODE"
    } catch {
        Write-Log ("agent threw: " + $_.Exception.Message)
    }
    $ran = (Get-Date) - $started
    if ($ran.TotalSeconds -lt 20) { $backoff = [Math]::Min($backoff * 2, 60) } else { $backoff = 3 }
    Write-Log "restarting in ${backoff}s"
    Start-Sleep -Seconds $backoff
}
