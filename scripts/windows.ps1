[CmdletBinding()]
param(
    [ValidateSet('Install', 'Remove', 'Start', 'Stop', 'Run', 'WorkerStart', 'WorkerStop', 'WorkerRun')]
    [string]$Action = 'Start',
    [string]$DataDir = $env:POCKETAGENT_DATA_DIR,
    [string]$ControlRoot,
    [string]$NodeExecutable
)

$ErrorActionPreference = 'Stop'
$TaskName = 'PocketAgent'
$WorkerTaskName = 'PocketAgent-Worker'
$ProjectDir = if ($ControlRoot) { [IO.Path]::GetFullPath($ControlRoot) } else { [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')) }
$ControlScript = Join-Path $ProjectDir 'scripts\windows.ps1'
$EntryPoint = [IO.Path]::GetFullPath((Join-Path $ProjectDir 'dist\server\src\server\index.js'))
$WorkerEntryPoint = [IO.Path]::GetFullPath((Join-Path $ProjectDir 'dist\server\src\server\worker.js'))
$HttpWorkingDir = $ProjectDir
$WorkerWorkingDir = $ProjectDir
if ([string]::IsNullOrWhiteSpace($DataDir)) {
    $DataDir = Join-Path $env:LOCALAPPDATA 'PocketAgent'
}
$RuntimeDir = [IO.Path]::GetFullPath($DataDir)
if ($RuntimeDir.Equals($ProjectDir, [StringComparison]::OrdinalIgnoreCase) -or
    $RuntimeDir.StartsWith($ProjectDir.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Runtime data must be outside the public repository.'
}
$StateFile = Join-Path $RuntimeDir 'service.json'
$WorkerStateFile = Join-Path $RuntimeDir 'worker.json'
$WindowsPowerShellPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$ScheduledArguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "' +
    $ControlScript + '" -Action Run -DataDir "' + $RuntimeDir + '"'
$WorkerScheduledArguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "' +
    $ControlScript + '" -Action WorkerRun -DataDir "' + $RuntimeDir + '"'

function Resolve-ServiceNode {
    param([string]$Executable)
    $Process = $null
    try {
        if ([string]::IsNullOrWhiteSpace($Executable)) { $Executable = @(Get-Command node -CommandType Application -ErrorAction Stop)[0].Source }
        if (-not [IO.Path]::IsPathRooted($Executable) -or -not [IO.File]::Exists($Executable)) { throw 'NODE_EXECUTABLE_UNAVAILABLE' }
        $Watch = [Diagnostics.Stopwatch]::StartNew()
        $Process = [Diagnostics.Process]::new()
        $Start = [Diagnostics.ProcessStartInfo]::new()
        $Start.FileName = $Executable
        $Start.Arguments = '-e "process.stdout.write(require(''node:fs'').realpathSync(process.execPath))"'
        $Start.UseShellExecute = $false; $Start.CreateNoWindow = $true
        $Start.RedirectStandardOutput = $true; $Start.RedirectStandardError = $true
        $Process.StartInfo = $Start
        $null = $Process.Start()
        $Output = $Process.StandardOutput.ReadToEndAsync(); $ErrorOutput = $Process.StandardError.ReadToEndAsync()
        if (-not $Process.WaitForExit(5000)) { $Process.Kill(); throw 'NODE_EXECUTABLE_UNAVAILABLE' }
        $Remaining = [Math]::Max(0, [int](5000 - $Watch.Elapsed.TotalMilliseconds))
        if (-not [Threading.Tasks.Task]::WaitAll([Threading.Tasks.Task[]]@($Output, $ErrorOutput), $Remaining)) { throw 'NODE_EXECUTABLE_UNAVAILABLE' }
        $Resolved = [string]$Output.Result
        if ($Process.ExitCode -ne 0 -or -not [IO.Path]::IsPathRooted($Resolved) -or -not [IO.File]::Exists($Resolved)) { throw 'NODE_EXECUTABLE_UNAVAILABLE' }
        return [IO.Path]::GetFullPath($Resolved)
    } catch { throw 'NODE_EXECUTABLE_UNAVAILABLE' }
    finally { if ($null -ne $Process) { $Process.Dispose() } }
}

function Get-ServiceNode {
    if ($NodeExecutable) { return $NodeExecutable }
    return @(Get-Command node -CommandType Application -ErrorAction Stop)[0].Source
}

function Get-CanonicalPath {
    param([string]$Path)
    $Node = Get-ServiceNode
    $Canonical = & $Node -e "process.stdout.write(require('node:fs').realpathSync(process.argv[1]))" $Path 2>$null
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($Canonical)) { throw 'RELEASE_PATH_INVALID' }
    return [IO.Path]::GetFullPath([string]$Canonical)
}

function Get-LaunchRelease {
    param([ValidateSet('Http', 'Worker')][string]$Kind = 'Http')
    $ManifestPath = Join-Path $RuntimeDir $(if ($Kind -eq 'Worker') { 'pinned-release.json' } else { 'active-release.json' })
    if (-not (Test-Path -LiteralPath $ManifestPath -PathType Leaf)) { return $ProjectDir }
    try { $Manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json } catch { throw 'RELEASE_MANIFEST_INVALID' }
    if ($Manifest.schemaVersion -isnot [int] -or $Manifest.schemaVersion -ne 1 -or $Manifest.releaseId -isnot [string] -or $Manifest.releaseId -cnotmatch '^[a-zA-Z0-9_-]{1,80}$') { throw 'RELEASE_MANIFEST_INVALID' }
    $ActualRuntime = Get-CanonicalPath $RuntimeDir
    $ExpectedReleaseRoot = [IO.Path]::GetFullPath((Join-Path $ActualRuntime 'releases'))
    $ReleaseRoot = Get-CanonicalPath $ExpectedReleaseRoot
    if (-not $ReleaseRoot.Equals($ExpectedReleaseRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'RELEASE_PATH_INVALID' }
    $ExpectedRoot = [IO.Path]::GetFullPath((Join-Path $ReleaseRoot $Manifest.releaseId))
    $ReleaseRootPath = Get-CanonicalPath $ExpectedRoot
    if (-not $ReleaseRootPath.Equals($ExpectedRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'RELEASE_PATH_INVALID' }
    $ManifestFile = Join-Path $ReleaseRootPath 'package.json'
    try { $Package = Get-Content -LiteralPath $ManifestFile -Raw | ConvertFrom-Json } catch { throw 'RELEASE_MANIFEST_INVALID' }
    if ($Package.name -ne 'pocketagent') { throw 'RELEASE_MANIFEST_INVALID' }
    $RelativeEntry = if ($Kind -eq 'Worker') { 'dist\server\src\server\worker.js' } else { 'dist\server\src\server\index.js' }
    $ExpectedEntry = [IO.Path]::GetFullPath((Join-Path $ReleaseRootPath $RelativeEntry))
    if (-not (Get-CanonicalPath $ExpectedEntry).Equals($ExpectedEntry, [StringComparison]::OrdinalIgnoreCase)) { throw 'RELEASE_PATH_INVALID' }
    return $ReleaseRootPath
}

function Get-OwnedTask {
    param([switch]$IgnoreUnrelated, [ValidateSet('Http', 'Worker')][string]$Kind = 'Http')
    $Name = if ($Kind -eq 'Worker') { $WorkerTaskName } else { $TaskName }
    $Arguments = if ($Kind -eq 'Worker') { $WorkerScheduledArguments } else { $ScheduledArguments }
    $LegacyArguments = if ($Kind -eq 'Worker') { $LegacyWorkerScheduledArguments } else { $LegacyScheduledArguments }
    $Candidate = Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
    if ($null -eq $Candidate) { return $null }
    if (@($Candidate.Actions).Count -ne 1) {
        if ($IgnoreUnrelated) { return $null }
        throw 'An unrelated PocketAgent task exists; refusing to change or stop it.'
    }
    foreach ($CandidateAction in $Candidate.Actions) {
        if (([string]$CandidateAction.Execute).Equals($WindowsPowerShellPath, [StringComparison]::OrdinalIgnoreCase) -and
            (([string]$CandidateAction.Arguments).Equals($Arguments, [StringComparison]::OrdinalIgnoreCase) -or ($LegacyArguments -and ([string]$CandidateAction.Arguments).Equals($LegacyArguments, [StringComparison]::OrdinalIgnoreCase))) -and
            ([string]$CandidateAction.WorkingDirectory).Equals($ProjectDir, [StringComparison]::OrdinalIgnoreCase)) {
            return $Candidate
        }
    }
    if ($IgnoreUnrelated) { return $null }
    throw 'An unrelated PocketAgent task exists; refusing to change or stop it.'
}

function Get-OwnedProcess {
    param([ValidateSet('Http', 'Worker')][string]$Kind = 'Http')
    $RecordPath = if ($Kind -eq 'Worker') { $WorkerStateFile } else { $StateFile }
    $ExpectedEntryPoint = if ($Kind -eq 'Worker') { $WorkerEntryPoint } else { $EntryPoint }
    if (-not (Test-Path -LiteralPath $RecordPath -PathType Leaf)) { return $null }
    try {
        $Record = Get-Content -LiteralPath $RecordPath -Raw | ConvertFrom-Json
        $ServicePid = [int]$Record.pid
        if ($ServicePid -le 0) { return $null }
        $OwnedProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $ServicePid" -ErrorAction Stop
        if ($null -eq $OwnedProcess) { return $null }
        $ExpectedNode = [IO.Path]::GetFullPath([string]$Record.execPath)
        $ExpectedEntry = [IO.Path]::GetFullPath([string]$Record.entrypoint)
        if (-not [IO.Path]::IsPathRooted([string]$Record.execPath) -or -not [IO.Path]::IsPathRooted([string]$Record.entrypoint)) { return $null }
        if (-not $ExpectedEntry.Equals($ExpectedEntryPoint, [StringComparison]::OrdinalIgnoreCase)) { return $null }
        if (-not ([string]$OwnedProcess.ExecutablePath).Equals($ExpectedNode, [StringComparison]::OrdinalIgnoreCase)) { return $null }
        $CommandLine = [string]$OwnedProcess.CommandLine
        $EntryPattern = '(?i)(?:^|\s)"?' + [regex]::Escape($ExpectedEntry) + '"?(?:\s|$)'
        # npm start supplies the entry relative to the checkout. The external
        # PID record, executable and creation time must still all match.
        $EntryName = if ($Kind -eq 'Worker') { 'worker' } else { 'index' }
        $RelativeEntryPattern = '(?i)(?:^|\s)"?(?:\.[\\/])?dist[\\/]server[\\/]src[\\/]server[\\/]' + $EntryName + '\.js"?(?:\s|$)'
        $LegacyEntry = [IO.Path]::GetFullPath((Join-Path $ProjectDir ('dist\server\src\server\' + $EntryName + '.js')))
        if (-not $ExpectedEntry.Equals($LegacyEntry, [StringComparison]::OrdinalIgnoreCase)) { $RelativeEntryPattern = '(?!)' }
        if ($CommandLine -notmatch $EntryPattern -and $CommandLine -notmatch $RelativeEntryPattern) { return $null }
        $RecordedStart = [DateTimeOffset]::Parse([string]$Record.startedAt).UtcDateTime
        $ActualStart = ([datetime]$OwnedProcess.CreationDate).ToUniversalTime()
        if ([Math]::Abs(($ActualStart - $RecordedStart).TotalSeconds) -gt 15) { return $null }
        return $OwnedProcess
    } catch {
        return $null
    }
}

function Test-WorkerReady {
    try {
        $Node = Get-ServiceNode
        $env:POCKETAGENT_DATA_DIR = $RuntimeDir
        $Result = & $Node $WorkerEntryPoint --probe 2>$null
        return $LASTEXITCODE -eq 0 -and ([string]$Result).Trim() -eq 'POCKETAGENT_WORKER_READY'
    } catch { return $false }
}

function Ensure-OwnedTask {
    param([ValidateSet('Http', 'Worker')][string]$Kind = 'Http', [switch]$AtLogon)
    $Existing = Get-OwnedTask -Kind $Kind
    $Name = if ($Kind -eq 'Worker') { $WorkerTaskName } else { $TaskName }
    $Arguments = if ($Kind -eq 'Worker') { $WorkerScheduledArguments } else { $ScheduledArguments }
    if ($null -ne $Existing -and -not $AtLogon -and ([string]$Existing.Actions[0].Arguments).Equals($Arguments, [StringComparison]::OrdinalIgnoreCase)) { return }
    $TaskAction = New-ScheduledTaskAction -Execute $WindowsPowerShellPath -Argument $Arguments -WorkingDirectory $ProjectDir
    if ($null -ne $Existing -and -not $AtLogon) {
        # Upgrade only an exactly owned legacy action; retain its triggers and principal.
        $null = Set-ScheduledTask -TaskName $Name -Action $TaskAction
        return
    }
    $CurrentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $Principal = New-ScheduledTaskPrincipal -UserId $CurrentIdentity -LogonType Interactive -RunLevel Limited
    $Settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    $Options = @{ TaskName=$Name; Action=$TaskAction; Principal=$Principal; Settings=$Settings; Description='PocketAgent managed independent service'; Force=$true }
    if ($AtLogon) { $Options.Trigger = New-ScheduledTaskTrigger -AtLogOn -User $CurrentIdentity }
    $null = Register-ScheduledTask @Options
}

function Wait-OwnedServiceReady {
    param([ValidateSet('Http', 'Worker')][string]$Kind = 'Http', [int]$TimeoutSeconds = 30)
    $Elapsed = [Diagnostics.Stopwatch]::StartNew()
    do {
        if ($null -ne (Get-OwnedProcess -Kind $Kind)) {
            $Ready = if ($Kind -eq 'Worker') { Test-WorkerReady } else { Test-PocketAgentReady }
            if ($Ready) { return }
        }
        Start-Sleep -Milliseconds 250
    } while ($Elapsed.Elapsed.TotalSeconds -lt $TimeoutSeconds)
    throw 'SERVICE_NOT_READY'
}

function Start-OwnedService {
    param([ValidateSet('Http', 'Worker')][string]$Kind = 'Http')
    if ($Kind -eq 'Http') { Start-OwnedService -Kind Worker }
    Ensure-OwnedTask -Kind $Kind
    if ($null -ne (Get-OwnedProcess -Kind $Kind)) {
        $Ready = if ($Kind -eq 'Worker') { Test-WorkerReady } else { Test-PocketAgentReady }
        if (-not $Ready) { throw 'SERVICE_NOT_RESPONDING' }
        return
    }
    $Name = if ($Kind -eq 'Worker') { $WorkerTaskName } else { $TaskName }
    Start-ScheduledTask -TaskName $Name
    Wait-OwnedServiceReady -Kind $Kind
}

function Stop-OwnedService {
    param([ValidateSet('Http', 'Worker')][string]$Kind = 'Http')
    $ExistingTask = Get-OwnedTask -Kind $Kind -IgnoreUnrelated
    $Name = if ($Kind -eq 'Worker') { $WorkerTaskName } else { $TaskName }
    if ($null -ne $ExistingTask) { Stop-ScheduledTask -TaskName $Name }
    $OwnedProcess = Get-OwnedProcess -Kind $Kind
    if ($null -eq $OwnedProcess) { return }
    $TaskKill = Join-Path $env:SystemRoot 'System32\taskkill.exe'
    try { & $TaskKill /PID ([string]$OwnedProcess.ProcessId) /T /F 2>$null | Out-Null } catch { }
    Start-Sleep -Milliseconds 750
    $StillOwned = Get-OwnedProcess -Kind $Kind
    if ($null -ne $StillOwned) { throw 'SERVICE_STOP_FAILED' }
}

function Start-WorkerProcess {
    if ($null -ne (Get-OwnedProcess -Kind Worker)) {
        if (-not (Test-WorkerReady)) { throw 'WORKER_NOT_RESPONDING' }
        return
    }
    if (-not (Test-Path -LiteralPath $WorkerEntryPoint -PathType Leaf)) { throw 'WORKER_BUILD_REQUIRED' }
    $Node = Get-ServiceNode
    $env:POCKETAGENT_DATA_DIR = $RuntimeDir
    $env:POCKETAGENT_CHECKOUT_DIR = $ProjectDir
    $env:POCKETAGENT_RELEASE_ID = $WorkerReleaseId
    $Started = Start-Process -FilePath $Node -ArgumentList @('"' + $WorkerEntryPoint + '"') -WorkingDirectory $WorkerWorkingDir -WindowStyle Hidden -Wait -PassThru -RedirectStandardOutput (Join-Path $RuntimeDir 'worker.stdout.log') -RedirectStandardError (Join-Path $RuntimeDir 'worker.stderr.log')
    exit $Started.ExitCode
}

function Test-PrivateIPv4 {
    param([string]$Address)
    $Parsed = $null
    if (-not [Net.IPAddress]::TryParse($Address, [ref]$Parsed) -or
        $Parsed.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork) { return $false }
    $Bytes = $Parsed.GetAddressBytes()
    return $Bytes[0] -eq 127 -or $Bytes[0] -eq 10 -or
        ($Bytes[0] -eq 172 -and $Bytes[1] -ge 16 -and $Bytes[1] -le 31) -or
        ($Bytes[0] -eq 192 -and $Bytes[1] -eq 168) -or
        ($Bytes[0] -eq 100 -and $Bytes[1] -ge 64 -and $Bytes[1] -le 127)
}

function Get-PocketAgentProbeUris {
    # Resolve only the same private HTTP origins the service can bind. No
    # credentials, device state or adapter details leave this function.
    $Saved = @{}
    $ConfigFile = Join-Path $RuntimeDir 'config.json'
    if (Test-Path -LiteralPath $ConfigFile -PathType Leaf) {
        $Saved = Get-Content -LiteralPath $ConfigFile -Raw | ConvertFrom-Json
    }
    $BindMode = if ($env:POCKETAGENT_HOST) { $env:POCKETAGENT_HOST } elseif ($Saved.host) { [string]$Saved.host } else { 'private' }
    $Port = if ($env:POCKETAGENT_PORT) { [int]$env:POCKETAGENT_PORT } elseif ($Saved.port) { [int]$Saved.port } else { 47831 }
    if ($Port -lt 1 -or $Port -gt 65535) { return }
    $Addresses = @()
    if ($BindMode -eq 'private') { $Addresses += '127.0.0.1' }
    if ($BindMode -in @('private', 'tailscale')) {
        foreach ($Adapter in [Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()) {
            $Tailscale = $Adapter.Name -match 'tailscale'
            if (-not $Tailscale -and ($BindMode -ne 'private' -or $Adapter.Name -match 'vEthernet|vmware|virtualbox|vbox|docker|podman|wsl|loopback|npcap|hyper-v')) { continue }
            foreach ($Unicast in $Adapter.GetIPProperties().UnicastAddresses) {
                $Address = $Unicast.Address
                if ($Address.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork -or [Net.IPAddress]::IsLoopback($Address)) { continue }
                $Bytes = $Address.GetAddressBytes()
                $InTailscale = $Bytes[0] -eq 100 -and $Bytes[1] -ge 64 -and $Bytes[1] -le 127
                if ((Test-PrivateIPv4 $Address.ToString()) -and $Tailscale -eq $InTailscale) { $Addresses += $Address.ToString() }
            }
        }
    } elseif (Test-PrivateIPv4 $BindMode) { $Addresses += $BindMode }
    foreach ($Address in ($Addresses | Select-Object -Unique)) { 'http://' + $Address + ':' + $Port + '/api/auth' }
}

function Test-PocketAgentReady {
    try {
        foreach ($Uri in (Get-PocketAgentProbeUris)) {
            $Response = $null
            $Reader = $null
            try {
                $Request = [Net.HttpWebRequest]::Create($Uri)
                $Request.Proxy = $null
                $Request.AllowAutoRedirect = $false
                $Request.Timeout = 1000
                $Request.ReadWriteTimeout = 1000
                $Response = $Request.GetResponse()
                if ([int]$Response.StatusCode -ne 200) { continue }
                $Reader = New-Object IO.StreamReader($Response.GetResponseStream())
                $Buffer = New-Object char[] 4096
                $Length = $Reader.ReadBlock($Buffer, 0, $Buffer.Length)
                if ($Length -eq 0 -or $Length -eq $Buffer.Length) { continue }
                $Access = (-join $Buffer[0..($Length - 1)]) | ConvertFrom-Json
                if ($Access.authenticated -is [bool] -and $Access.pairingRequired -is [bool] -and $Access.paired -is [bool]) { return $true }
            } catch { # Startup/network errors are reported with fixed messages by the caller.
            } finally {
                if ($null -ne $Reader) { $Reader.Dispose() }
                if ($null -ne $Response) { $Response.Close() }
            }
        }
    } catch { }
    return $false
}

function Wait-PocketAgentReady {
    param($StartedProcess, [int]$TimeoutSeconds = 15)
    $Elapsed = [Diagnostics.Stopwatch]::StartNew()
    do {
        $StartedProcess.Refresh()
        if ($StartedProcess.HasExited) { throw 'PocketAgent exited during startup. See external runtime diagnostics.' }
        $OwnedProcess = Get-OwnedProcess
        if ($null -ne $OwnedProcess -and [int]$OwnedProcess.ProcessId -eq [int]$StartedProcess.Id -and (Test-PocketAgentReady)) {
            $StartedProcess.Refresh()
            if ($StartedProcess.HasExited) { throw 'PocketAgent exited during startup. See external runtime diagnostics.' }
            return
        }
        Start-Sleep -Milliseconds 250
    } while ($Elapsed.Elapsed.TotalSeconds -lt $TimeoutSeconds)
    throw 'PocketAgent HTTP service did not become ready. See external runtime diagnostics.'
}

function Start-PocketAgent {
    if ($null -ne (Get-OwnedProcess)) {
        if (-not (Test-PocketAgentReady)) { throw 'PocketAgent process is running but its HTTP service is not responding. See external runtime diagnostics.' }
        Write-Output 'PocketAgent is already running.'
        return
    }
    if (-not (Test-Path -LiteralPath $EntryPoint -PathType Leaf)) {
        throw 'Build PocketAgent first with npm run build.'
    }
    $NodePath = Get-ServiceNode
    if ([string]::IsNullOrWhiteSpace($NodePath) -or -not (Test-Path -LiteralPath $NodePath -PathType Leaf)) {
        throw 'Unable to resolve the Node executable.'
    }
    $null = New-Item -ItemType Directory -Path $RuntimeDir -Force
    $env:POCKETAGENT_DATA_DIR = $RuntimeDir
    $env:POCKETAGENT_CHECKOUT_DIR = $ProjectDir
    $env:POCKETAGENT_RELEASE_ID = $HttpReleaseId
    $StartOptions = @{
        FilePath = $NodePath
        ArgumentList = @('"' + $EntryPoint + '"')
        WorkingDirectory = $(if ($HttpWorkingDir) { $HttpWorkingDir } else { $ProjectDir })
        WindowStyle = 'Hidden'
        RedirectStandardOutput = (Join-Path $RuntimeDir 'service.stdout.log')
        RedirectStandardError = (Join-Path $RuntimeDir 'service.stderr.log')
        PassThru = $true
    }
    if ($Action -eq 'Run') { $StartOptions.Wait = $true }
    $StartedProcess = Start-Process @StartOptions
    if ($Action -eq 'Run') { exit $StartedProcess.ExitCode }
    Wait-PocketAgentReady -StartedProcess $StartedProcess
    Write-Output 'PocketAgent started in the background. Runtime diagnostics are stored outside the repository.'
}

try {
$NodeExecutable = Resolve-ServiceNode -Executable $NodeExecutable
$LegacyScheduledArguments = $ScheduledArguments
$LegacyWorkerScheduledArguments = $WorkerScheduledArguments
$ScheduledArguments = $LegacyScheduledArguments + ' -NodeExecutable "' + $NodeExecutable + '"'
$WorkerScheduledArguments = $LegacyWorkerScheduledArguments + ' -NodeExecutable "' + $NodeExecutable + '"'
if (Test-Path -LiteralPath $RuntimeDir -PathType Container) {
    $ActualRuntime = Get-CanonicalPath $RuntimeDir
    $ActualProject = Get-CanonicalPath $ProjectDir
    if ($ActualRuntime.Equals($ActualProject, [StringComparison]::OrdinalIgnoreCase) -or $ActualRuntime.StartsWith($ActualProject.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'RUNTIME_DIRECTORY_INSIDE_CHECKOUT' }
}
$HttpWorkingDir = Get-LaunchRelease -Kind Http
$WorkerWorkingDir = Get-LaunchRelease -Kind Worker
$HttpReleaseId = if (-not $HttpWorkingDir.Equals($ProjectDir, [StringComparison]::OrdinalIgnoreCase)) { Split-Path -Leaf $HttpWorkingDir } else { $null }
$WorkerReleaseId = if (-not $WorkerWorkingDir.Equals($ProjectDir, [StringComparison]::OrdinalIgnoreCase)) { Split-Path -Leaf $WorkerWorkingDir } else { $null }
$EntryPoint = [IO.Path]::GetFullPath((Join-Path $HttpWorkingDir 'dist\server\src\server\index.js'))
$WorkerEntryPoint = [IO.Path]::GetFullPath((Join-Path $WorkerWorkingDir 'dist\server\src\server\worker.js'))

switch ($Action) {
    'Install' {
        if (-not (Test-Path -LiteralPath $EntryPoint -PathType Leaf) -or -not (Test-Path -LiteralPath $WorkerEntryPoint -PathType Leaf)) { throw 'Run npm run build first.' }
        $null = Get-OwnedTask -Kind Http
        $null = Get-OwnedTask -Kind Worker
        Ensure-OwnedTask -Kind Worker -AtLogon
        Ensure-OwnedTask -Kind Http -AtLogon
        Write-Output 'PocketAgent HTTP and Codex worker will start independently when the current user logs in.'
    }
    'Remove' {
        $HttpTask = Get-OwnedTask -Kind Http
        $WorkerTask = Get-OwnedTask -Kind Worker
        if ($null -ne $HttpTask) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false }
        if ($null -ne $WorkerTask) { Unregister-ScheduledTask -TaskName $WorkerTaskName -Confirm:$false }
        Write-Output 'PocketAgent automatic startup removed. Running services have not been stopped.'
    }
    'Stop' {
        Stop-OwnedService -Kind Http
        Write-Output 'PocketAgent HTTP stopped. Codex worker and its work were preserved.'
    }
    'WorkerStop' { Stop-OwnedService -Kind Worker; Write-Output 'PocketAgent Codex worker stopped.' }
    'WorkerStart' { Start-OwnedService -Kind Worker; Write-Output 'PocketAgent Codex worker ready.' }
    'WorkerRun' { Start-WorkerProcess }
    'Run' { Start-OwnedService -Kind Worker; Start-PocketAgent }
    default { Start-OwnedService -Kind Http; Write-Output 'PocketAgent HTTP and Codex worker ready.' }
}
} catch {
    $Code = if ($_.Exception.Message -cmatch '^[A-Z][A-Z_]{2,79}$') { $_.Exception.Message } else { 'SERVICE_CONTROL_FAILED' }
    [Console]::Error.WriteLine($Code)
    exit 1
}
