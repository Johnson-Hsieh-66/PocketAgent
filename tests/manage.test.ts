import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { Store } from '../src/server/store.js';

const management = resolve('src/server/manage.ts');
let temporary: string;
let dataDir: string;
function run(args: string[], directory = dataDir) {
  return spawnSync(process.execPath, ['--import', 'tsx', management, ...args], {
    cwd: process.cwd(), encoding: 'utf8', windowsHide: true, timeout: 10_000,
    env: { ...process.env, POCKETAGENT_DATA_DIR: directory, POCKETAGENT_HOST: '127.0.0.1',
      POCKETAGENT_PORT: '47831', CODEX_HOME: join(temporary, 'synthetic-codex-home') },
  });
}
beforeEach(() => {
  temporary = mkdtempSync(join(tmpdir(), 'pocketagent-management-test-'));
  dataDir = join(temporary, 'runtime');
});
afterEach(() => {
  const directory = resolve(temporary);
  if (!directory.startsWith(resolve(tmpdir()) + sep) || !basename(directory).startsWith('pocketagent-management-test-')) {
    throw new Error('Refusing to remove an unexpected management test directory.');
  }
  rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

describe('local pairing management CLI', { timeout: 20_000 }, () => {
  it('reports the default ON mode for a new external runtime', () => {
    const result = run(['pairing', 'status']);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('Device pairing: ON.');
  });

  it('persists OFF/ON across processes and preserves existing device records', () => {
    expect(run(['pairing', 'off']).stdout).toContain('Device pairing: OFF.');
    expect(run(['pairing', 'status']).stdout.trim()).toBe('Device pairing: OFF.');
    let store = new Store(dataDir);
    let token: string;
    try {
      const { code } = store.issuePairCode();
      token = store.pair(code, 'Synthetic retained device')!.token;
    } finally { store.close(); }
    const enabled = run(['pairing', 'on']);
    expect(enabled.status).toBe(0);
    expect(enabled.stdout).toContain('Device pairing: ON.');
    expect(enabled.stdout).not.toContain(token!);
    expect(run(['pairing', 'status']).stdout.trim()).toBe('Device pairing: ON.');
    store = new Store(dataDir);
    try {
      expect(store.pairingRequired()).toBe(true);
      expect(store.devices().map(device => device.name)).toEqual(['Synthetic retained device']);
      expect(store.authenticate(token!)?.name).toBe('Synthetic retained device');
    } finally { store.close(); }
  });

  it('rejects missing, unknown and extra arguments before creating or changing runtime state', () => {
    for (const args of [['pairing'], ['pairing', 'unknown'], ['pairing', 'off', 'extra']]) {
      const invalid = run(args);
      expect(invalid.status).toBe(1);
      expect(invalid.stderr).toContain('Usage:');
      expect(existsSync(dataDir)).toBe(false);
    }
    expect(run(['pairing', 'off']).status).toBe(0);
    const invalid = run(['pairing', 'on', 'extra']);
    expect(invalid.status).toBe(1);
    expect(run(['pairing', 'status']).stdout.trim()).toBe('Device pairing: OFF.');
  });
});
