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
$ResultPath = Join-Path $RuntimeDir 'firewall-result.json'
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
    if (Test-Path -LiteralPath $ResultPath) { Get-Content -LiteralPath $ResultPath -Raw | Write-Output }
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
# Windows Filtering Platform matches the executable image, not an NVM junction.
$PhysicalNodePath = & $NodePath -e "process.stdout.write(require('node:fs').realpathSync(process.execPath))"
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($PhysicalNodePath) -or
    -not (Test-Path -LiteralPath $PhysicalNodePath -PathType Leaf)) { throw 'Unable to resolve the Node executable image.' }
$NodeAlias = $NodePath
$NodePath = [string]$PhysicalNodePath
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
$Created = New-NetFirewallRule @Parameters
$ApplicationFilter = $Created | Get-NetFirewallApplicationFilter
$PortFilter = $Created | Get-NetFirewallPortFilter
$AddressFilter = $Created | Get-NetFirewallAddressFilter
$ActiveRule = Get-NetFirewallRule -PolicyStore ActiveStore -Name $RuleName -ErrorAction SilentlyContinue
$Profiles = @(Get-NetFirewallProfile -PolicyStore ActiveStore)
$MatchingNodeBlocks = @(Get-NetFirewallRule -PolicyStore ActiveStore -Enabled True -Direction Inbound -Action Block | ForEach-Object {
    $Filter = $_ | Get-NetFirewallApplicationFilter
    if (([string]$Filter.Program).Equals($NodePath,[StringComparison]::OrdinalIgnoreCase) -or
        ([string]$Filter.Program).Equals($NodeAlias,[StringComparison]::OrdinalIgnoreCase)) { $_ }
})
$Verified = ([string]$ApplicationFilter.Program).Equals($NodePath, [StringComparison]::OrdinalIgnoreCase) -and
    ([string]$PortFilter.LocalPort -eq [string]$ListenerPort) -and
    ([string]$PortFilter.Protocol -in @('TCP', '6')) -and
    (@($AddressFilter.RemoteAddress) -notcontains 'Any')
# Only allowlisted verification metadata is persisted; never executable paths or addresses.
@{success=$Verified;programImageVerified=([string]$ApplicationFilter.Program).Equals($NodePath,[StringComparison]::OrdinalIgnoreCase);port=$ListenerPort;remoteRestricted=(@($AddressFilter.RemoteAddress) -notcontains 'Any');activeRulePresent=($null -ne $ActiveRule);matchingNodeBlockCount=$MatchingNodeBlocks.Count;localRuleMergeDisabledProfileCount=@($Profiles | Where-Object { [string]$_.AllowLocalFirewallRules -eq 'False' }).Count} |
    ConvertTo-Json -Compress | Set-Content -LiteralPath $ResultPath -Encoding UTF8
if (-not $Verified) { throw 'PocketAgent firewall verification failed.' }
Write-Output 'PocketAgent firewall access is limited to its Node executable, configured TCP port and private network ranges.'
