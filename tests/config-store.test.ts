import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isAllowedHost, loadConfig } from '../src/server/config.js';
import { Store } from '../src/server/store.js';

describe('external runtime configuration and pairing limits', () => {
  let temp: string;
  beforeEach(async () => { temp = await mkdtemp(path.join(os.tmpdir(), 'pocketagent-config-test-')); });
  afterEach(async () => { await rm(temp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); });
  it('generates external config, defaults to Tailscale and rejects runtime inside checkout', async () => {
    const config = loadConfig({ POCKETAGENT_DATA_DIR: temp });
    expect(config.host).toBe('tailscale');
    expect(config.port).toBe(3000);
    expect(config.staticDir).toBe(path.join(config.checkoutDir, 'dist', 'client'));
    expect(config.projectRoots).toEqual([path.dirname(config.checkoutDir)]);
    expect(JSON.parse(await readFile(path.join(temp, 'config.json'), 'utf8')).host).toBe('tailscale');
    expect(() => loadConfig({ POCKETAGENT_DATA_DIR: path.join(config.checkoutDir, 'synthetic-runtime') })).toThrow('RUNTIME_DIRECTORY_INSIDE_CHECKOUT');
  });
  it('accepts only loopback and Tailscale IPv4 addresses and validates roots', async () => {
    const accepted = [[127, 0, 0, 1], [100, 64, 0, 1], [100, 127, 255, 254]].map(octets => octets.join('.'));
    const rejected = [[0, 0, 0, 0], [192, 168, 1, 2], [100, 63, 0, 1], [100, 128, 0, 1]].map(octets => octets.join('.'));
    for (const host of [...accepted, 'tailscale']) expect(isAllowedHost(host)).toBe(true);
    for (const host of [...rejected, '::1', 'example.invalid']) expect(isAllowedHost(host)).toBe(false);
    await writeFile(path.join(temp, 'config.json'), JSON.stringify({ host: '127.0.0.1', port: 3000, projectRoots: ['relative-projects'] }));
    expect(() => loadConfig({ POCKETAGENT_DATA_DIR: temp })).toThrow('INVALID_PROJECT_ROOTS');
    expect(() => loadConfig({ POCKETAGENT_DATA_DIR: temp, POCKETAGENT_HOST: '0.0.0.0' })).toThrow('HOST_MUST_BE_TAILSCALE_OR_LOOPBACK_IPV4');
  });
  it('limits guesses and lets a locally issued replacement code invalidate an earlier code', () => {
    const store = new Store(temp);
    try {
      const initial = store.issuePairCode();
      const wrong = initial.code === '00000000' ? '11111111' : '00000000';
      for (let index = 0; index < 10; index++) expect(store.pair(wrong, 'Synthetic guess')).toBeNull();
      expect(store.pair(initial.code, 'Synthetic locked code')).toBeNull();
      const replacement = store.issuePairCode();
      const paired = store.pair(replacement.code, 'Synthetic paired device');
      expect(paired).not.toBeNull();
      expect(store.devices()).toHaveLength(1);
      store.revoke('all');
      expect(store.authenticate(paired!.token)).toBeNull();
    } finally { store.close(); }
  });
  it('retains submission fingerprints across restarts, rejects duplicate IDs and supports explicit forgetting', () => {
    const fingerprint = createHash('sha256').update('Synthetic submission metadata').digest('hex');
    let store = new Store(temp);
    try {
      expect(store.readSubmission('synthetic-request-id')).toBeNull();
      store.recordSubmission('synthetic-request-id', 'synthetic-thread-id', fingerprint);
      store.close();
      store = new Store(temp);
      expect(store.readSubmission('synthetic-request-id')).toEqual({ threadId: 'synthetic-thread-id', fingerprint });
      expect(() => store.recordSubmission('synthetic-request-id', 'different-synthetic-thread', fingerprint)).toThrow();
      expect(store.readSubmission('synthetic-request-id')?.threadId).toBe('synthetic-thread-id');
      expect(() => store.recordSubmission('unsafe-synthetic-request', 'synthetic-thread-id', 'Synthetic unhashed content')).toThrow('INVALID_SUBMISSION_FINGERPRINT');
      expect(store.readSubmission('unsafe-synthetic-request')).toBeNull();
      store.forgetSubmission('synthetic-request-id');
      store.close();
      store = new Store(temp);
      expect(store.readSubmission('synthetic-request-id')).toBeNull();
    } finally { store.close(); }
  });
});
