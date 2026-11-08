[CmdletBinding()]
param(
    [ValidateSet('Queue', 'Apply', 'Status')][string]$Action = 'Queue',
    [string]$ReleaseId,
    [string]$OperationId,
    [string]$DataDir = $env:POCKETAGENT_DATA_DIR,
    [switch]$UpdateWorkerWhenIdle,
    [string]$NodeExecutable
)

$ErrorActionPreference = 'Stop'
$SourceRoot = $null
$RuntimeDir = $null
$PowerShellPath = $null
$NodePath = $null
$DeployDescription = 'PocketAgent managed independent deployment'

function Get-BootstrapOperationDirectory {
    param([string]$Id)
    if ($Id -cnotmatch '^[a-f0-9]{32}$') { throw 'DEPLOY_INVALID_OPERATION' }
    $Parent = Join-Path $RuntimeDir 'deployments'
    $Expected = [IO.Path]::GetFullPath((Join-Path $Parent $Id))
    foreach ($Path in @($RuntimeDir, $Parent, $Expected)) {
        $Entry = [IO.DirectoryInfo]::new($Path)
        if (-not $Entry.Exists -or ($Entry.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'DEPLOY_PATH_INVALID' }
    }
    return $Expected
}

function Read-BootstrapPlan {
    param([string]$Directory)
    $Plan = Get-Content -LiteralPath (Join-Path $Directory 'plan.json') -Raw | ConvertFrom-Json
    if ($Plan.schemaVersion -isnot [int] -or $Plan.schemaVersion -ne 1 -or $Plan.releaseId -isnot [string] -or $Plan.releaseId -cnotmatch '^[a-zA-Z0-9_-]{1,80}$' -or $Plan.controlRoot -isnot [string] -or $Plan.nodeExecutable -isnot [string] -or -not [IO.Path]::IsPathRooted($Plan.nodeExecutable) -or $Plan.updateWorkerWhenIdle -isnot [bool] -or $Plan.updateHash -cnotmatch '^[A-F0-9]{64}$' -or $Plan.controlHash -cnotmatch '^[A-F0-9]{64}$') { throw 'DEPLOY_INVALID_PLAN' }
    foreach ($Name in @('plan.json', 'update.ps1', 'windows.ps1')) {
        if (([IO.FileInfo]::new((Join-Path $Directory $Name)).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'DEPLOY_PATH_INVALID' }
    }
    if ((Get-DeploymentFileHash (Join-Path $Directory 'update.ps1')) -ne $Plan.updateHash -or (Get-DeploymentFileHash (Join-Path $Directory 'windows.ps1')) -ne $Plan.controlHash) { throw 'DEPLOY_INTEGRITY_FAILED' }
    return $Plan
}

function Get-DeploymentFileHash {
    param([string]$Path)
    $Stream = $null; $Hash = $null
    try {
        $Stream = [IO.File]::OpenRead($Path)
        $Hash = [Security.Cryptography.SHA256]::Create()
        return [BitConverter]::ToString($Hash.ComputeHash($Stream)).Replace('-', '')
    } finally {
        if ($null -ne $Stream) { $Stream.Dispose() }
        if ($null -ne $Hash) { $Hash.Dispose() }
    }
}

function Resolve-DeploymentNode {
    param([string]$Executable)
    try {
        if ([string]::IsNullOrWhiteSpace($Executable)) { $Executable = @(Get-Command node -CommandType Application -ErrorAction Stop)[0].Source }
        if (-not [IO.Path]::IsPathRooted($Executable) -or -not [IO.File]::Exists($Executable)) { throw 'DEPLOY_NODE_UNAVAILABLE' }
        $Probe = Invoke-DeploymentProcess -File $Executable -Arguments @('-e', "process.stdout.write(require('node:fs').realpathSync(process.execPath))") -TimeoutSeconds 5
        if ($Probe.exitCode -ne 0 -or -not [IO.Path]::IsPathRooted([string]$Probe.output) -or -not [IO.File]::Exists([string]$Probe.output)) { throw 'DEPLOY_NODE_UNAVAILABLE' }
        return [IO.Path]::GetFullPath([string]$Probe.output)
    } catch { throw 'DEPLOY_NODE_UNAVAILABLE' }
}

function Get-CanonicalDeploymentPath {
    param([string]$Path)
    $Resolved = & $NodePath -e "process.stdout.write(require('node:fs').realpathSync(process.argv[1]))" $Path 2>$null
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($Resolved)) { throw 'DEPLOY_PATH_INVALID' }
    return [IO.Path]::GetFullPath([string]$Resolved)
}

function Get-OperationDirectory {
    param([string]$Id)
    if ($Id -cnotmatch '^[a-f0-9]{32}$') { throw 'DEPLOY_INVALID_OPERATION' }
    $Parent = Get-CanonicalDeploymentPath (Join-Path $RuntimeDir 'deployments')
    if (-not $Parent.Equals([IO.Path]::GetFullPath((Join-Path $RuntimeDir 'deployments')), [StringComparison]::OrdinalIgnoreCase)) { throw 'DEPLOY_PATH_INVALID' }
    $Expected = [IO.Path]::GetFullPath((Join-Path $Parent $Id))
    $Actual = Get-CanonicalDeploymentPath $Expected
    if (-not $Actual.Equals($Expected, [StringComparison]::OrdinalIgnoreCase)) { throw 'DEPLOY_PATH_INVALID' }
    return $Actual
}

function Get-PreparedRelease {
    param([string]$Id)
    if ($Id -cnotmatch '^[a-zA-Z0-9_-]{1,80}$') { throw 'DEPLOY_INVALID_RELEASE' }
    $Root = Get-CanonicalDeploymentPath (Join-Path $RuntimeDir 'releases')
    if (-not $Root.Equals([IO.Path]::GetFullPath((Join-Path $RuntimeDir 'releases')), [StringComparison]::OrdinalIgnoreCase)) { throw 'DEPLOY_PATH_INVALID' }
    $Expected = [IO.Path]::GetFullPath((Join-Path $Root $Id))
    $Actual = Get-CanonicalDeploymentPath $Expected
    if (-not $Actual.Equals($Expected, [StringComparison]::OrdinalIgnoreCase)) { throw 'DEPLOY_PATH_INVALID' }
    return $Actual
}

function Write-AtomicDeploymentJson {
    param([string]$Path, $Value)
    $Temporary = $Path + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
    [IO.File]::WriteAllText($Temporary, ($Value | ConvertTo-Json -Compress -Depth 6), [Text.UTF8Encoding]::new($false))
    if (Test-Path -LiteralPath $Path -PathType Leaf) { [IO.File]::Replace($Temporary, $Path, [NullString]::Value) }
    else { [IO.File]::Move($Temporary, $Path) }
}

function Write-DeploymentResult {
    param([string]$Directory, [string]$Status, [string]$Code)
    if ($Status -notin @('queued', 'waitingForIdle', 'accepted', 'stopping', 'starting', 'healthy', 'rollingBack', 'rolledBack', 'failed')) { throw 'DEPLOY_INVALID_RESULT' }
    Write-AtomicDeploymentJson -Path (Join-Path $Directory 'result.json') -Value @{ schemaVersion=1; status=$Status; code=(Get-SafeDeploymentCode $Code) }
}

function Get-SafeDeploymentCode {
    param([string]$Code)
    if ($Code -cin @(
        'DEPLOY_QUEUED', 'DEPLOY_WAITING_FOR_IDLE', 'DEPLOY_ACCEPTED', 'DEPLOY_HTTP_STOPPING',
        'DEPLOY_HTTP_STARTING', 'DEPLOY_HEALTHY', 'DEPLOY_ROLLING_BACK', 'DEPLOY_FAILED',
        'DEPLOY_PATH_INVALID', 'DEPLOY_INVALID_OPERATION', 'DEPLOY_INVALID_RELEASE',
        'DEPLOY_INVALID_RESULT', 'DEPLOY_RESULT_UNAVAILABLE', 'DEPLOY_INTEGRITY_FAILED',
        'DEPLOY_WORKER_UPDATE_REQUIRED', 'DEPLOY_TASK_NOT_OWNED', 'DEPLOY_PROCESS_CHECK_FAILED',
        'DEPLOY_NOT_DETACHED', 'DEPLOY_INVALID_MANIFEST', 'DEPLOY_WORKER_BASELINE_REQUIRED',
        'DEPLOY_MAINTENANCE_FAILED', 'DEPLOY_IDLE_TIMEOUT', 'DEPLOY_LEGACY_MIGRATION_REQUIRED',
        'DEPLOY_STOP_FAILED', 'DEPLOY_START_FAILED', 'DEPLOY_HEALTH_FAILED', 'DEPLOY_BUSY',
        'DEPLOY_PREVIOUS_RELEASE_INVALID', 'DEPLOY_ROLLBACK_DEFERRED', 'DEPLOY_ROLLBACK_FAILED',
        'DEPLOY_HANDOFF_TIMEOUT', 'DEPLOY_HANDOFF_FAILED', 'DEPLOY_INVALID_PLAN',
        'DEPLOY_RUNTIME_INSIDE_CHECKOUT', 'DEPLOY_HELPER_TIMEOUT', 'DEPLOY_HELPER_FAILED',
        'DEPLOY_NODE_UNAVAILABLE', 'DEPLOY_BOOTSTRAP_FAILED', 'DEPLOY_BOOTSTRAP_CANONICAL_FAILED',
        'DEPLOY_BOOTSTRAP_PLAN_FAILED', 'DEPLOY_TASK_EXITED'
    )) { return $Code }
    return 'DEPLOY_FAILED'
}

function Read-DeploymentResult {
    param([string]$Directory)
    try { $Result = Get-Content -LiteralPath (Join-Path $Directory 'result.json') -Raw | ConvertFrom-Json } catch { throw 'DEPLOY_RESULT_UNAVAILABLE' }
    if ($Result.schemaVersion -ne 1 -or $Result.status -notin @('queued', 'waitingForIdle', 'accepted', 'stopping', 'starting', 'healthy', 'rollingBack', 'rolledBack', 'failed') -or $Result.code -cnotmatch '^DEPLOY_[A-Z_]+$') { throw 'DEPLOY_INVALID_RESULT' }
    return @{ schemaVersion=1; status=[string]$Result.status; code=(Get-SafeDeploymentCode ([string]$Result.code)) }
}

function Invoke-ReleaseHelper {
    param([string]$Helper, [string]$Command, [string]$Id, [int]$TimeoutSeconds = 0)
    $Limit = if ($TimeoutSeconds -gt 0) { $TimeoutSeconds } elseif ($Command -eq 'verify') { 30 } else { 15 }
    $Native = Invoke-DeploymentProcess -File $NodePath -Arguments @($Helper, $Command, '--data-dir', $RuntimeDir, '--release-id', $Id) -TimeoutSeconds $Limit
    if ($Native.timedOut) { return @{ exitCode=1; result=@{code='DEPLOY_HELPER_TIMEOUT'} } }
    try { $Result = $Native.output | ConvertFrom-Json } catch { $Result = $null }
    return @{ exitCode=$Native.exitCode; result=$Result }
}

function Invoke-DeploymentProcess {
    param([string]$File, [string[]]$Arguments, [int]$TimeoutSeconds = 15)
    $Elapsed = [Diagnostics.Stopwatch]::StartNew()
    $Process = [Diagnostics.Process]::new()
    try {
        $Start = [Diagnostics.ProcessStartInfo]::new()
        $Start.FileName = $File
        $Start.Arguments = ($Arguments | ForEach-Object { ConvertTo-DeploymentArgument ([string]$_) }) -join ' '
        $Start.UseShellExecute = $false
        $Start.CreateNoWindow = $true
        $Start.RedirectStandardOutput = $true
        $Start.RedirectStandardError = $true
        $Process.StartInfo = $Start
        $null = $Process.Start()
        $Output = $Process.StandardOutput.ReadToEndAsync()
        $ErrorOutput = $Process.StandardError.ReadToEndAsync()
        $Remaining = [Math]::Max(0, [int]($TimeoutSeconds * 1000 - $Elapsed.Elapsed.TotalMilliseconds))
        if (-not $Process.WaitForExit($Remaining)) {
            Stop-DeploymentHelper -Process $Process
            return @{ exitCode=1; timedOut=$true; output='' }
        }
        $Remaining = [Math]::Max(0, [int]($TimeoutSeconds * 1000 - $Elapsed.Elapsed.TotalMilliseconds))
        if (-not [Threading.Tasks.Task]::WaitAll([Threading.Tasks.Task[]]@($Output, $ErrorOutput), $Remaining)) {
            return @{ exitCode=1; timedOut=$true; output='' }
        }
        return @{ exitCode=$Process.ExitCode; timedOut=$false; output=$Output.Result }
    } catch {
        try { if (-not $Process.HasExited) { Stop-DeploymentHelper -Process $Process } } catch { }
        return @{ exitCode=1; timedOut=$false; output='' }
    }
    finally { $Process.Dispose() }
}

function ConvertTo-DeploymentArgument {
    param([string]$Value)
    # CommandLineToArgvW quoting; argument values never become PowerShell code.
    $Escaped = [regex]::Replace($Value, '(\\*)"', '$1$1\"')
    $Escaped = [regex]::Replace($Escaped, '(\\+)$', '$1$1')
    return '"' + $Escaped + '"'
}

function Stop-DeploymentHelper {
    param($Process)
    if ($Process.HasExited) { return }
    $Killer = [Diagnostics.Process]::new()
    try {
        $Start = [Diagnostics.ProcessStartInfo]::new()
        $Start.FileName = Join-Path $env:SystemRoot 'System32\taskkill.exe'
        $Start.Arguments = '/PID ' + [int]$Process.Id + ' /T /F'
        $Start.UseShellExecute = $false
        $Start.CreateNoWindow = $true
        $Start.RedirectStandardOutput = $true
        $Start.RedirectStandardError = $true
        $Killer.StartInfo = $Start
        $null = $Killer.Start()
        $DiscardOutput = $Killer.StandardOutput.ReadToEndAsync()
        $DiscardError = $Killer.StandardError.ReadToEndAsync()
        if (-not $Killer.WaitForExit(2000)) { $Killer.Kill() }
    } catch { if (-not $Process.HasExited) { try { $Process.Kill() } catch { } } }
    finally { $Killer.Dispose() }
}

function Assert-ReleaseReady {
    param([string]$Helper, [string]$Id, [switch]$AllowWorkerUpdate)
    $Verified = Invoke-ReleaseHelper -Helper $Helper -Command verify -Id $Id
    if ($Verified.result.code -eq 'DEPLOY_HELPER_TIMEOUT') { throw 'DEPLOY_HELPER_TIMEOUT' }
    if ($Verified.exitCode -ne 0) { throw 'DEPLOY_INTEGRITY_FAILED' }
    $Compatible = Invoke-ReleaseHelper -Helper $Helper -Command worker-compatible -Id $Id
    if ($Compatible.result.compatible -eq $false -and $AllowWorkerUpdate) { return $false }
    if ($Compatible.exitCode -ne 0 -or $Compatible.result.compatible -ne $true) { throw 'DEPLOY_WORKER_UPDATE_REQUIRED' }
    return $true
}

function Get-DeployTaskArguments {
    param([string]$Directory, [string]$Id, [string]$Executable = $NodePath, [switch]$Legacy)
    $Base = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + (Join-Path $Directory 'update.ps1') + '" -Action Apply -OperationId ' + $Id + ' -DataDir "' + $RuntimeDir + '"'
    if ($Legacy) { return $Base }
    return $Base + ' -NodeExecutable "' + $Executable + '"'
}

function Get-StoppedDeploymentResult {
    param([string]$Directory, [string]$Id)
    try {
        $TaskName = 'PocketAgent-Deploy-' + $Id
        $Task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
        if ($Task.Description -ne $DeployDescription -or @($Task.Actions).Count -ne 1 -or [string]$Task.State -in @('Running', 'Queued')) { return $null }
        $Entry = $Task.Actions[0]
        if (-not ([string]$Entry.Execute).Equals($PowerShellPath, [StringComparison]::OrdinalIgnoreCase) -or -not ([string]$Entry.WorkingDirectory).Equals($Directory, [StringComparison]::OrdinalIgnoreCase)) { return $null }
        $Expected = @(Get-DeployTaskArguments -Directory $Directory -Id $Id -Legacy)
        try {
            $Plan = Get-Content -LiteralPath (Join-Path $Directory 'plan.json') -Raw | ConvertFrom-Json
            if ($Plan.nodeExecutable -is [string] -and [IO.Path]::IsPathRooted($Plan.nodeExecutable)) { $Expected += Get-DeployTaskArguments -Directory $Directory -Id $Id -Executable $Plan.nodeExecutable }
        } catch { }
        if (-not @($Expected | Where-Object { ([string]$Entry.Arguments).Equals($_, [StringComparison]::OrdinalIgnoreCase) }).Count) { return $null }
        $Info = Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction Stop
        if ([datetime]$Info.LastRunTime -lt [datetime]'2000-01-01' -or [long]$Info.LastTaskResult -in @(0, 267011)) { return $null }
        return @{ schemaVersion=1; status='failed'; code='DEPLOY_TASK_EXITED' }
    } catch { return $null }
}

function Assert-IndependentDeployment {
    param([string]$Directory, [string]$Id)
    $Task = Get-ScheduledTask -TaskName ('PocketAgent-Deploy-' + $Id) -ErrorAction Stop
    $ExpectedArguments = Get-DeployTaskArguments -Directory $Directory -Id $Id
    $Matching = @($Task.Actions | Where-Object {
        ([string]$_.Execute).Equals($PowerShellPath, [StringComparison]::OrdinalIgnoreCase) -and
        ([string]$_.Arguments).Equals($ExpectedArguments, [StringComparison]::OrdinalIgnoreCase) -and
        ([string]$_.WorkingDirectory).Equals($Directory, [StringComparison]::OrdinalIgnoreCase)
    })
    if ($Task.Description -ne $DeployDescription -or $Matching.Count -ne 1 -or @($Task.Actions).Count -ne 1) { throw 'DEPLOY_TASK_NOT_OWNED' }
    $Forbidden = @()
    foreach ($Name in @('service.json', 'worker.json')) {
        $File = Join-Path $RuntimeDir $Name
        if (Test-Path -LiteralPath $File -PathType Leaf) {
            try { $Record = Get-Content -LiteralPath $File -Raw | ConvertFrom-Json } catch { throw 'DEPLOY_PROCESS_CHECK_FAILED' }
            if ([long]$Record.pid -gt 0) { $Forbidden += [long]$Record.pid }
        }
    }
    $Cursor = [long]$PID
    $Seen = @{}
    for ($Depth = 0; $Cursor -gt 0 -and $Depth -lt 128; $Depth++) {
        if ($Forbidden -contains $Cursor) { throw 'DEPLOY_NOT_DETACHED' }
        if ($Seen.ContainsKey($Cursor)) { throw 'DEPLOY_PROCESS_CHECK_FAILED' }
        $Seen[$Cursor] = $true
        try { $Process = Get-CimInstance Win32_Process -Filter "ProcessId = $Cursor" -ErrorAction Stop } catch { throw 'DEPLOY_PROCESS_CHECK_FAILED' }
        if ($null -eq $Process) { break }
        $ParentId = [long]$Process.ParentProcessId
        if ($ParentId -le 0) { return }
        try { $Parent = Get-CimInstance Win32_Process -Filter "ProcessId = $ParentId" -ErrorAction Stop } catch { throw 'DEPLOY_PROCESS_CHECK_FAILED' }
        if ($null -eq $Parent -or [datetime]$Parent.CreationDate -gt [datetime]$Process.CreationDate) { return }
        $Cursor = $ParentId
    }
    if ($Cursor -gt 0) { throw 'DEPLOY_PROCESS_CHECK_FAILED' }
}

function Get-ReleasePointer {
    param([string]$Name)
    $Path = Join-Path $RuntimeDir $Name
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    try { $Pointer = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json } catch { throw 'DEPLOY_INVALID_MANIFEST' }
    if ($Pointer.schemaVersion -ne 1 -or $Pointer.releaseId -isnot [string] -or $Pointer.releaseId -cnotmatch '^[a-zA-Z0-9_-]{1,80}$') { throw 'DEPLOY_INVALID_MANIFEST' }
    return @{ schemaVersion=1; releaseId=[string]$Pointer.releaseId }
}

function Set-ActiveRelease {
    param($Pointer)
    $Path = Join-Path $RuntimeDir 'active-release.json'
    if ($null -eq $Pointer) {
        if (Test-Path -LiteralPath $Path -PathType Leaf) { Remove-Item -LiteralPath $Path }
    } else { Write-AtomicDeploymentJson -Path $Path -Value $Pointer }
}

function Ensure-WorkerPin {
    param([string]$Id)
    if ($null -eq (Get-ReleasePointer -Name 'pinned-release.json')) {
        Write-AtomicDeploymentJson -Path (Join-Path $RuntimeDir 'pinned-release.json') -Value @{ schemaVersion=1; releaseId=$Id }
    }
}

function Set-WorkerRelease {
    param($Pointer)
    if ($null -eq $Pointer) { throw 'DEPLOY_WORKER_BASELINE_REQUIRED' }
    Write-AtomicDeploymentJson -Path (Join-Path $RuntimeDir 'pinned-release.json') -Value $Pointer
}

function Test-WorkerProcessRunning {
    $File = Join-Path $RuntimeDir 'worker.json'
    if (-not (Test-Path -LiteralPath $File -PathType Leaf)) { return $false }
    try {
        $Record = Get-Content -LiteralPath $File -Raw | ConvertFrom-Json
        return [long]$Record.pid -gt 0 -and $null -ne (Get-Process -Id ([int]$Record.pid) -ErrorAction SilentlyContinue)
    } catch { throw 'DEPLOY_PROCESS_CHECK_FAILED' }
}

function Wait-WorkerMaintenance {
    param([string]$Directory, [string]$Helper, [string]$Id, [int]$TimeoutSeconds = 600)
    Write-DeploymentResult -Directory $Directory -Status waitingForIdle -Code DEPLOY_WAITING_FOR_IDLE
    $Elapsed = [Diagnostics.Stopwatch]::StartNew()
    do {
        if (-not (Test-WorkerProcessRunning)) { return $false }
        $Remaining = [Math]::Max(1, [Math]::Min(15, [int][Math]::Ceiling($TimeoutSeconds - $Elapsed.Elapsed.TotalSeconds)))
        $Claim = Invoke-ReleaseHelper -Helper $Helper -Command maintenance -Id $Id -TimeoutSeconds $Remaining
        if ($Claim.exitCode -eq 0 -and $Claim.result.acquired -eq $true) { return $true }
        if ($Claim.exitCode -ne 2) { throw 'DEPLOY_MAINTENANCE_FAILED' }
        Start-Sleep -Milliseconds 1000
    } while ($Elapsed.Elapsed.TotalSeconds -lt $TimeoutSeconds)
    throw 'DEPLOY_IDLE_TIMEOUT'
}

function Assert-NoLegacyMigration {
    if (Test-Path -LiteralPath (Join-Path $RuntimeDir 'pinned-release.json') -PathType Leaf) { return }
    $File = Join-Path $RuntimeDir 'service.json'
    if (-not (Test-Path -LiteralPath $File -PathType Leaf)) { return }
    try {
        $Record = Get-Content -LiteralPath $File -Raw | ConvertFrom-Json
        if ([long]$Record.pid -gt 0 -and $null -ne (Get-Process -Id ([int]$Record.pid) -ErrorAction SilentlyContinue)) { throw 'DEPLOY_LEGACY_MIGRATION_REQUIRED' }
    } catch {
        if ($_.Exception.Message -eq 'DEPLOY_LEGACY_MIGRATION_REQUIRED') { throw }
        throw 'DEPLOY_PROCESS_CHECK_FAILED'
    }
}

function Invoke-DeploymentControl {
    param([string]$Directory, [string]$ControlRoot, [ValidateSet('Start', 'Stop', 'WorkerStart', 'WorkerStop')][string]$Command)
    $Result = Invoke-DeploymentProcess -File $PowerShellPath -Arguments @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $Directory 'windows.ps1'), '-Action', $Command, '-DataDir', $RuntimeDir, '-ControlRoot', $ControlRoot, '-NodeExecutable', $NodePath) -TimeoutSeconds 45
    if ($Result.exitCode -ne 0) { throw $(if ($Command -in @('Stop', 'WorkerStop')) { 'DEPLOY_STOP_FAILED' } else { 'DEPLOY_START_FAILED' }) }
}

function Wait-DeploymentHealth {
    param([string]$Helper, [string]$Id, [int]$TimeoutSeconds = 75)
    $Elapsed = [Diagnostics.Stopwatch]::StartNew()
    do {
        $Remaining = [Math]::Max(1, [Math]::Min(15, [int][Math]::Ceiling($TimeoutSeconds - $Elapsed.Elapsed.TotalSeconds)))
        $Check = Invoke-ReleaseHelper -Helper $Helper -Command status -Id $Id -TimeoutSeconds $Remaining
        if ($Check.exitCode -eq 0 -and $Check.result.httpReady -eq $true -and $Check.result.workerReady -eq $true -and $Check.result.codexReady -eq $true -and $Check.result.releaseMatches -eq $true -and $Check.result.assetsReady -eq $true) { return }
        Start-Sleep -Milliseconds 500
    } while ($Elapsed.Elapsed.TotalSeconds -lt $TimeoutSeconds)
    throw 'DEPLOY_HEALTH_FAILED'
}

function Invoke-Deployment {
    param([string]$Directory, [string]$Id, $Plan)
    $Lock = $null
    $Previous = $null
    $StopAttempted = $false
    $WorkerStopped = $false
    $WorkerPointerChanged = $false
    $MaintenanceHeld = $false
    $Helper = $null
    try {
        try { $Lock = [IO.File]::Open((Join-Path $RuntimeDir 'deployment.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) } catch { throw 'DEPLOY_BUSY' }
        Assert-IndependentDeployment -Directory $Directory -Id $Id
        $Release = Get-PreparedRelease -Id $Plan.releaseId
        $Helper = Join-Path $Release 'scripts\release.mjs'
        $WorkerCompatible = Assert-ReleaseReady -Helper $Helper -Id $Plan.releaseId -AllowWorkerUpdate:([bool]$Plan.updateWorkerWhenIdle)
        Assert-NoLegacyMigration
        $Previous = Get-ReleasePointer -Name 'active-release.json'
        $PreviousWorker = Get-ReleasePointer -Name 'pinned-release.json'
        if ($null -ne $Previous) {
            $Old = Get-PreparedRelease -Id $Previous.releaseId
            if ((Invoke-ReleaseHelper -Helper (Join-Path $Old 'scripts\release.mjs') -Command verify -Id $Previous.releaseId).exitCode -ne 0) { throw 'DEPLOY_PREVIOUS_RELEASE_INVALID' }
        }
        if (-not $WorkerCompatible) { $MaintenanceHeld = Wait-WorkerMaintenance -Directory $Directory -Helper $Helper -Id $Plan.releaseId }
        Write-DeploymentResult -Directory $Directory -Status accepted -Code DEPLOY_ACCEPTED
        Ensure-WorkerPin -Id $Plan.releaseId
        Write-DeploymentResult -Directory $Directory -Status stopping -Code DEPLOY_HTTP_STOPPING
        $StopAttempted = $true
        Invoke-DeploymentControl -Directory $Directory -ControlRoot $Plan.controlRoot -Command Stop
        if (-not $WorkerCompatible) {
            Invoke-DeploymentControl -Directory $Directory -ControlRoot $Plan.controlRoot -Command WorkerStop
            $WorkerStopped = $true
            $MaintenanceHeld = $false
            Set-WorkerRelease -Pointer @{ schemaVersion=1; releaseId=$Plan.releaseId }
            $WorkerPointerChanged = $true
            Invoke-DeploymentControl -Directory $Directory -ControlRoot $Plan.controlRoot -Command WorkerStart
        }
        Set-ActiveRelease -Pointer @{ schemaVersion=1; releaseId=$Plan.releaseId }
        Write-DeploymentResult -Directory $Directory -Status starting -Code DEPLOY_HTTP_STARTING
        Invoke-DeploymentControl -Directory $Directory -ControlRoot $Plan.controlRoot -Command Start
        Wait-DeploymentHealth -Helper $Helper -Id $Plan.releaseId
        Write-DeploymentResult -Directory $Directory -Status healthy -Code DEPLOY_HEALTHY
    } catch {
        $Code = if ($_.Exception.Message -cmatch '^DEPLOY_[A-Z_]+$') { $_.Exception.Message } else { 'DEPLOY_FAILED' }
        if ($StopAttempted) {
            try {
                if ($WorkerPointerChanged -and (Test-WorkerProcessRunning)) {
                    $Claim = Invoke-ReleaseHelper -Helper $Helper -Command maintenance -Id $Plan.releaseId
                    if ($Claim.exitCode -ne 0 -or $Claim.result.acquired -ne $true) {
                        Write-DeploymentResult -Directory $Directory -Status failed -Code DEPLOY_ROLLBACK_DEFERRED
                        return
                    }
                    $MaintenanceHeld = $true
                }
                Write-DeploymentResult -Directory $Directory -Status rollingBack -Code DEPLOY_ROLLING_BACK
                Invoke-DeploymentControl -Directory $Directory -ControlRoot $Plan.controlRoot -Command Stop
                if ($WorkerPointerChanged) {
                    Invoke-DeploymentControl -Directory $Directory -ControlRoot $Plan.controlRoot -Command WorkerStop
                    $MaintenanceHeld = $false
                    Set-WorkerRelease -Pointer $PreviousWorker
                }
                if ($WorkerStopped) { Invoke-DeploymentControl -Directory $Directory -ControlRoot $Plan.controlRoot -Command WorkerStart }
                Set-ActiveRelease -Pointer $Previous
                Invoke-DeploymentControl -Directory $Directory -ControlRoot $Plan.controlRoot -Command Start
                if ($null -ne $Previous) {
                    $Old = Get-PreparedRelease -Id $Previous.releaseId
                    Wait-DeploymentHealth -Helper (Join-Path $Old 'scripts\release.mjs') -Id $Previous.releaseId
                } else { throw 'DEPLOY_ROLLBACK_NO_BASELINE' }
                Write-DeploymentResult -Directory $Directory -Status rolledBack -Code $Code
            } catch { Write-DeploymentResult -Directory $Directory -Status failed -Code DEPLOY_ROLLBACK_FAILED }
        } else { Write-DeploymentResult -Directory $Directory -Status failed -Code $Code }
    } finally {
        if ($MaintenanceHeld -and $Helper) { $null = Invoke-ReleaseHelper -Helper $Helper -Command maintenance-release -Id $Plan.releaseId }
        if ($null -ne $Lock) { $Lock.Dispose() }
    }
}

function Queue-Deployment {
    param([string]$Id)
    $Release = Get-PreparedRelease -Id $Id
    $null = Assert-ReleaseReady -Helper (Join-Path $SourceRoot 'scripts\release.mjs') -Id $Id -AllowWorkerUpdate:$UpdateWorkerWhenIdle
    Assert-NoLegacyMigration
    $IdForOperation = [guid]::NewGuid().ToString('N')
    $Parent = Join-Path $RuntimeDir 'deployments'
    $null = New-Item -ItemType Directory -Path $Parent -Force
    if (-not (Get-CanonicalDeploymentPath $Parent).Equals([IO.Path]::GetFullPath($Parent), [StringComparison]::OrdinalIgnoreCase)) { throw 'DEPLOY_PATH_INVALID' }
    $Directory = Join-Path $Parent $IdForOperation
    $null = New-Item -ItemType Directory -Path $Directory
    $Directory = Get-OperationDirectory -Id $IdForOperation
    Copy-Item -LiteralPath $PSCommandPath -Destination (Join-Path $Directory 'update.ps1')
    Copy-Item -LiteralPath (Join-Path $SourceRoot 'scripts\windows.ps1') -Destination (Join-Path $Directory 'windows.ps1')
    Write-AtomicDeploymentJson -Path (Join-Path $Directory 'plan.json') -Value @{ schemaVersion=1; releaseId=$Id; controlRoot=$SourceRoot; nodeExecutable=$NodePath; updateWorkerWhenIdle=[bool]$UpdateWorkerWhenIdle; updateHash=(Get-DeploymentFileHash (Join-Path $Directory 'update.ps1')); controlHash=(Get-DeploymentFileHash (Join-Path $Directory 'windows.ps1')) }
    Write-DeploymentResult -Directory $Directory -Status queued -Code DEPLOY_QUEUED
    try {
        $TaskName = 'PocketAgent-Deploy-' + $IdForOperation
        if ($null -ne (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)) { throw 'DEPLOY_TASK_NOT_OWNED' }
        $CurrentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
        $TaskAction = New-ScheduledTaskAction -Execute $PowerShellPath -Argument (Get-DeployTaskArguments -Directory $Directory -Id $IdForOperation) -WorkingDirectory $Directory
        $Principal = New-ScheduledTaskPrincipal -UserId $CurrentIdentity -LogonType Interactive -RunLevel Limited
        $Settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 20) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
        $null = Register-ScheduledTask -TaskName $TaskName -Action $TaskAction -Principal $Principal -Settings $Settings -Description $DeployDescription
        Start-ScheduledTask -TaskName $TaskName
        $Elapsed = [Diagnostics.Stopwatch]::StartNew()
        do {
            $Result = Read-DeploymentResult -Directory $Directory
            if ($Result.status -eq 'queued') {
                $Stopped = Get-StoppedDeploymentResult -Directory $Directory -Id $IdForOperation
                if ($null -ne $Stopped) { throw $Stopped.code }
            }
            if ($Result.status -ne 'queued') {
                if ($Result.status -eq 'failed') { throw $Result.code }
                Write-Output ('DEPLOY_QUEUED ' + $IdForOperation)
                return
            }
            Start-Sleep -Milliseconds 250
        } while ($Elapsed.Elapsed.TotalSeconds -lt 15)
        throw 'DEPLOY_HANDOFF_TIMEOUT'
    } catch {
        # A timed-out handoff may still be running. Never cancel it or replay deployment.
        $Code = Get-SafeDeploymentCode $_.Exception.Message
        if ($Code -ne 'DEPLOY_HANDOFF_TIMEOUT') { Write-DeploymentResult -Directory $Directory -Status failed -Code $Code }
        Write-Output ('DEPLOY_QUEUED ' + $IdForOperation)
        throw $Code
    }
}

try {
    $BootstrapPhase = 'DEPLOY_BOOTSTRAP_FAILED'
    $SourceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
    if ([string]::IsNullOrWhiteSpace($DataDir)) { $DataDir = Join-Path $env:LOCALAPPDATA 'PocketAgent' }
    $RuntimeDir = [IO.Path]::GetFullPath($DataDir)
    $PowerShellPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    if ($Action -eq 'Status') {
        $Directory = Get-BootstrapOperationDirectory -Id $OperationId
        $Result = Read-DeploymentResult -Directory $Directory
        if ($Result.status -eq 'queued') {
            $Stopped = Get-StoppedDeploymentResult -Directory $Directory -Id $OperationId
            if ($null -ne $Stopped) { $Result = $Stopped }
        }
        $Result | ConvertTo-Json -Compress
        exit 0
    }
    if ($Action -eq 'Apply') {
        $Directory = Get-BootstrapOperationDirectory -Id $OperationId
        $BootstrapPhase = 'DEPLOY_BOOTSTRAP_PLAN_FAILED'
        $Plan = Read-BootstrapPlan -Directory $Directory
        if ($NodeExecutable -and -not ([IO.Path]::GetFullPath($NodeExecutable)).Equals($Plan.nodeExecutable, [StringComparison]::OrdinalIgnoreCase)) { throw 'DEPLOY_INVALID_PLAN' }
        $NodeExecutable = $Plan.nodeExecutable
    }
    $NodePath = Resolve-DeploymentNode -Executable $NodeExecutable
    $BootstrapPhase = 'DEPLOY_BOOTSTRAP_CANONICAL_FAILED'
    $RuntimeDir = Get-CanonicalDeploymentPath $RuntimeDir
    if ($Action -eq 'Apply') {
        if (-not (Get-OperationDirectory -Id $OperationId).Equals($Directory, [StringComparison]::OrdinalIgnoreCase)) { throw 'DEPLOY_PATH_INVALID' }
        $CanonicalControl = Get-CanonicalDeploymentPath $Plan.controlRoot
        if (-not $CanonicalControl.Equals($Plan.controlRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'DEPLOY_PATH_INVALID' }
        if ($RuntimeDir.Equals($CanonicalControl, [StringComparison]::OrdinalIgnoreCase) -or $RuntimeDir.StartsWith($CanonicalControl.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'DEPLOY_RUNTIME_INSIDE_CHECKOUT' }
        $BootstrapPhase = 'DEPLOY_FAILED'
        Invoke-Deployment -Directory $Directory -Id $OperationId -Plan $Plan
        $Result = Read-DeploymentResult -Directory $Directory
        if ($Result.status -ne 'healthy') { exit 1 }
    } else {
        $SourceRoot = Get-CanonicalDeploymentPath $SourceRoot
        if ($RuntimeDir.Equals($SourceRoot, [StringComparison]::OrdinalIgnoreCase) -or $RuntimeDir.StartsWith($SourceRoot.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'DEPLOY_RUNTIME_INSIDE_CHECKOUT' }
        $BootstrapPhase = 'DEPLOY_FAILED'
        Queue-Deployment -Id $ReleaseId
    }
} catch {
    $SafeCode = Get-SafeDeploymentCode $_.Exception.Message
    if ($SafeCode -eq 'DEPLOY_FAILED' -and $BootstrapPhase) { $SafeCode = $BootstrapPhase }
    if ($Action -eq 'Apply' -and $Directory) { try { Write-DeploymentResult -Directory $Directory -Status failed -Code $SafeCode } catch { } }
    [Console]::Error.WriteLine($SafeCode)
    exit 1
}
