import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';

const source = resolve('skills/pocketagent-update/scripts/update-service.ps1');
const releaseSource = resolve('scripts/release.mjs');
const receipt = 'a'.repeat(32);
let directory: string;
let checkout: string;
let runtime: string;

const releaseHelper = `
const action = process.argv[2];
const mode = process.env.POCKETAGENT_SYNTHETIC_MODE;
if (action === 'prepare') {
  if (mode === 'warning') console.error('npm warn SYNTHETIC_NO_RAW_OUTPUT_' + 'x'.repeat(100_000));
  console.log(JSON.stringify({ schemaVersion: 1, releaseId: 'synthetic-new' }));
} else if (action === 'worker-compatible') {
  if (mode === 'slow-compatibility') {
    const { writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    writeFileSync(join(process.argv[process.argv.indexOf('--data-dir') + 1], 'compatibility-helper.pid'), String(process.pid));
    setInterval(() => {}, 1000);
  } else {
    const compatible = mode !== 'worker-change';
    console.log(JSON.stringify({ compatible, code: compatible ? 'DEPLOY_WORKER_COMPATIBLE' : 'DEPLOY_WORKER_UPDATE_REQUIRED' }));
    if (!compatible) process.exitCode = 1;
  }
} else process.exitCode = 1;
`;
const updater = `
param($Action, $ReleaseId, $DataDir, $OperationId, [switch]$UpdateWorkerWhenIdle)
$Mode = $env:POCKETAGENT_SYNTHETIC_MODE
if ($Action -eq 'Queue') {
    Add-Content -LiteralPath (Join-Path $DataDir 'queue-calls.txt') -Value 'synthetic-queue'
    if ($Mode -eq 'worker-change' -and -not $UpdateWorkerWhenIdle) { exit 41 }
    Write-Output ('DEPLOY_QUEUED ' + ('a' * 32))
    if ($Mode -eq 'ambiguous') { [Console]::Error.WriteLine('DEPLOY_HANDOFF_TIMEOUT'); exit 1 }
    exit 0
}
if ($Action -eq 'Status') {
    if ($Mode -eq 'slow-status') {
        [IO.File]::WriteAllText((Join-Path $DataDir 'status-helper.pid'), [string]$PID)
        Start-Sleep -Seconds 30
    }
    if ($Mode -eq 'status-unavailable') { exit 1 }
    if ($Mode -eq 'invalid-status') { Write-Output 'SYNTHETIC_INVALID_STATUS'; exit 0 }
    $Status = if ($Mode -eq 'worker-change') { 'waitingForIdle' } elseif ($Mode -eq 'rollback') { 'rolledBack' } else { 'healthy' }
    @{ schemaVersion=1; status=$Status; code='DEPLOY_SYNTHETIC' } | ConvertTo-Json -Compress
    exit 0
}
exit 42
`;

function environment(inherited: NodeJS.ProcessEnv, overrides: Record<string, string>) {
  const result = { ...inherited };
  for (const [key, value] of Object.entries(overrides)) {
    for (const existing of Object.keys(result)) if (existing.toLowerCase() === key.toLowerCase()) delete result[existing];
    result[key] = value;
  }
  return result;
}
function run(mode: string, timeoutSeconds = 5, extraEnv: Record<string, string> = {}, inheritedEnv: NodeJS.ProcessEnv = process.env) {
  const started = performance.now();
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(checkout, 'update-service.ps1'),
    '-Checkout', checkout, '-DataDir', runtime, '-TimeoutSeconds', String(timeoutSeconds),
  ], {
    windowsHide: true, encoding: 'utf8', timeout: 15_000,
    env: environment(inheritedEnv, { ...extraEnv, POCKETAGENT_SYNTHETIC_MODE: mode }),
  });
  return { ...result, elapsedMs: performance.now() - started };
}
function outcome(stdout: string) {
  return JSON.parse(stdout.trim().split(/\r?\n/).at(-1)!);
}
function alive(pid: number) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'pocketagent-update-skill-test-'));
  checkout = join(directory, 'synthetic checkout & no-shell');
  runtime = join(directory, 'external runtime');
  mkdirSync(join(checkout, 'scripts'), { recursive: true });
  mkdirSync(runtime);
  copyFileSync(source, join(checkout, 'update-service.ps1'));
  writeFileSync(join(checkout, 'package.json'), JSON.stringify({ name: 'pocketagent' }));
  writeFileSync(join(checkout, 'scripts/release.mjs'), releaseHelper);
  writeFileSync(join(checkout, 'scripts/update.ps1'), updater);
});
afterEach(() => {
  const target = resolve(directory);
  if (!target.startsWith(resolve(tmpdir()) + sep) || !basename(target).startsWith('pocketagent-update-skill-test-')) throw new Error('UNEXPECTED_SYNTHETIC_DIRECTORY');
  for (const name of ['status-helper.pid', 'compatibility-helper.pid']) {
    const pidFile = join(runtime, name);
    if (existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, 'utf8'));
      if (Number.isSafeInteger(pid) && pid > 0 && alive(pid)) {
        spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 3000, stdio: 'ignore' });
      }
    }
  }
  rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

describe.skipIf(process.platform !== 'win32')('PocketAgent update skill forward execution', { timeout: 20_000 }, () => {
  it('accepts successful preparation warnings without deadlocking or exposing raw output', () => {
    const result = run('warning');
    expect(result.status, result.stderr).toBe(0);
    expect(outcome(result.stdout)).toMatchObject({ operationId: receipt, status: 'healthy' });
    expect(result.stdout + result.stderr).not.toContain('SYNTHETIC_NO_RAW_OUTPUT');
  });

  it('reports the actual failing prepare gate through the real helper without exposing native output or queuing', () => {
    copyFileSync(releaseSource, join(checkout, 'scripts/release.mjs'));
    const npm = join(checkout, 'synthetic-npm.mjs');
    writeFileSync(npm, `
if (process.argv[2] === 'run' && process.argv[3] === 'test') {
  console.log('SYNTHETIC_SECRET_TOKEN');
  console.error('C:\\\\Synthetic Private\\\\prompt.txt');
  process.exitCode = 1;
}
`);
    const active = JSON.stringify({ schemaVersion: 1, releaseId: 'synthetic-current' });
    for (const name of ['active-release.json', 'pinned-release.json']) writeFileSync(join(runtime, name), active);
    const inheritedEnv = { ...process.env, NPM_EXECPATH: join(checkout, 'synthetic-inherited-npm.mjs') };
    const result = run('real-prepare-failure', 5, { npm_execpath: npm }, inheritedEnv);
    expect(result.status).toBe(1);
    expect(outcome(result.stdout)).toEqual({ schemaVersion: 1, status: 'failed', stage: 'tests', code: 'DEPLOY_PREPARE_TESTS_FAILED' });
    expect(result.stderr).toContain('DEPLOY_PREPARE_FAILED');
    expect(result.stdout + result.stderr).not.toContain('SYNTHETIC_SECRET_TOKEN');
    expect(result.stdout + result.stderr).not.toContain('Synthetic Private');
    expect(existsSync(join(runtime, 'queue-calls.txt'))).toBe(false);
    for (const name of ['active-release.json', 'pinned-release.json']) expect(readFileSync(join(runtime, name), 'utf8')).toBe(active);
  });

  it('reports a known bootstrap failure before any preparation gate or Queue', () => {
    copyFileSync(releaseSource, join(checkout, 'scripts/release.mjs'));
    const inheritedNpm = join(checkout, 'synthetic-inherited-npm.mjs');
    writeFileSync(inheritedNpm, 'process.exitCode = 73;');
    const result = run('missing-npm', 5, { npm_execpath: join(checkout, 'synthetic-missing-npm.mjs') }, { ...process.env, NPM_EXECPATH: inheritedNpm });
    expect(result.status).toBe(1);
    expect(outcome(result.stdout)).toEqual({ schemaVersion: 1, status: 'failed', stage: 'bootstrap', code: 'DEPLOY_NPM_NOT_FOUND' });
    expect(existsSync(join(runtime, 'queue-calls.txt'))).toBe(false);
  });

  it.each([
    ['DEPLOY_SYNTHETIC_SECRET_TOKEN', 'DEPLOY_PREPARE_FAILED', 'prepare'],
    ['deploy_prepare_tests_failed', 'DEPLOY_PREPARE_FAILED', 'prepare'],
    ['DEPLOY_PREPARE_TESTS_FAILED', 'DEPLOY_PREPARE_TESTS_FAILED', 'tests'],
  ])('allows only fixed preparation failure metadata and ignores native fields: %s', (nativeCode, code, stage) => {
    writeFileSync(join(checkout, 'scripts/release.mjs'), `
console.log('SYNTHETIC_RAW_SECRET_TOKEN');
console.error(JSON.stringify({schemaVersion:1,operation:'prepare',status:'failed',code:${JSON.stringify(nativeCode)},stage:'C:/Synthetic Private/prompt.txt',message:'SYNTHETIC_MESSAGE_SECRET_TOKEN'}));
process.exitCode=1;
`);
    const result = run('unsafe-native-failure');
    expect(result.status).toBe(1);
    expect(outcome(result.stdout)).toEqual({ schemaVersion: 1, status: 'failed', stage, code });
    expect(result.stdout + result.stderr).not.toContain('SECRET_TOKEN');
    expect(result.stdout + result.stderr).not.toContain('Synthetic Private');
    expect(existsSync(join(runtime, 'queue-calls.txt'))).toBe(false);
  });

  it('keeps an ambiguous handoff receipt and reads its actual result without replaying Queue', () => {
    const result = run('ambiguous');
    expect(result.status, result.stderr).toBe(0);
    expect(outcome(result.stdout)).toMatchObject({ operationId: receipt, status: 'healthy' });
    expect(readFileSync(join(runtime, 'queue-calls.txt'), 'utf8').trim().split(/\r?\n/)).toEqual(['synthetic-queue']);
    expect(result.stdout + result.stderr).not.toContain('DEPLOY_HANDOFF_TIMEOUT');
  });

  it('returns pending with its receipt when one status helper exceeds the remaining deadline', () => {
    const result = run('slow-status', 1);
    expect(result.status, result.stderr).toBe(0);
    expect(outcome(result.stdout)).toMatchObject({ operationId: receipt, status: 'pending', code: 'DEPLOY_STATUS_PENDING' });
    expect(result.elapsedMs).toBeLessThan(10_000);
    const pid = Number(readFileSync(join(runtime, 'status-helper.pid'), 'utf8'));
    expect(alive(pid), 'The wrapper must stop only its timed-out helper tree.').toBe(false);
  });

  it('reports a real compatibility helper timeout before Queue and stops its owned helper', () => {
    const wrapper = join(checkout, 'update-service.ps1');
    const original = readFileSync(wrapper, 'utf8');
    // Use a shorter deadline only in the synthetic copy; execute the actual
    // native helper and timeout branch without making the regression wait 30s.
    const shortened = original.replace(/(\$Compatible = Invoke-CapturedNative[^\r\n]+-TimeoutMilliseconds )30000/, (_match, prefix: string) => prefix + '2000');
    expect(shortened).not.toBe(original);
    writeFileSync(wrapper, shortened);
    const result = run('slow-compatibility');
    expect(result.status).toBe(1);
    expect(outcome(result.stdout)).toEqual({ schemaVersion: 1, status: 'failed', stage: 'workerCompatibility', code: 'DEPLOY_VERIFY_TIMEOUT' });
    expect(result.stderr).toContain('DEPLOY_VERIFY_FAILED');
    expect(existsSync(join(runtime, 'queue-calls.txt'))).toBe(false);
    const pid = Number(readFileSync(join(runtime, 'compatibility-helper.pid'), 'utf8'));
    expect(alive(pid)).toBe(false);
  });

  it('requests an idle worker update and reports waiting without claiming success', () => {
    const result = run('worker-change');
    expect(result.status, result.stderr).toBe(0);
    expect(outcome(result.stdout)).toMatchObject({ operationId: receipt, status: 'waitingForIdle' });
  });

  it.each(['status-unavailable', 'invalid-status'])('preserves the receipt when status is unavailable: %s', mode => {
    const result = run(mode);
    expect(result.status, result.stderr).toBe(0);
    expect(outcome(result.stdout)).toMatchObject({ operationId: receipt, status: 'pending', code: 'DEPLOY_STATUS_UNAVAILABLE' });
  });

  it('reports rollback as a failed deployment while retaining the operation receipt', () => {
    const result = run('rollback');
    expect(result.status, result.stderr).toBe(1);
    expect(outcome(result.stdout)).toMatchObject({ operationId: receipt, status: 'rolledBack' });
  });

  it('passes empty, quoted, trailing-backslash and shell-looking arguments without interpretation', () => {
    const echo = join(checkout, 'echo-arguments.mjs');
    writeFileSync(echo, 'console.log(JSON.stringify(process.argv.slice(2)));');
    const values = ['', 'synthetic space', 'synthetic"quote', 'synthetic\\"quote', 'C:\\Synthetic Path\\', '& echo SYNTHETIC_SHELL', '$(' + 'synthetic)'];
    const command = `
$ErrorActionPreference='Stop'
$Tokens=$null; $Errors=$null
$Tree=[Management.Automation.Language.Parser]::ParseFile($env:POCKETAGENT_SYNTHETIC_WRAPPER,[ref]$Tokens,[ref]$Errors)
if ($Errors.Count) { throw 'SYNTHETIC_PARSE_FAILED' }
foreach ($Definition in $Tree.FindAll({param($Node) $Node -is [Management.Automation.Language.FunctionDefinitionAst]},$true)) { . ([scriptblock]::Create($Definition.Extent.Text)) }
$Checkout=$env:POCKETAGENT_SYNTHETIC_CHECKOUT
$Arguments=[Collections.Generic.List[string]]::new()
$Arguments.Add($env:POCKETAGENT_SYNTHETIC_ECHO)
foreach ($Value in ($env:POCKETAGENT_SYNTHETIC_ARGUMENTS | ConvertFrom-Json)) { $Arguments.Add([string]$Value) }
$Result=Invoke-CapturedNative -Executable $env:POCKETAGENT_SYNTHETIC_NODE -Arguments $Arguments.ToArray() -TimeoutMilliseconds 5000
if ($Result.exitCode -ne 0) { throw 'SYNTHETIC_ECHO_FAILED' }
$Result.lines | Where-Object { $_.Length -gt 0 } | Write-Output
`;
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], {
      windowsHide: true, encoding: 'utf8', timeout: 10_000,
      env: {
        ...process.env,
        POCKETAGENT_SYNTHETIC_WRAPPER: source, POCKETAGENT_SYNTHETIC_CHECKOUT: checkout,
        POCKETAGENT_SYNTHETIC_ECHO: echo, POCKETAGENT_SYNTHETIC_NODE: process.execPath,
        POCKETAGENT_SYNTHETIC_ARGUMENTS: JSON.stringify(values),
      },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(outcome(result.stdout)).toEqual(values);
  });
});
