import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { isAllowedHost, isLanAddress, isTailscaleAddress, isLoopbackAddress, loadConfig } from '../src/server/config.js';
import { Store } from '../src/server/store.js';

describe('external runtime configuration and pairing limits', () => {
  let temp: string;
  beforeEach(async () => { temp = await mkdtemp(path.join(os.tmpdir(), 'pocketagent-config-test-')); });
  afterEach(async () => { await rm(temp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); });
  it('generates external config, defaults to private interfaces and rejects runtime inside checkout', async () => {
    const config = loadConfig({ POCKETAGENT_DATA_DIR: temp });
    expect(config.host).toBe('private');
    expect(config.port).toBe(47831);
    expect(config.staticDir).toBe(path.join(config.checkoutDir, 'dist', 'client'));
    expect(config.projectRoots).toEqual([]);
    const saved = JSON.parse(await readFile(path.join(temp, 'config.json'), 'utf8'));
    expect(saved.host).toBe('private');
    expect(saved).not.toHaveProperty('projectRoots');
    expect(() => loadConfig({ POCKETAGENT_DATA_DIR: path.join(config.checkoutDir, 'synthetic-runtime') })).toThrow('RUNTIME_DIRECTORY_INSIDE_CHECKOUT');
  });
  it('classifies canonical private IPv4 ranges and rejects public or malformed hosts', async () => {
    const loopback = [[127, 0, 0, 0], [127, 255, 255, 255]].map(octets => octets.join('.'));
    const tailscale = [[100, 64, 0, 0], [100, 127, 255, 255]].map(octets => octets.join('.'));
    const lan = [[10, 0, 0, 0], [10, 255, 255, 255], [172, 16, 0, 0], [172, 31, 255, 255], [192, 168, 0, 0], [192, 168, 255, 255]].map(octets => octets.join('.'));
    const publicHosts = [[0, 0, 0, 0], [9, 255, 255, 255], [11, 0, 0, 0], [172, 15, 255, 255], [172, 32, 0, 0], [192, 167, 255, 255], [192, 169, 0, 0], [100, 63, 255, 255], [100, 128, 0, 0], [169, 254, 1, 1], [255, 255, 255, 255]].map(octets => octets.join('.'));
    for (const host of [...loopback, ...tailscale, ...lan, 'private', 'tailscale']) expect(isAllowedHost(host)).toBe(true);
    for (const host of loopback) { expect(isLoopbackAddress(host)).toBe(true); expect(isLanAddress(host)).toBe(false); expect(isTailscaleAddress(host)).toBe(false); }
    for (const host of tailscale) { expect(isTailscaleAddress(host)).toBe(true); expect(isLanAddress(host)).toBe(false); expect(isLoopbackAddress(host)).toBe(false); }
    for (const host of lan) { expect(isLanAddress(host)).toBe(true); expect(isTailscaleAddress(host)).toBe(false); expect(isLoopbackAddress(host)).toBe(false); }
    const malformed = [['127', '00', '0', '1'].join('.'), '127.0.0', '127.0.0.1.0', '127.0.0.-1', '127.0.0.256', '127.0.0.1 ', '127.0.0.1:3000', '127.0.0.1/8', 'http://127.0.0.1', '::1', '[::1]', '::ffff:127.0.0.1', 'example.invalid'];
    for (const host of [...publicHosts, ...malformed]) {
      expect(isAllowedHost(host)).toBe(false);
      expect(isLanAddress(host)).toBe(false);
      expect(isTailscaleAddress(host)).toBe(false);
      expect(isLoopbackAddress(host)).toBe(false);
    }
    await writeFile(path.join(temp, 'config.json'), JSON.stringify({ host: '127.0.0.1', port: 3000, projectRoots: ['relative-projects'] }));
    expect(() => loadConfig({ POCKETAGENT_DATA_DIR: temp })).toThrow('INVALID_PROJECT_ROOTS');
    expect(() => loadConfig({ POCKETAGENT_DATA_DIR: temp, POCKETAGENT_HOST: '0.0.0.0' })).toThrow('HOST_MUST_BE_PRIVATE_OR_LOOPBACK_IPV4');
  });
  it('preserves explicitly configured legacy Tailscale-only mode', async () => {
    const initial = loadConfig({ POCKETAGENT_DATA_DIR: temp });
    const legacyRoots = [path.join(temp, 'synthetic-legacy-parent')];
    await writeFile(path.join(temp, 'config.json'), JSON.stringify({ host: 'tailscale', port: initial.port, projectRoots: legacyRoots }));
    const legacy = loadConfig({ POCKETAGENT_DATA_DIR: temp });
    expect(legacy.host).toBe('tailscale');
    expect(legacy.projectRoots).toEqual(legacyRoots);
    expect(JSON.parse(await readFile(path.join(temp, 'config.json'), 'utf8')).host).toBe('tailscale');
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
  it('requires pairing by default and shares persistent mode changes across store connections and restarts', () => {
    let store = new Store(temp);
    try {
      expect(store.pairingRequired()).toBe(true);
      store.setPairingRequired(false);
      store.close();
      store = new Store(temp);
      expect(store.pairingRequired()).toBe(false);
      const anotherConnection = new Store(temp);
      try {
        anotherConnection.setPairingRequired(true);
        expect(store.pairingRequired()).toBe(true);
      } finally { anotherConnection.close(); }
      store.close();
      store = new Store(temp);
      expect(store.pairingRequired()).toBe(true);
      const external = new DatabaseSync(path.join(temp, 'state.sqlite'));
      try { external.prepare("UPDATE settings SET value='unrecognized' WHERE key='pairing_required'").run(); }
      finally { external.close(); }
      expect(store.pairingRequired()).toBe(true);
    } finally { store.close(); }
  });
});
