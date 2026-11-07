[CmdletBinding()]
param(
    [ValidateSet('Install', 'Remove', 'Start', 'Stop', 'Run')]
    [string]$Action = 'Start',
    [string]$DataDir = $env:POCKETAGENT_DATA_DIR
)

$ErrorActionPreference = 'Stop'
$TaskName = 'PocketAgent'
$ProjectDir = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$EntryPoint = [IO.Path]::GetFullPath((Join-Path $ProjectDir 'dist\server\src\server\index.js'))
if ([string]::IsNullOrWhiteSpace($DataDir)) {
    $DataDir = Join-Path $env:LOCALAPPDATA 'PocketAgent'
}
$RuntimeDir = [IO.Path]::GetFullPath($DataDir)
if ($RuntimeDir.Equals($ProjectDir, [StringComparison]::OrdinalIgnoreCase) -or
    $RuntimeDir.StartsWith($ProjectDir.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Runtime data must be outside the public repository.'
}
$StateFile = Join-Path $RuntimeDir 'service.json'
$WindowsPowerShellPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$ScheduledArguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "' +
    $PSCommandPath + '" -Action Run -DataDir "' + $RuntimeDir + '"'

function Get-OwnedTask {
    param([switch]$IgnoreUnrelated)
    $Candidate = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($null -eq $Candidate) { return $null }
    foreach ($CandidateAction in $Candidate.Actions) {
        if (([string]$CandidateAction.Execute).Equals($WindowsPowerShellPath, [StringComparison]::OrdinalIgnoreCase) -and
            ([string]$CandidateAction.Arguments).Equals($ScheduledArguments, [StringComparison]::OrdinalIgnoreCase) -and
            ([string]$CandidateAction.WorkingDirectory).Equals($ProjectDir, [StringComparison]::OrdinalIgnoreCase)) {
            return $Candidate
        }
    }
    if ($IgnoreUnrelated) { return $null }
    throw 'A different task named PocketAgent exists; refusing to change or stop it.'
}

function Get-OwnedProcess {
    if (-not (Test-Path -LiteralPath $StateFile -PathType Leaf)) { return $null }
    try {
        $Record = Get-Content -LiteralPath $StateFile -Raw | ConvertFrom-Json
        $ServicePid = [int]$Record.pid
        if ($ServicePid -le 0) { return $null }
        $OwnedProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $ServicePid" -ErrorAction Stop
        if ($null -eq $OwnedProcess) { return $null }
        $ExpectedNode = [IO.Path]::GetFullPath([string]$Record.execPath)
        $ExpectedEntry = [IO.Path]::GetFullPath([string]$Record.entrypoint)
        if (-not $ExpectedEntry.Equals($EntryPoint, [StringComparison]::OrdinalIgnoreCase)) { return $null }
        if (-not ([string]$OwnedProcess.ExecutablePath).Equals($ExpectedNode, [StringComparison]::OrdinalIgnoreCase)) { return $null }
        $CommandLine = [string]$OwnedProcess.CommandLine
        $EntryPattern = '(?i)(?:^|\s)"?' + [regex]::Escape($ExpectedEntry) + '"?(?:\s|$)'
        # npm start supplies the entry relative to the checkout. The external
        # PID record, executable and creation time must still all match.
        $RelativeEntryPattern = '(?i)(?:^|\s)"?(?:\.[\\/])?dist[\\/]server[\\/]src[\\/]server[\\/]index\.js"?(?:\s|$)'
        if ($CommandLine -notmatch $EntryPattern -and $CommandLine -notmatch $RelativeEntryPattern) { return $null }
        $RecordedStart = [DateTimeOffset]::Parse([string]$Record.startedAt).UtcDateTime
        $ActualStart = ([datetime]$OwnedProcess.CreationDate).ToUniversalTime()
        if ([Math]::Abs(($ActualStart - $RecordedStart).TotalSeconds) -gt 15) { return $null }
        return $OwnedProcess
    } catch {
        return $null
    }
}

function Start-PocketAgent {
    if ($null -ne (Get-OwnedProcess)) {
        Write-Output 'PocketAgent is already running.'
        return
    }
    if (-not (Test-Path -LiteralPath $EntryPoint -PathType Leaf)) {
        throw 'Build PocketAgent first with npm run build.'
    }
    $NodePath = @(Get-Command node -CommandType Application -ErrorAction Stop)[0].Source
    if ([string]::IsNullOrWhiteSpace($NodePath) -or -not (Test-Path -LiteralPath $NodePath -PathType Leaf)) {
        throw 'Unable to resolve the Node executable.'
    }
    $null = New-Item -ItemType Directory -Path $RuntimeDir -Force
    $env:POCKETAGENT_DATA_DIR = $RuntimeDir
    $StartOptions = @{
        FilePath = $NodePath
        ArgumentList = @('"' + $EntryPoint + '"')
        WorkingDirectory = $ProjectDir
        WindowStyle = 'Hidden'
        RedirectStandardOutput = (Join-Path $RuntimeDir 'service.stdout.log')
        RedirectStandardError = (Join-Path $RuntimeDir 'service.stderr.log')
        PassThru = $true
    }
    if ($Action -eq 'Run') { $StartOptions.Wait = $true }
    $StartedProcess = Start-Process @StartOptions
    if ($Action -eq 'Run') { exit $StartedProcess.ExitCode }
    Write-Output 'PocketAgent started in the background. Runtime diagnostics are stored outside the repository.'
}

switch ($Action) {
    'Install' {
        if (-not (Test-Path -LiteralPath $EntryPoint -PathType Leaf)) { throw 'Run npm run build first.' }
        $CurrentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
        $null = Get-OwnedTask
        $TaskAction = New-ScheduledTaskAction -Execute $WindowsPowerShellPath -Argument $ScheduledArguments -WorkingDirectory $ProjectDir
        $Trigger = New-ScheduledTaskTrigger -AtLogOn -User $CurrentIdentity
        $Principal = New-ScheduledTaskPrincipal -UserId $CurrentIdentity -LogonType Interactive -RunLevel Limited
        $Settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) `
            -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew `
            -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
        $null = Register-ScheduledTask -TaskName $TaskName -Action $TaskAction -Trigger $Trigger `
            -Principal $Principal -Settings $Settings -Description 'Personal Codex web interface over Tailscale' -Force
        Write-Output 'PocketAgent will start hidden when the current user logs in. Run npm run service:start to start now.'
    }
    'Remove' {
        $ExistingTask = Get-OwnedTask
        if ($null -ne $ExistingTask) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false }
        Write-Output 'PocketAgent automatic startup removed. Use npm run service:stop to stop a running instance.'
    }
    'Stop' {
        # Explicitly stopping the task prevents its restart-on-failure policy from undoing this action.
        $ExistingTask = Get-OwnedTask -IgnoreUnrelated
        if ($null -ne $ExistingTask) { Stop-ScheduledTask -TaskName $TaskName }
        $OwnedProcess = Get-OwnedProcess
        if ($null -eq $OwnedProcess) {
            Write-Output 'No verified PocketAgent process is running; no process was stopped.'
            return
        }
        # taskkill receives only the verified numeric PID, never an image-wide wildcard.
        $TaskKill = Join-Path $env:SystemRoot 'System32\taskkill.exe'
        # Console-only native children require /F on Windows; a partial non-forced
        # taskkill can otherwise orphan a child after its parent exits.
        try { & $TaskKill /PID ([string]$OwnedProcess.ProcessId) /T /F 2>$null | Out-Null } catch { }
        Start-Sleep -Milliseconds 750
        $StillOwned = Get-OwnedProcess
        if ($null -ne $StillOwned) {
            try { & $TaskKill /PID ([string]$StillOwned.ProcessId) /T /F 2>$null | Out-Null } catch { }
            if ($null -ne (Get-OwnedProcess)) { throw 'PocketAgent could not be stopped; the verified process is still running.' }
        }
        Write-Output 'PocketAgent stopped.'
    }
    default { Start-PocketAgent }
}
