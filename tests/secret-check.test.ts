import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';

const scanner = resolve('scripts/secret-check.mjs');
const repositories: string[] = [];
function repository() {
  const directory = mkdtempSync(join(tmpdir(), 'pocketagent-secret-test-'));
  repositories.push(directory);
  execFileSync('git', ['init', '--quiet'], { cwd: directory, windowsHide: true });
  return directory;
}
function write(directory: string, file: string, content: string) {
  const destination = join(directory, file);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, content);
}
function check(directory: string) {
  return spawnSync(process.execPath, [scanner], { cwd: directory, encoding: 'utf8', windowsHide: true });
}
afterEach(() => {
  for (const directory of repositories.splice(0)) {
    const resolved = resolve(directory);
    if (!resolved.startsWith(resolve(tmpdir()) + sep) || !basename(resolved).startsWith('pocketagent-secret-test-')) {
      throw new Error('Refusing to remove an unexpected test path.');
    }
    rmSync(resolved, { recursive: true, force: true });
  }
});

describe('public repository check', { timeout: 15_000 }, () => {
  it('accepts clean source and documentation placeholders', () => {
    const directory = repository();
    write(directory, 'README.md', 'Example: C:\\Projects and http://127.0.0.1:3000\n');
    expect(check(directory).status).toBe(0);
  });

  it('rejects a credential without echoing its value', () => {
    const directory = repository();
    const syntheticCredential = 'sk-' + 'A'.repeat(32);
    write(directory, 'settings.ts', JSON.stringify({ key: syntheticCredential }));
    const result = check(directory);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('settings.ts: API credential');
    expect(result.stderr).not.toContain(syntheticCredential);
  });

  it('checks staged content even when the working copy was cleaned', () => {
    const directory = repository();
    write(directory, 'settings.ts', 'sk-' + 'B'.repeat(32));
    execFileSync('git', ['add', 'settings.ts'], { cwd: directory, windowsHide: true });
    write(directory, 'settings.ts', 'export const mode = "safe";');
    expect(check(directory).status).toBe(1);
  });

  it('rejects runtime files that were force-added despite gitignore', () => {
    const directory = repository();
    write(directory, '.gitignore', '.env\nuploads/\n');
    write(directory, '.env', 'PLACEHOLDER=example\n');
    expect(check(directory).status).toBe(0);
    execFileSync('git', ['add', '-f', '.env'], { cwd: directory, windowsHide: true });
    expect(check(directory).status).toBe(1);
  });

  it('rejects personal paths and unexpected binary files', () => {
    const directory = repository();
    const syntheticUserPath = ['C:', 'Users', 'SyntheticPerson', 'Documents', 'file.txt'].join('\\');
    write(directory, 'debug.txt', syntheticUserPath);
    writeFileSync(join(directory, 'capture.png'), Buffer.from([0, 1, 2, 3]));
    const result = check(directory);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('debug.txt: personal Windows path');
    expect(result.stderr).toContain('capture.png: binary file requires review');
  });
});
