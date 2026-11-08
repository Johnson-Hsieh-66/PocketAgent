[CmdletBinding()]
param(
    [string]$Checkout = (Get-Location).Path,
    [string]$DataDir = $env:POCKETAGENT_DATA_DIR,
    [switch]$PrepareOnly,
    [ValidateRange(1,1800)][int]$TimeoutSeconds = 180
)
$ErrorActionPreference = 'Stop'
$Checkout = [IO.Path]::GetFullPath($Checkout)
$Manifest = Join-Path $Checkout 'package.json'
if (-not (Test-Path -LiteralPath $Manifest -PathType Leaf) -or
    (Get-Content -LiteralPath $Manifest -Raw | ConvertFrom-Json).name -ne 'pocketagent') { throw 'DEPLOY_CHECKOUT_REQUIRED' }
if ([string]::IsNullOrWhiteSpace($DataDir)) { $DataDir = Join-Path $env:LOCALAPPDATA 'PocketAgent' }
$DataDir = [IO.Path]::GetFullPath($DataDir)
$NodePath = @(Get-Command node -CommandType Application -ErrorAction Stop)[0].Source
$PowerShellPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$Helper = Join-Path $Checkout 'scripts\release.mjs'
$Updater = Join-Path $Checkout 'scripts\update.ps1'
function Invoke-CapturedNative {
    param([string]$Executable, [string[]]$Arguments, [ValidateRange(1,900000)][int]$TimeoutMilliseconds)
    $StartInfo = [Diagnostics.ProcessStartInfo]::new()
    $StartInfo.FileName = $Executable
    $StartInfo.Arguments = (@($Arguments | ForEach-Object { ConvertTo-WindowsArgument ([string]$_) }) -join ' ')
    $StartInfo.WorkingDirectory = $Checkout
    $StartInfo.UseShellExecute = $false
    $StartInfo.CreateNoWindow = $true
    $StartInfo.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
    $StartInfo.RedirectStandardOutput = $true
    $StartInfo.RedirectStandardError = $true
    $Child = [Diagnostics.Process]::new()
    $Child.StartInfo = $StartInfo
    try {
        if (-not $Child.Start()) { throw 'DEPLOY_COMMAND_FAILED' }
        # Drain both streams concurrently: npm warnings are data, not PowerShell errors.
        $Output = $Child.StandardOutput.ReadToEndAsync()
        $Errors = $Child.StandardError.ReadToEndAsync()
        $TimedOut = -not $Child.WaitForExit($TimeoutMilliseconds)
        if ($TimedOut) { Stop-OwnedNativeProcess $Child }
        $OutputReady = $Output.Wait(1000)
        $ErrorsReady = $Errors.Wait(1000)
        $Lines = @()
        if ($OutputReady) { $Lines += $Output.Result -split '\r?\n' }
        if ($ErrorsReady) { $Lines += $Errors.Result -split '\r?\n' }
        return @{ lines=$Lines; exitCode=$(if ($TimedOut) { -1 } else { $Child.ExitCode }); timedOut=$TimedOut }
    } catch {
        # Never expose native output, arguments or exception details in diagnostics.
        try { Stop-OwnedNativeProcess $Child } catch { }
        return @{ lines=@(); exitCode=-1; timedOut=$false }
    } finally { $Child.Dispose() }
}
function ConvertTo-WindowsArgument {
    param([AllowEmptyString()][string]$Argument)
    # ProcessStartInfo.Arguments uses Windows argv rules on .NET Framework.
    # Double backslashes before quotes and the closing quote; quote every argument.
    $Escaped = [regex]::Replace($Argument, '(\\*)"', '$1$1\"')
    $Escaped = [regex]::Replace($Escaped, '(\\+)$', '$1$1')
    return '"' + $Escaped + '"'
}
function Stop-OwnedNativeProcess {
    param([Diagnostics.Process]$Child)
    try { if ($Child.HasExited) { return } } catch { return }
    # Only this directly spawned helper tree is eligible. Scheduler-owned activation
    # has a separate ancestry and must continue even if its Queue caller times out.
    $StopInfo = [Diagnostics.ProcessStartInfo]::new()
    $StopInfo.FileName = Join-Path $env:SystemRoot 'System32\taskkill.exe'
    $StopInfo.Arguments = '/PID ' + [string]$Child.Id + ' /T /F'
    $StopInfo.UseShellExecute = $false
    $StopInfo.CreateNoWindow = $true
    $StopInfo.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
    $StopInfo.RedirectStandardOutput = $true
    $StopInfo.RedirectStandardError = $true
    $Stopper = [Diagnostics.Process]::new()
    $Stopper.StartInfo = $StopInfo
    try {
        if ($Stopper.Start()) {
            $null = $Stopper.StandardOutput.ReadToEndAsync()
            $null = $Stopper.StandardError.ReadToEndAsync()
            if (-not $Stopper.WaitForExit(2000)) { $Stopper.Kill() }
        }
    } catch { } finally { $Stopper.Dispose() }
    try { if (-not $Child.WaitForExit(1000)) { $Child.Kill(); $null = $Child.WaitForExit(1000) } } catch { }
}
function Read-StructuredLine {
    param($Lines, [string]$Property)
    $Found = @($Lines | ForEach-Object {
        try { $Value = [string]$_ | ConvertFrom-Json -ErrorAction Stop; if ($Value.schemaVersion -eq 1 -and $null -ne $Value.$Property) { $Value } } catch { }
    })
    if ($Found.Count -ne 1) { throw 'DEPLOY_RESPONSE_INVALID' }
    return $Found[0]
}
$Preparation = Invoke-CapturedNative $NodePath @($Helper,'prepare','--data-dir',$DataDir) -TimeoutMilliseconds 900000
if ($Preparation.exitCode -ne 0) {
    $PreparationStages = @{
        DEPLOY_PREPARE_PROTOCOL_FAILED='protocol'; DEPLOY_PREPARE_TYPECHECK_FAILED='typecheck'
        DEPLOY_PREPARE_TESTS_FAILED='tests'; DEPLOY_PREPARE_BUILD_FAILED='build'
        DEPLOY_PREPARE_SECRET_CHECK_FAILED='secret'; DEPLOY_PREPARE_INSTALL_FAILED='install'
        DEPLOY_NPM_NOT_FOUND='bootstrap'; DEPLOY_LEGACY_SERVICE_RUNNING='preflight'
        DEPLOY_RUNTIME_INSIDE_CHECKOUT='runtime'; DEPLOY_PREPARE_TIMEOUT='prepare'
    }
    $FailureCode = 'DEPLOY_PREPARE_FAILED'
    $FailureStage = 'prepare'
    if ($Preparation.timedOut) { $FailureCode = 'DEPLOY_PREPARE_TIMEOUT' }
    else {
        # Only the helper's final result is eligible. Native command output stays private.
        $NonemptyLines = @($Preparation.lines | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) })
        if ($NonemptyLines.Count -gt 0) {
            try {
                $Failure = [string]$NonemptyLines[-1] | ConvertFrom-Json -ErrorAction Stop
                if ($Failure.schemaVersion -eq 1 -and $Failure.operation -ceq 'prepare' -and $Failure.status -ceq 'failed' -and
                    $Failure.code -is [string] -and $Failure.code -cin @($PreparationStages.Keys)) {
                    $FailureCode = [string]$Failure.code
                    $FailureStage = $PreparationStages[$FailureCode]
                }
            } catch { }
        }
    }
    @{ schemaVersion=1; status='failed'; stage=$FailureStage; code=$FailureCode } | ConvertTo-Json -Compress
    throw 'DEPLOY_PREPARE_FAILED'
}
$Prepared = Read-StructuredLine $Preparation.lines releaseId
if ($Prepared.schemaVersion -ne 1 -or [string]$Prepared.releaseId -notmatch '^[a-zA-Z0-9_-]{1,80}$') { throw 'DEPLOY_PREPARE_FAILED' }
if ($PrepareOnly) { $Prepared | ConvertTo-Json -Compress; return }
$Compatible = Invoke-CapturedNative $NodePath @($Helper,'worker-compatible','--data-dir',$DataDir,'--release-id',[string]$Prepared.releaseId) -TimeoutMilliseconds 30000
if ($Compatible.timedOut) {
    @{ schemaVersion=1; status='failed'; stage='workerCompatibility'; code='DEPLOY_VERIFY_TIMEOUT' } | ConvertTo-Json -Compress
    throw 'DEPLOY_VERIFY_FAILED'
}
$CompatibilityExit = $Compatible.exitCode
$Compatibility = @($Compatible.lines | ForEach-Object { try { [string]$_ | ConvertFrom-Json -ErrorAction Stop } catch { } } | Where-Object { $null -ne $_.compatible })[0]
if ($null -eq $Compatibility -or ($CompatibilityExit -ne 0 -and $Compatibility.code -ne 'DEPLOY_WORKER_UPDATE_REQUIRED')) {
    @{ schemaVersion=1; status='failed'; stage='workerCompatibility'; code='DEPLOY_VERIFY_FAILED' } | ConvertTo-Json -Compress
    throw 'DEPLOY_VERIFY_FAILED'
}
$QueueArguments = @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',$Updater,'-Action','Queue','-ReleaseId',[string]$Prepared.releaseId,'-DataDir',$DataDir)
if (-not $Compatibility.compatible) { $QueueArguments += '-UpdateWorkerWhenIdle' }
$Queued = Invoke-CapturedNative $PowerShellPath $QueueArguments -TimeoutMilliseconds 30000
$Receipt = @($Queued.lines | ForEach-Object { if ([string]$_ -match '^DEPLOY_QUEUED ([a-zA-Z0-9_-]{1,80})$') { $Matches[1] } })
if ($Queued.timedOut -and $Receipt.Count -eq 0) { throw 'DEPLOY_QUEUE_OUTCOME_UNKNOWN' }
if ($Queued.exitCode -ne 0 -and $Receipt.Count -eq 0) { throw 'DEPLOY_QUEUE_FAILED' }
if ($Receipt.Count -ne 1) { throw 'DEPLOY_RECEIPT_MISSING' }
$OperationId = $Receipt[0]
$Elapsed = [Diagnostics.Stopwatch]::StartNew()
while ($Elapsed.Elapsed.TotalSeconds -lt $TimeoutSeconds) {
    $Remaining = [int][Math]::Max(1, [Math]::Ceiling($TimeoutSeconds * 1000 - $Elapsed.Elapsed.TotalMilliseconds))
    $StatusArguments = @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',$Updater,'-Action','Status','-OperationId',$OperationId,'-DataDir',$DataDir)
    $StatusResult = Invoke-CapturedNative $PowerShellPath $StatusArguments -TimeoutMilliseconds ([Math]::Min(10000, $Remaining))
    if ($StatusResult.timedOut) { break }
    if ($StatusResult.exitCode -ne 0) {
        @{ schemaVersion=1; operationId=$OperationId; releaseId=$Prepared.releaseId; status='pending'; code='DEPLOY_STATUS_UNAVAILABLE' } | ConvertTo-Json -Compress
        return
    }
    try {
        $State = Read-StructuredLine $StatusResult.lines status
        if ($State.code -cnotmatch '^DEPLOY_[A-Z_]+$') { throw 'DEPLOY_RESPONSE_INVALID' }
    } catch {
        @{ schemaVersion=1; operationId=$OperationId; releaseId=$Prepared.releaseId; status='pending'; code='DEPLOY_STATUS_UNAVAILABLE' } | ConvertTo-Json -Compress
        return
    }
    if ($State.status -in @('healthy','rolledBack','failed','waitingForIdle')) {
        @{ schemaVersion=1; operationId=$OperationId; releaseId=$Prepared.releaseId; status=$State.status; code=$State.code } | ConvertTo-Json -Compress
        if ($State.status -in @('rolledBack','failed')) { exit 1 }
        return
    }
    $Remaining = [int][Math]::Max(0, [Math]::Ceiling($TimeoutSeconds * 1000 - $Elapsed.Elapsed.TotalMilliseconds))
    if ($Remaining -gt 0) { Start-Sleep -Milliseconds ([Math]::Min(1000, $Remaining)) }
}
@{ schemaVersion=1; operationId=$OperationId; releaseId=$Prepared.releaseId; status='pending'; code='DEPLOY_STATUS_PENDING' } | ConvertTo-Json -Compress
