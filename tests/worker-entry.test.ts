import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { WorkerClient } from '../src/server/worker-client.js';

const temporary: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];
const clients: WorkerClient[] = [];
const entry = resolve('src/server/worker.ts');
const fixture = resolve('tests/fixtures/fake-codex.mjs');
function launch(dataDir: string, args: string[] = []) {
  const child = spawn(process.execPath, ['--import', 'tsx', entry, ...args], {
    windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, POCKETAGENT_DATA_DIR: dataDir, POCKETAGENT_CODEX_PATH: fixture, CODEX_HOME: join(dataDir, 'synthetic-codex-home') },
  });
  children.push(child); child.on('error', () => {}); child.stderr.resume();
  return child;
}
afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const exit = once(child, 'exit'); child.kill(); await exit;
  }
  for (const directory of temporary.splice(0)) {
    const destination = resolve(directory);
    if (!destination.startsWith(resolve(tmpdir()) + sep) || !basename(destination).startsWith('pocketagent-worker-entry-test-')) throw new Error('Unexpected synthetic entry fixture directory');
    await rm(destination, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

describe('independently launched worker entry with a synthetic Codex peer', () => {
  it('owns one worker record, survives gateway replacement and exposes a read-only CLI probe', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'pocketagent-worker-entry-test-')); temporary.push(dataDir);
    const worker = launch(dataDir); worker.stdout.resume();
    let gateway = new WorkerClient({ dataDir, connectTimeoutMs: 1000 }); clients.push(gateway);
    await vi.waitFor(() => gateway.connect(), { timeout: 10_000 });
    await vi.waitFor(() => expect(gateway.status.codex).toBe('ready'), { timeout: 5000 });
    const original = JSON.parse(await readFile(join(dataDir, 'worker.json'), 'utf8'));
    expect(original).toMatchObject({ pid: worker.pid, execPath: process.execPath, entrypoint: entry, version: 1 });
    expect(original).not.toHaveProperty('key');
    const generation = gateway.status.generation;
    const turn = await gateway.startTurn('synthetic-entry-thread', { input: [{ type: 'text', text: 'approval' }] }, 'synthetic-entry-request');
    await vi.waitFor(() => expect(gateway.pendingRequests).toHaveLength(1));
    for (let index = 0; index < 3; index++) {
      gateway.close(); gateway = new WorkerClient({ dataDir }); clients.push(gateway); await gateway.connect();
      expect(gateway.status.generation).toBe(generation);
      expect(gateway.activeTurnCount).toBe(1);
      expect(gateway.pendingRequests).toHaveLength(1);
      expect(await gateway.startTurn('synthetic-entry-thread', { input: [{ type: 'text', text: 'approval' }] }, 'synthetic-entry-request')).toEqual(turn);
    }
    const probe = launch(dataDir, ['--probe']);
    let output = ''; probe.stdout.on('data', chunk => { output += chunk.toString(); });
    expect((await once(probe, 'exit'))[0]).toBe(0);
    expect(output.trim()).toBe('POCKETAGENT_WORKER_READY');
    const second = launch(dataDir); second.stdout.resume();
    expect((await once(second, 'exit'))[0]).toBe(1);
    expect(JSON.parse(await readFile(join(dataDir, 'worker.json'), 'utf8')).pid).toBe(worker.pid);
    expect(gateway.status.generation).toBe(generation);
    await gateway.respond(gateway.pendingRequests[0].id, { decision: 'accept' });
    await vi.waitFor(() => expect(gateway.activeTurnCount).toBe(0));
  }, 20_000);
});
