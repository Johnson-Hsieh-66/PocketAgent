import { describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';

const script = resolve('scripts/windows.ps1');
const loadFunctions = `
$ErrorActionPreference = 'Stop'
$Tokens = $null
$ParseErrors = $null
$Tree = [Management.Automation.Language.Parser]::ParseFile($env:POCKETAGENT_TEST_SCRIPT, [ref]$Tokens, [ref]$ParseErrors)
if ($ParseErrors.Count) { throw 'STARTUP_SCRIPT_PARSE_FAILED' }
foreach ($Definition in $Tree.FindAll({ param($Node) $Node -is [Management.Automation.Language.FunctionDefinitionAst] }, $true)) {
    . ([scriptblock]::Create($Definition.Extent.Text))
}
`;
const syntheticStart = `
$Action = 'Start'
$ProjectDir = 'C:\\Projects\\PocketAgent'
$EntryPoint = 'C:\\Projects\\PocketAgent\\dist\\server\\src\\server\\index.js'
$RuntimeDir = 'C:\\Runtime\\PocketAgent'
$script:Starts = 0
$script:OwnedChecks = 0
$script:Process = [pscustomobject]@{ Id = 8123; HasExited = $false }
$script:Process | Add-Member -MemberType ScriptMethod -Name Refresh -Value { }
function Test-Path { return $true }
function Get-Command { return [pscustomobject]@{ Source = 'C:\\Tools\\node.exe' } }
function New-Item { }
function Start-Sleep { }
function Start-Process {
    param($FilePath, $ArgumentList, $WorkingDirectory, $WindowStyle, $RedirectStandardOutput, $RedirectStandardError, [switch]$PassThru)
    if ($WindowStyle -ne 'Hidden') { throw 'VISIBLE_CHILD' }
    $script:Starts++
    return $script:Process
}
`;
function options(code: string, extraEnv: Record<string, string> = {}) {
  const command = `${loadFunctions}\ntry {\n${code}\n} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }`;
  return {
    args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')],
    env: { ...process.env, POCKETAGENT_TEST_SCRIPT: script, POCKETAGENT_TEST_NODE: process.execPath, ...extraEnv },
  };
}
function run(code: string, extraEnv: Record<string, string> = {}) {
  const command = options(code, extraEnv);
  return spawnSync('powershell.exe', command.args, { env: command.env, encoding: 'utf8', windowsHide: true, timeout: 10_000 });
}
async function runAsync(code: string, extraEnv: Record<string, string>) {
  const command = options(code, extraEnv);
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolveResult, reject) => {
    const child = spawn('powershell.exe', command.args, { env: command.env, windowsHide: true, timeout: 10_000 });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', data => { stdout += data.toString(); });
    child.stderr.on('data', data => { stderr += data.toString(); });
    child.on('error', reject);
    child.on('close', status => resolveResult({ status, stdout, stderr }));
  });
}

describe.skipIf(process.platform !== 'win32')('Windows service startup readiness', { timeout: 20_000 }, () => {
  it('waits for owned process and HTTP readiness before reporting startup success', () => {
    const result = run(`${syntheticStart}
function Get-OwnedProcess {
    $script:OwnedChecks++
    if ($script:OwnedChecks -gt 1) { return [pscustomobject]@{ ProcessId = 8123 } }
}
$script:Probes = 0
function Test-PocketAgentReady { $script:Probes++; return $script:Probes -ge 2 }
Start-PocketAgent
if ($script:Starts -ne 1 -or $script:Probes -ne 2) { throw 'READINESS_WAS_NOT_AWAITED' }
`);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('PocketAgent started in the background.');
  });

  it('does not report success when a newly launched process exits', () => {
    const result = run(`${syntheticStart}
function Get-OwnedProcess { return $null }
$script:Process.HasExited = $true
Start-PocketAgent
`);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('PocketAgent exited during startup.');
    expect(result.stdout).not.toContain('started');
  });

  it('rejects an unresponsive existing process without launching a duplicate', () => {
    const result = run(`${syntheticStart}
function Get-OwnedProcess { return [pscustomobject]@{ ProcessId = 8123 } }
function Test-PocketAgentReady { return $false }
try { Start-PocketAgent } catch {
    if ($script:Starts -ne 0) { throw 'DUPLICATE_PROCESS_STARTED' }
    throw
}
`);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('process is running but its HTTP service is not responding');
    expect(result.stdout).not.toContain('already running');
  });

  it('times out without probing an unverified process', () => {
    const result = run(`${syntheticStart}
function Get-OwnedProcess { return [pscustomobject]@{ ProcessId = 8124 } }
function Test-PocketAgentReady { throw 'UNOWNED_PROCESS_PROBED' }
Wait-PocketAgentReady -StartedProcess $script:Process -TimeoutSeconds 0
`);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('HTTP service did not become ready');
    expect(result.stderr).not.toContain('UNOWNED_PROCESS_PROBED');
  });

  it('rejects public and wildcard origins before making a probe', () => {
    const result = run(`
$RuntimeDir = 'C:\\Runtime\\PocketAgent'
function Test-Path { return $false }
$env:POCKETAGENT_PORT = '47831'
foreach ($BindMode in @('0.0.0.0', '203.0.113.1', 'example.invalid')) {
    $env:POCKETAGENT_HOST = $BindMode
    if (@(Get-PocketAgentProbeUris).Count -ne 0) { throw 'NON_PRIVATE_PROBE' }
}
Write-Output 'PRIVATE_ORIGINS_ONLY'
`);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('PRIVATE_ORIGINS_ONLY');
  });

  it('checks the HTTP auth response and refuses redirects and unrelated pages', async () => {
    const server = createServer((request, response) => {
      if (request.url === '/ready') response.end(JSON.stringify({ authenticated: false, pairingRequired: true, paired: false }));
      else if (request.url === '/redirect') { response.writeHead(302, { location: '/ready' }); response.end(); }
      else response.end(JSON.stringify({ authenticated: 'true', pairingRequired: true, paired: false }));
    });
    await new Promise<void>(resolveReady => server.listen(0, '127.0.0.1', resolveReady));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('SYNTHETIC_LISTENER_NOT_READY');
      const result = await runAsync(`
function Get-PocketAgentProbeUris { return $env:POCKETAGENT_TEST_URI + $script:ProbePath }
$script:ProbePath = '/ready'
if (-not (Test-PocketAgentReady)) { throw 'HEALTHY_AUTH_REJECTED' }
$script:ProbePath = '/redirect'
if (Test-PocketAgentReady) { throw 'REDIRECT_ACCEPTED' }
$script:ProbePath = '/unrelated'
if (Test-PocketAgentReady) { throw 'UNRELATED_RESPONSE_ACCEPTED' }
Write-Output 'HTTP_READINESS_VERIFIED'
`, { POCKETAGENT_TEST_URI: `http://127.0.0.1:${address.port}` });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('HTTP_READINESS_VERIFIED');
    } finally {
      await new Promise<void>((resolveClosed, reject) => server.close(error => error ? reject(error) : resolveClosed()));
    }
  });

  it('starts worker and HTTP through separate scheduler roots', () => {
    const result = run(`
$TaskName = 'PocketAgent'
$WorkerTaskName = 'PocketAgent-Worker'
$script:Running = @{}
$script:Steps = [Collections.Generic.List[string]]::new()
function Get-OwnedProcess { param($Kind) if ($script:Running[$Kind]) { return [pscustomobject]@{ ProcessId=8123 } } }
function Ensure-OwnedTask { param($Kind) $script:Steps.Add('ensure-' + $Kind) }
function Start-ScheduledTask { param($TaskName) $Kind = if ($TaskName -eq 'PocketAgent-Worker') { 'Worker' } else { 'Http' }; $script:Running[$Kind]=$true; $script:Steps.Add('start-' + $Kind) }
function Wait-OwnedServiceReady { param($Kind) if (-not $script:Running[$Kind]) { throw 'SERVICE_NOT_SCHEDULED' }; $script:Steps.Add('ready-' + $Kind) }
function Start-Process { throw 'DIRECT_CHILD_LAUNCH_FORBIDDEN' }
Start-OwnedService -Kind Http
Write-Output ($script:Steps -join ',')
`);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe('ensure-Worker,start-Worker,ready-Worker,ensure-Http,start-Http,ready-Http');
  });

  it('stops only the HTTP task and never inspects or stops the worker', () => {
    const result = run(`
$TaskName = 'PocketAgent'
$WorkerTaskName = 'PocketAgent-Worker'
$script:Stopped = [Collections.Generic.List[string]]::new()
function Get-OwnedTask { param($Kind, [switch]$IgnoreUnrelated) if ($Kind -ne 'Http') { throw 'WORKER_TOUCHED' }; return [pscustomobject]@{} }
function Get-OwnedProcess { param($Kind) if ($Kind -ne 'Http') { throw 'WORKER_TOUCHED' }; return $null }
function Stop-ScheduledTask { param($TaskName) $script:Stopped.Add($TaskName) }
Stop-OwnedService -Kind Http
Write-Output ($script:Stopped -join ',')
`);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe('PocketAgent');
  });

  it('keeps active HTTP and pinned worker releases distinct and rejects escaping pointers', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pocketagent-windows-release-test-'));
    try {
      for (const id of ['synthetic-http', 'synthetic-worker']) {
        const release = join(directory, 'releases', id);
        mkdirSync(join(release, 'dist/server/src/server'), { recursive: true });
        writeFileSync(join(release, 'package.json'), JSON.stringify({ name: 'pocketagent' }));
        for (const file of ['index.js', 'worker.js']) writeFileSync(join(release, 'dist/server/src/server', file), '// Synthetic entry.\n');
      }
      writeFileSync(join(directory, 'active-release.json'), JSON.stringify({ schemaVersion: 1, releaseId: 'synthetic-http' }));
      writeFileSync(join(directory, 'pinned-release.json'), JSON.stringify({ schemaVersion: 1, releaseId: 'synthetic-worker' }));
      const result = run(`
$RuntimeDir = $env:POCKETAGENT_TEST_RUNTIME
$ProjectDir = 'C:\\Projects\\PocketAgent'
if ((Split-Path -Leaf (Get-LaunchRelease -Kind Http)) -ne 'synthetic-http') { throw 'HTTP_RELEASE_MISMATCH' }
if ((Split-Path -Leaf (Get-LaunchRelease -Kind Worker)) -ne 'synthetic-worker') { throw 'WORKER_RELEASE_MISMATCH' }
Write-Output 'DISTINCT_RELEASES_VERIFIED'
`, { POCKETAGENT_TEST_RUNTIME: directory });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('DISTINCT_RELEASES_VERIFIED');
      writeFileSync(join(directory, 'active-release.json'), JSON.stringify({ schemaVersion: 1, releaseId: '../outside' }));
      const escaped = run(`$RuntimeDir = $env:POCKETAGENT_TEST_RUNTIME; Get-LaunchRelease -Kind Http`, { POCKETAGENT_TEST_RUNTIME: directory });
      expect(escaped.status).toBe(1);
      expect(escaped.stderr).toContain('RELEASE_MANIFEST_INVALID');
      symlinkSync(join(directory, 'releases', 'synthetic-http'), join(directory, 'releases', 'synthetic-alias'), 'junction');
      writeFileSync(join(directory, 'active-release.json'), JSON.stringify({ schemaVersion: 1, releaseId: 'synthetic-alias' }));
      const linked = run(`$RuntimeDir = $env:POCKETAGENT_TEST_RUNTIME; Get-LaunchRelease -Kind Http`, { POCKETAGENT_TEST_RUNTIME: directory });
      expect(linked.status).toBe(1);
      expect(linked.stderr).toContain('RELEASE_PATH_INVALID');
    } finally {
      const target = resolve(directory);
      if (!target.startsWith(resolve(tmpdir()) + sep) || !basename(target).startsWith('pocketagent-windows-release-test-')) throw new Error('UNEXPECTED_SYNTHETIC_DIRECTORY');
      rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });

  it('uses the supplied Node executable without querying the scheduler PATH', () => {
    const result = run(`
$env:PATH=''
$NodeExecutable=Resolve-ServiceNode -Executable $env:POCKETAGENT_TEST_NODE
function Get-Command { throw 'PATH_LOOKUP_FORBIDDEN' }
if (-not [IO.File]::Exists((Get-ServiceNode)) -or (Get-CanonicalPath $NodeExecutable) -ne $NodeExecutable) {throw 'NODE_EXECUTABLE_NOT_PINNED'}
Write-Output 'SERVICE_NODE_WITHOUT_PATH_VERIFIED'
`);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('SERVICE_NODE_WITHOUT_PATH_VERIFIED');
  });

  it('upgrades only the exact owned legacy task action and keeps unrelated tasks intact', () => {
    const result = run(`
$TaskName='PocketAgent'; $ProjectDir='C:\\Projects\\PocketAgent'
$WindowsPowerShellPath='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
$LegacyScheduledArguments='synthetic-exact-legacy-action'
$ScheduledArguments=$LegacyScheduledArguments + ' -NodeExecutable "C:\\Tools\\node.exe"'
$script:Arguments=$LegacyScheduledArguments
$script:Updates=0
function Get-ScheduledTask { return [pscustomobject]@{Actions=@([pscustomobject]@{Execute=$WindowsPowerShellPath;Arguments=$script:Arguments;WorkingDirectory=$ProjectDir})} }
function New-ScheduledTaskAction { param($Execute,$Argument,$WorkingDirectory) return [pscustomobject]@{Arguments=$Argument} }
function Set-ScheduledTask { param($TaskName,$Action) if ($Action.Arguments -ne $ScheduledArguments) {throw 'NODE_NOT_PINNED'}; $script:Updates++ }
function Register-ScheduledTask { throw 'TASK_REPLACEMENT_FORBIDDEN' }
Ensure-OwnedTask -Kind Http
if ($script:Updates -ne 1) {throw 'LEGACY_ACTION_NOT_UPGRADED'}
$script:Arguments=$LegacyScheduledArguments + ' -NoExit'
try { Ensure-OwnedTask -Kind Http; throw 'UNRELATED_TASK_MODIFIED' } catch { if ($_.Exception.Message -notlike '*unrelated*') {throw} }
if ($script:Updates -ne 1) {throw 'UNRELATED_TASK_MODIFIED'}
Write-Output 'ONLY_OWNED_LEGACY_ACTION_UPGRADED'
`);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('ONLY_OWNED_LEGACY_ACTION_UPGRADED');
  });
});
