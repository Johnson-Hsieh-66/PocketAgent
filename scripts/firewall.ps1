[CmdletBinding()]
param(
    [ValidateSet('Install', 'Remove')]
    [string]$Action = 'Install',
    [string]$DataDir = $env:POCKETAGENT_DATA_DIR
)
$ErrorActionPreference = 'Stop'
$RuleName = 'PocketAgent-Private-Web'
$RuleDescription = 'PocketAgent managed private-network listener'
$ProjectDir = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if ([string]::IsNullOrWhiteSpace($DataDir)) { $DataDir = Join-Path $env:LOCALAPPDATA 'PocketAgent' }
$RuntimeDir = [IO.Path]::GetFullPath($DataDir)
if ($RuntimeDir.Equals($ProjectDir, [StringComparison]::OrdinalIgnoreCase) -or
    $RuntimeDir.StartsWith($ProjectDir.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Runtime data must be outside the repository.'
}
$Principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $Principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    $PowerShellPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $Arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $PSCommandPath + '" -Action ' + $Action + ' -DataDir "' + $RuntimeDir + '"'
    try { $Elevated = Start-Process -FilePath $PowerShellPath -ArgumentList $Arguments -Verb RunAs -WindowStyle Hidden -Wait -PassThru }
    catch { throw 'Windows administrator approval is required to manage this firewall rule.' }
    exit $Elevated.ExitCode
}
$Existing = Get-NetFirewallRule -Name $RuleName -ErrorAction SilentlyContinue
if ($null -ne $Existing -and $Existing.Description -ne $RuleDescription) {
    throw 'A different firewall rule has the same name; refusing to change it.'
}
if ($Action -eq 'Remove') {
    if ($null -ne $Existing) { Remove-NetFirewallRule -Name $RuleName }
    Write-Output 'PocketAgent private firewall rule removed.'
    exit 0
}
$Settings = Get-Content -LiteralPath (Join-Path $RuntimeDir 'config.json') -Raw | ConvertFrom-Json
$ListenerPort = [int]$Settings.port
if ($ListenerPort -lt 1 -or $ListenerPort -gt 65535) { throw 'Invalid listener port.' }
$NodePath = @(Get-Command node -CommandType Application -ErrorAction Stop)[0].Source
if (-not (Test-Path -LiteralPath $NodePath -PathType Leaf)) { throw 'Node executable not found.' }
$PrivateLocalRanges = @(
    ((10,0,0,0 -join '.') + '/8'),
    ((172,16,0,0 -join '.') + '/12'),
    ((192,168,0,0 -join '.') + '/16'),
    ((100,64,0,0 -join '.') + '/10')
)
$PrivateRemoteRanges = @('LocalSubnet', ((100,64,0,0 -join '.') + '/10'))
$Parameters = @{
    Name = $RuleName
    DisplayName = 'PocketAgent private web'
    Description = $RuleDescription
    Group = 'PocketAgent'
    Direction = 'Inbound'
    Action = 'Allow'
    Enabled = 'True'
    Profile = 'Any'
    Protocol = 'TCP'
    LocalPort = $ListenerPort
    LocalAddress = $PrivateLocalRanges
    RemoteAddress = $PrivateRemoteRanges
    Program = $NodePath
}
if ($null -ne $Existing) { Remove-NetFirewallRule -Name $RuleName }
New-NetFirewallRule @Parameters | Out-Null
Write-Output 'PocketAgent firewall access is limited to its Node executable, configured TCP port and private network ranges.'
