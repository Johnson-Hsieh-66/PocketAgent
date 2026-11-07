import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import type { FastifyInstance } from 'fastify';
import { createDiagnosticLogger, sanitizeDiagnostic, type DiagnosticInput } from '../src/server/diagnostics.js';
import { buildApp } from '../src/server/http.js';
import { Store } from '../src/server/store.js';
import { Files } from '../src/server/files.js';
import { checkoutRoot } from '../src/server/launcher.js';
import type { AppConfig } from '../src/server/config.js';
import type { AppEvent, PendingRequest, ServiceStatus } from '../src/shared/types.js';

const temporary: string[] = [];
async function tempDirectory() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pocketagent-diagnostics-test-'));
  temporary.push(directory);
  return directory;
}
afterEach(async () => {
  for (const directory of temporary.splice(0)) await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

describe('private durable diagnostics', () => {
  it('allowlists field names and values without serializing private input', async () => {
    const directory = await tempDirectory();
    const secret = 'SYNTHETIC_PRIVATE_SENTINEL';
    const input = {
      component: secret, code: 'SYNTHETIC_PRIVATE_UPSTREAM_CODE',
      operation: `/api/threads/${secret}?prompt=${secret}`, method: secret,
      httpStatus: 500, rpcCode: -32602, durationMs: 1.234, count: 2,
      message: secret, stack: secret, query: { secret }, params: { sessionId: secret },
      headers: { authorization: secret }, body: { pairingCode: secret },
      toJSON: () => { throw new Error('Input must never be serialized'); },
    } as unknown as DiagnosticInput;
    createDiagnosticLogger(directory)(input);
    const text = await readFile(path.join(directory, 'logs', 'diagnostics.jsonl'), 'utf8');
    expect(text).not.toContain(secret);
    expect(text).not.toContain('SYNTHETIC_PRIVATE_UPSTREAM_CODE');
    const record = JSON.parse(text);
    expect(record).toEqual({ time: expect.any(String), component: 'server', code: 'REQUEST_FAILED', operation: 'UNKNOWN_OPERATION', httpStatus: 500, rpcCode: -32602, durationMs: 1.23, count: 2 });
    expect(Number.isNaN(Date.parse(record.time))).toBe(false);
    expect(sanitizeDiagnostic({ component: 'http', code: 'REQUEST_FAILED', httpStatus: Infinity, rpcCode: NaN, count: -1, durationMs: -1 })).toEqual({ time: expect.any(String), component: 'http', code: 'REQUEST_FAILED', operation: 'UNKNOWN_OPERATION' });
  });

  it('persists across logger instances and keeps bounded rotations', async () => {
    const directory = await tempDirectory();
    const options = { maxBytes: 512, maxFiles: 3 };
    createDiagnosticLogger(directory, options)({ component: 'server', code: 'SERVICE_STARTING', operation: 'startup', count: 0 });
    const second = createDiagnosticLogger(directory, options);
    for (let count = 1; count <= 100; count++) second({ component: 'http', code: 'REQUEST_FAILED', operation: '/api/models', method: 'GET', httpStatus: 500, count });
    const logs = path.join(directory, 'logs');
    const names = await readdir(logs);
    expect(names.sort()).toEqual(['diagnostics.jsonl', 'diagnostics.jsonl.1', 'diagnostics.jsonl.2']);
    for (const name of names) {
      expect((await stat(path.join(logs, name))).size).toBeLessThanOrEqual(options.maxBytes);
      const lines = (await readFile(path.join(logs, name), 'utf8')).trim().split('\n');
      expect(lines.every(line => JSON.parse(line).code === 'REQUEST_FAILED')).toBe(true);
    }
    const newest = (await readFile(path.join(logs, 'diagnostics.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(newest.at(-1).count).toBe(100);
  });

  it('fails quietly on disk errors and refuses the checkout without writing stdout', async () => {
    const directory = await tempDirectory();
    const blocker = path.join(directory, 'not-a-directory');
    await writeFile(blocker, 'synthetic');
    const stdout = vi.spyOn(process.stdout, 'write');
    try {
      const entry: DiagnosticInput = { component: 'server', code: 'STARTUP_FAILED', operation: 'startup' };
      expect(() => createDiagnosticLogger(blocker)(entry)).not.toThrow();
      expect(() => createDiagnosticLogger(checkoutRoot())(entry)).not.toThrow();
      expect(stdout).not.toHaveBeenCalled();
    } finally { stdout.mockRestore(); }
  });
});

class FakeBridge extends EventEmitter {
  status: ServiceStatus = { codex: 'ready', authenticated: true };
  pendingRequests: PendingRequest[] = [];
  eventsSince(_seq: number): { events: AppEvent[]; reset: boolean } { return { events: [], reset: false }; }
  request = vi.fn(async () => { throw Object.assign(new Error('SYNTHETIC_PRIVATE_UPSTREAM'), { rpcCode: -32602 }); });
  respond() {}
  async startTurn() { return {}; }
  async interrupt() { return {}; }
}

describe('HTTP diagnostic boundary', () => {
  let app: FastifyInstance | undefined;
  let store: Store | undefined;
  afterEach(async () => { await app?.close(); store?.close(); app = undefined; store = undefined; });

  it('records static routes and safe RPC metadata without parameters, queries or raw errors', async () => {
    const directory = await tempDirectory();
    const config: AppConfig = { host: '127.0.0.1', port: 47831, dataDir: path.join(directory, 'runtime'), checkoutDir: directory, projectRoots: [] };
    store = new Store(config.dataDir);
    store.setPairingRequired(false);
    const files = new Files(config, store, { projects: async () => [] });
    const sink = createDiagnosticLogger(config.dataDir);
    const captured: DiagnosticInput[] = [];
    app = await buildApp({ config, store, files, bridge: new FakeBridge(), diagnostic: entry => { captured.push(entry); sink(entry); } });
    const headers = { host: '127.0.0.1:47831' };
    const missing = await app.inject({ url: '/api/projects/SYNTHETIC_PRIVATE_PROJECT/file?path=SYNTHETIC_PRIVATE_FILE', headers });
    expect(missing.statusCode).toBe(404);
    const failed = await app.inject({ url: '/api/models?prompt=SYNTHETIC_PRIVATE_QUERY', headers });
    expect(failed.statusCode).toBe(500);
    expect(captured).toEqual([
      expect.objectContaining({ component: 'http', code: 'PROJECT_NOT_FOUND', operation: '/api/projects/:id/file', method: 'GET', httpStatus: 404, durationMs: expect.any(Number) }),
      expect.objectContaining({ component: 'http', code: 'REQUEST_FAILED', operation: '/api/models', method: 'GET', httpStatus: 500, rpcCode: -32602, durationMs: expect.any(Number) }),
    ]);
    const text = await readFile(path.join(config.dataDir, 'logs', 'diagnostics.jsonl'), 'utf8');
    expect(text).not.toContain('SYNTHETIC_PRIVATE');
  });

  it('keeps HTTP failures working when a diagnostic consumer throws', async () => {
    const directory = await tempDirectory();
    const config: AppConfig = { host: '127.0.0.1', port: 47831, dataDir: path.join(directory, 'runtime'), checkoutDir: directory, projectRoots: [] };
    store = new Store(config.dataDir);
    store.setPairingRequired(false);
    app = await buildApp({ config, store, files: new Files(config, store, { projects: async () => [] }), bridge: new FakeBridge(), diagnostic: () => { throw new Error('Synthetic disk failure'); } });
    const response = await app.inject({ url: '/api/models', headers: { host: '127.0.0.1:47831' } });
    expect(response.statusCode).toBe(500);
  });
});
