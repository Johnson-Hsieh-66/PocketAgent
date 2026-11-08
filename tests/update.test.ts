import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';

const script = resolve('scripts/update.ps1');
let directory: string;
function run(code: string) {
  const command = `
$ErrorActionPreference = 'Stop'
$Tokens = $null; $ParseErrors = $null
$Tree = [Management.Automation.Language.Parser]::ParseFile($env:POCKETAGENT_TEST_SCRIPT, [ref]$Tokens, [ref]$ParseErrors)
if ($ParseErrors.Count) { throw 'UPDATE_SCRIPT_PARSE_FAILED' }
foreach ($Definition in $Tree.FindAll({ param($Node) $Node -is [Management.Automation.Language.FunctionDefinitionAst] }, $true)) { . ([scriptblock]::Create($Definition.Extent.Text)) }
$RuntimeDir = $env:POCKETAGENT_TEST_RUNTIME
$NodePath = $env:POCKETAGENT_TEST_NODE
try { ${code} } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }
`;
  return spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], {
    windowsHide: true, encoding: 'utf8', timeout: 15_000,
    env: { ...process.env, POCKETAGENT_TEST_SCRIPT: script, POCKETAGENT_TEST_RUNTIME: directory, POCKETAGENT_TEST_NODE: process.execPath },
  });
}
const orchestration = `
$script:Steps = [Collections.Generic.List[string]]::new()
$script:Active = @{schemaVersion=1;releaseId='synthetic-old'}
$script:Pin = @{schemaVersion=1;releaseId='synthetic-old'}
$script:Status = ''
$script:Code = ''
$Plan = [pscustomobject]@{releaseId='synthetic-new';controlRoot='C:\\Projects\\PocketAgent';updateWorkerWhenIdle=$false}
function Assert-IndependentDeployment { param($Directory,$Id) $script:Steps.Add('independent') }
function Get-PreparedRelease { param($Id) return 'C:\\Runtime\\releases\\' + $Id }
function Assert-ReleaseReady { param($Helper,$Id,[switch]$AllowWorkerUpdate) return $true }
function Assert-NoLegacyMigration { }
function Get-ReleasePointer { param($Name) if ($Name -eq 'pinned-release.json') {return $script:Pin}; return $script:Active }
function Invoke-ReleaseHelper { param($Helper,$Command,$Id) return @{exitCode=0;result=@{acquired=$true}} }
function Write-DeploymentResult { param($Directory,$Status,$Code) $script:Status=$Status; $script:Code=$Code; $script:Steps.Add('state-' + $Status) }
function Ensure-WorkerPin { param($Id) $script:Steps.Add('retain-pin') }
function Set-WorkerRelease { param($Pointer) $script:Pin=$Pointer; $script:Steps.Add('pin-' + $Pointer.releaseId) }
function Set-ActiveRelease { param($Pointer) $script:Active=$Pointer; $script:Steps.Add('active-' + $Pointer.releaseId) }
function Invoke-DeploymentControl { param($Directory,$ControlRoot,$Command) $script:Steps.Add($Command + '-' + $script:Active.releaseId) }
function Wait-DeploymentHealth { param($Helper,$Id) $script:Steps.Add('health-' + $Id) }
function Test-WorkerProcessRunning { return $true }
`;

beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'pocketagent-update-test-')); });
afterEach(() => {
  const target = resolve(directory);
  if (!target.startsWith(resolve(tmpdir()) + sep) || !basename(target).startsWith('pocketagent-update-test-')) throw new Error('UNEXPECTED_SYNTHETIC_DIRECTORY');
  rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

describe.skipIf(process.platform !== 'win32')('independent Windows deployment', { timeout: 20_000 }, () => {
  it('stops HTTP before switching the release and preserves the pinned worker', () => {
    const result = run(`${orchestration}
Invoke-Deployment -Directory $RuntimeDir -Id ('a' * 32) -Plan $Plan
if ($script:Status -ne 'healthy' -or $script:Pin.releaseId -ne 'synthetic-old') { throw 'WORKER_PIN_CHANGED' }
Write-Output ($script:Steps -join ',')
`);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('state-stopping,Stop-synthetic-old,active-synthetic-new,state-starting,Start-synthetic-new,health-synthetic-new,state-healthy');
    expect(result.stdout).not.toContain('WorkerStop');
  });

  it('rolls back the HTTP pointer and validates the previous release after failed health', () => {
    const result = run(`${orchestration}
function Wait-DeploymentHealth { param($Helper,$Id) if ($Id -eq 'synthetic-new') { throw 'DEPLOY_HEALTH_FAILED' }; $script:Steps.Add('health-' + $Id) }
Invoke-Deployment -Directory $RuntimeDir -Id ('a' * 32) -Plan $Plan
if ($script:Status -ne 'rolledBack' -or $script:Code -ne 'DEPLOY_HEALTH_FAILED' -or $script:Active.releaseId -ne 'synthetic-old') { throw 'ROLLBACK_DID_NOT_RESTORE_BASELINE' }
Write-Output ($script:Steps -join ',')
`);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('state-rollingBack,Stop-synthetic-new,active-synthetic-old,Start-synthetic-old,health-synthetic-old,state-rolledBack');
  });

  it('leaves both services untouched when preflight or the deployment lock fails', () => {
    const result = run(`${orchestration}
function Assert-NoLegacyMigration { throw 'DEPLOY_LEGACY_MIGRATION_REQUIRED' }
Invoke-Deployment -Directory $RuntimeDir -Id ('a' * 32) -Plan $Plan
if ($script:Status -ne 'failed' -or $script:Code -ne 'DEPLOY_LEGACY_MIGRATION_REQUIRED' -or $script:Steps -match '^Stop-') { throw 'PREFLIGHT_STOPPED_SERVICE' }
$ExistingLock = [IO.File]::Open((Join-Path $RuntimeDir 'deployment.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
try {
    Invoke-Deployment -Directory $RuntimeDir -Id ('b' * 32) -Plan $Plan
    if ($script:Code -ne 'DEPLOY_BUSY' -or $script:Steps -match '^Stop-') { throw 'LOCK_DID_NOT_PROTECT_SERVICE' }
} finally { $ExistingLock.Dispose() }
Write-Output 'PREFLIGHT_AND_LOCK_PROTECTED'
`);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('PREFLIGHT_AND_LOCK_PROTECTED');
  });

  it('waits for an atomic idle claim before stopping and switching an incompatible worker', () => {
    const result = run(`${orchestration}
$Plan.updateWorkerWhenIdle=$true
function Assert-ReleaseReady { param($Helper,$Id,[switch]$AllowWorkerUpdate) if (-not $AllowWorkerUpdate) {throw 'MISSING_OPT_IN'}; return $false }
function Wait-WorkerMaintenance { param($Directory,$Helper,$Id) $script:Steps.Add('idle-claim'); return $true }
Invoke-Deployment -Directory $RuntimeDir -Id ('a' * 32) -Plan $Plan
if ($script:Status -ne 'healthy' -or $script:Pin.releaseId -ne 'synthetic-new') { throw 'WORKER_NOT_UPDATED' }
Write-Output ($script:Steps -join ',')
`);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('idle-claim,state-accepted,retain-pin,state-stopping,Stop-synthetic-old,WorkerStop-synthetic-old,pin-synthetic-new,WorkerStart-synthetic-old,active-synthetic-new');
  });

  it('defers rollback instead of terminating a new worker with active work', () => {
    const result = run(`${orchestration}
$Plan.updateWorkerWhenIdle=$true
function Assert-ReleaseReady { param($Helper,$Id,[switch]$AllowWorkerUpdate) return $false }
function Wait-WorkerMaintenance { param($Directory,$Helper,$Id) return $true }
function Wait-DeploymentHealth { param($Helper,$Id) throw 'DEPLOY_HEALTH_FAILED' }
function Invoke-ReleaseHelper { param($Helper,$Command,$Id) if ($Command -eq 'maintenance') { return @{exitCode=2;result=@{acquired=$false}} }; return @{exitCode=0;result=@{}} }
Invoke-Deployment -Directory $RuntimeDir -Id ('a' * 32) -Plan $Plan
if ($script:Code -ne 'DEPLOY_ROLLBACK_DEFERRED' -or $script:Pin.releaseId -ne 'synthetic-new' -or @($script:Steps | Where-Object { $_ -like 'WorkerStop-*' }).Count -ne 1) { throw 'ACTIVE_WORKER_WAS_STOPPED' }
Write-Output 'ACTIVE_WORK_PRESERVED'
`);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('ACTIVE_WORK_PRESERVED');
  });

  it('restores both pointers after claiming an idle new worker for rollback', () => {
    const result = run(`${orchestration}
$Plan.updateWorkerWhenIdle=$true
function Assert-ReleaseReady { param($Helper,$Id,[switch]$AllowWorkerUpdate) return $false }
function Wait-WorkerMaintenance { param($Directory,$Helper,$Id) return $true }
function Wait-DeploymentHealth { param($Helper,$Id) if ($Id -eq 'synthetic-new') { throw 'DEPLOY_HEALTH_FAILED' } }
Invoke-Deployment -Directory $RuntimeDir -Id ('a' * 32) -Plan $Plan
if ($script:Status -ne 'rolledBack' -or $script:Active.releaseId -ne 'synthetic-old' -or $script:Pin.releaseId -ne 'synthetic-old' -or @($script:Steps | Where-Object { $_ -like 'WorkerStop-*' }).Count -ne 2) { throw 'WORKER_ROLLBACK_FAILED' }
Write-Output 'BOTH_BASELINES_RESTORED'
`);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('BOTH_BASELINES_RESTORED');
  });

  it('requires explicit worker-update opt-in and writes only allowlisted result codes', () => {
    const result = run(`
function Invoke-ReleaseHelper { param($Helper,$Command,$Id) if ($Command -eq 'verify') {return @{exitCode=0;result=@{}}}; return @{exitCode=1;result=@{compatible=$false}} }
try { Assert-ReleaseReady -Helper 'C:\\Runtime\\release.mjs' -Id 'synthetic-new'; throw 'WORKER_UPDATE_NOT_BLOCKED' } catch { if ($_.Exception.Message -ne 'DEPLOY_WORKER_UPDATE_REQUIRED') {throw} }
if ((Assert-ReleaseReady -Helper 'C:\\Runtime\\release.mjs' -Id 'synthetic-new' -AllowWorkerUpdate) -ne $false) {throw 'WORKER_UPDATE_OPT_IN_REJECTED'}
Write-DeploymentResult -Directory $RuntimeDir -Status failed -Code ('DEPLOY_' + 'SYNTHETIC_PRIVATE_VALUE')
$Result = Read-DeploymentResult -Directory $RuntimeDir
if ($Result.code -ne 'DEPLOY_FAILED' -or $Result.Keys.Count -ne 3) {throw 'UNSAFE_RESULT_METADATA'}
Write-Output 'EXPLICIT_UPDATE_AND_SAFE_METADATA'
`);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('EXPLICIT_UPDATE_AND_SAFE_METADATA');
    expect(result.stdout).not.toContain('SYNTHETIC_PRIVATE_VALUE');
  });

  it('keeps a busy worker untouched when the bounded idle wait expires', () => {
    const result = run(`
$script:Status=''
function Write-DeploymentResult { param($Directory,$Status,$Code) $script:Status=$Status }
function Test-WorkerProcessRunning { return $true }
function Invoke-ReleaseHelper { param($Helper,$Command,$Id) return @{exitCode=2;result=@{acquired=$false}} }
function Start-Sleep { }
try { Wait-WorkerMaintenance -Directory $RuntimeDir -Helper 'C:\\Runtime\\release.mjs' -Id 'synthetic-new' -TimeoutSeconds 0; throw 'BUSY_WORKER_ACCEPTED' } catch {
    if ($_.Exception.Message -ne 'DEPLOY_IDLE_TIMEOUT' -or $script:Status -ne 'waitingForIdle') { throw }
}
Write-Output 'BUSY_WORKER_PRESERVED'
`);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('BUSY_WORKER_PRESERVED');
  });

  it('rejects a deploy task whose process ancestry still contains the service', () => {
    const result = run(`
$PowerShellPath='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
$DeployDescription='PocketAgent managed independent deployment'
$Id='a' * 32
$script:ExpectedArguments=Get-DeployTaskArguments -Directory $RuntimeDir -Id $Id
function Get-ScheduledTask { param($TaskName) return [pscustomobject]@{Description=$DeployDescription;Actions=@([pscustomobject]@{Execute=$PowerShellPath;Arguments=$script:ExpectedArguments;WorkingDirectory=$RuntimeDir})} }
function Test-Path { return $true }
function Get-Content { return '{"pid":9123}' }
function Get-CimInstance {
    param($ClassName,$Filter)
    if ($Filter -eq ('ProcessId = ' + $PID)) { return [pscustomobject]@{ParentProcessId=9123;CreationDate=[datetime]'2026-01-01T00:01:00Z'} }
    return [pscustomobject]@{ParentProcessId=0;CreationDate=[datetime]'2026-01-01T00:00:00Z'}
}
Assert-IndependentDeployment -Directory $RuntimeDir -Id $Id
`);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('DEPLOY_NOT_DETACHED');
  });

  it('enforces a real helper deadline without waiting for its late healthy response', () => {
    writeFileSync(join(directory, 'slow helper.mjs'), "setTimeout(() => console.log(JSON.stringify({ httpReady: true })), 5000);\n");
    const result = run(`
$Watch=[Diagnostics.Stopwatch]::StartNew()
$Result=Invoke-ReleaseHelper -Helper (Join-Path $RuntimeDir 'slow helper.mjs') -Command status -Id 'synthetic-release' -TimeoutSeconds 1
if ($Result.exitCode -ne 1 -or $Result.result.code -ne 'DEPLOY_HELPER_TIMEOUT' -or $Watch.Elapsed.TotalMilliseconds -gt 4000) { throw 'HELPER_DEADLINE_NOT_ENFORCED' }
Write-Output 'HELPER_DEADLINE_ENFORCED'
`);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('HELPER_DEADLINE_ENFORCED');
  });

  it('preserves literal arguments and drains both output streams without a deadlock', () => {
    writeFileSync(join(directory, 'argument helper.mjs'), "process.stderr.write('synthetic diagnostic\\n'.repeat(40000)); console.log(JSON.stringify({ args: process.argv.slice(2) }));\n");
    const result = run(`
$Helper=Join-Path $RuntimeDir 'argument helper.mjs'
$RuntimeDir=$RuntimeDir + '\\synthetic space\\'
$Result=Invoke-ReleaseHelper -Helper $Helper -Command verify -Id 'synthetic-release' -TimeoutSeconds 5
if ($Result.exitCode -ne 0 -or $Result.result.args.Count -ne 5 -or $Result.result.args[2] -ne $RuntimeDir -or $Result.result.args[4] -ne 'synthetic-release') { throw 'HELPER_ARGUMENTS_CORRUPTED' }
Write-Output 'LITERAL_ARGUMENTS_AND_STDIO_VERIFIED'
`);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('LITERAL_ARGUMENTS_AND_STDIO_VERIFIED');
    expect(result.stdout).not.toContain('synthetic diagnostic');
  });

  it('atomically overwrites existing results and active pointers in Windows PowerShell 5.1', () => {
    const result = run(`
Write-DeploymentResult -Directory $RuntimeDir -Status queued -Code DEPLOY_QUEUED
Write-DeploymentResult -Directory $RuntimeDir -Status accepted -Code DEPLOY_ACCEPTED
Write-DeploymentResult -Directory $RuntimeDir -Status healthy -Code DEPLOY_HEALTHY
if ((Read-DeploymentResult -Directory $RuntimeDir).status -ne 'healthy') { throw 'RESULT_OVERWRITE_FAILED' }
Set-ActiveRelease -Pointer @{schemaVersion=1;releaseId='synthetic-old'}
Set-ActiveRelease -Pointer @{schemaVersion=1;releaseId='synthetic-new'}
if ((Get-ReleasePointer -Name 'active-release.json').releaseId -ne 'synthetic-new') { throw 'POINTER_OVERWRITE_FAILED' }
Write-Output 'EXISTING_FILES_ATOMICALLY_REPLACED'
`);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('EXISTING_FILES_ATOMICALLY_REPLACED');
  });

  it('resolves a supplied physical Node executable with an empty PATH', () => {
    const result = run(`
$env:PATH=''
$NodePath=Resolve-DeploymentNode -Executable $env:POCKETAGENT_TEST_NODE
if (-not [IO.File]::Exists($NodePath) -or (Get-CanonicalDeploymentPath $RuntimeDir) -ne $RuntimeDir) { throw 'PINNED_NODE_NOT_USED' }
Write-Output 'NODE_WITHOUT_PATH_VERIFIED'
`);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('NODE_WITHOUT_PATH_VERIFIED');
  });

  it('reports a bootstrap failure over a pre-existing queued result without Node or PATH', () => {
    const id = 'a'.repeat(32);
    const operation = join(directory, 'deployments', id);
    mkdirSync(operation, { recursive: true });
    for (const name of ['update.ps1', 'windows.ps1']) copyFileSync(resolve('scripts', name), join(operation, name));
    const hash = (name: string) => createHash('sha256').update(readFileSync(join(operation, name))).digest('hex').toUpperCase();
    const missingNode = join(directory, 'unavailable-node.exe');
    writeFileSync(join(operation, 'plan.json'), JSON.stringify({ schemaVersion: 1, releaseId: 'synthetic-release', controlRoot: 'C:\\Projects\\PocketAgent', nodeExecutable: missingNode, updateWorkerWhenIdle: false, updateHash: hash('update.ps1'), controlHash: hash('windows.ps1') }));
    writeFileSync(join(operation, 'result.json'), JSON.stringify({ schemaVersion: 1, status: 'queued', code: 'DEPLOY_QUEUED' }));
    const powershell = join(process.env.SystemRoot || process.env.SYSTEMROOT!, 'System32/WindowsPowerShell/v1.0/powershell.exe');
    const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
    const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-File', join(operation, 'update.ps1'), '-Action', 'Apply', '-OperationId', id, '-DataDir', directory, '-NodeExecutable', missingNode], { env: { ...cleanEnv, PATH: '' }, windowsHide: true, encoding: 'utf8', timeout: 10_000 });
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain('DEPLOY_NODE_UNAVAILABLE');
    expect(JSON.parse(readFileSync(join(operation, 'result.json'), 'utf8'))).toEqual({ schemaVersion: 1, status: 'failed', code: 'DEPLOY_NODE_UNAVAILABLE' });
    const status = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-File', script, '-Action', 'Status', '-OperationId', id, '-DataDir', directory], { env: { ...cleanEnv, PATH: '' }, windowsHide: true, encoding: 'utf8', timeout: 10_000 });
    expect(status.status, status.stderr).toBe(0);
    expect(JSON.parse(status.stdout)).toEqual({ schemaVersion: 1, status: 'failed', code: 'DEPLOY_NODE_UNAVAILABLE' });
  });

  it('recognizes an owned stopped legacy deployment without replaying or modifying it', () => {
    const result = run(`
$PowerShellPath='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
$DeployDescription='PocketAgent managed independent deployment'
$Id='a' * 32
$script:TaskState='Ready'
$script:ExpectedArguments=Get-DeployTaskArguments -Directory $RuntimeDir -Id $Id -Legacy
function Get-ScheduledTask { return [pscustomobject]@{Description=$DeployDescription;State=$script:TaskState;Actions=@([pscustomobject]@{Execute=$PowerShellPath;Arguments=$script:ExpectedArguments;WorkingDirectory=$RuntimeDir})} }
function Get-ScheduledTaskInfo { return [pscustomobject]@{LastRunTime=[datetime]'2026-01-01';LastTaskResult=1} }
$Result=Get-StoppedDeploymentResult -Directory $RuntimeDir -Id $Id
if ($Result.code -ne 'DEPLOY_TASK_EXITED' -or $Result.status -ne 'failed') {throw 'STOPPED_TASK_WAS_HIDDEN'}
$script:TaskState='Running'
if ($null -ne (Get-StoppedDeploymentResult -Directory $RuntimeDir -Id $Id)) {throw 'RUNNING_TASK_REJECTED'}
Write-Output 'STOPPED_TASK_RECOGNIZED_WITHOUT_REPLAY'
`);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('STOPPED_TASK_RECOGNIZED_WITHOUT_REPLAY');
  });

  it('keeps paired stop controls within the maintenance lease and passes the pinned Node executable', () => {
    const result = run(`
$PowerShellPath='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
$script:Calls=0
function Invoke-DeploymentProcess {
    param($File,$Arguments,$TimeoutSeconds)
    if ($TimeoutSeconds -ne 45 -or $Arguments[-2] -ne '-NodeExecutable' -or $Arguments[-1] -ne $NodePath) {throw 'CONTROL_LEASE_OR_NODE_NOT_BOUNDED'}
    $script:Calls++
    return @{exitCode=0;timedOut=$false;output=''}
}
Invoke-DeploymentControl -Directory $RuntimeDir -ControlRoot 'C:\\Projects\\PocketAgent' -Command Stop
Invoke-DeploymentControl -Directory $RuntimeDir -ControlRoot 'C:\\Projects\\PocketAgent' -Command WorkerStop
if ($script:Calls -ne 2) {throw 'CONTROL_MISSING'}
Write-Output 'CONTROL_LEASE_BUDGET_VERIFIED'
`);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('CONTROL_LEASE_BUDGET_VERIFIED');
  });
});
