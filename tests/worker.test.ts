import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { once } from 'node:events';
import { CodexBridge, type SubmissionLedger } from '../src/server/codex.js';
import { WorkerClient } from '../src/server/worker-client.js';
import { createWorkerServer, type WorkerServer } from '../src/server/worker-server.js';
import { readWorkerFrames, readWorkerKey, workerEndpoint, workerNonce, workerProof, writeWorkerFrame, WORKER_PROTOCOL_VERSION } from '../src/server/worker-protocol.js';
import type { DiagnosticSink } from '../src/server/diagnostics.js';
import type { AppEvent } from '../src/shared/types.js';

const directories: string[] = [];
const bridges: CodexBridge[] = [];
const servers: WorkerServer[] = [];
const clients: WorkerClient[] = [];
const sockets: Socket[] = [];
const peers: Server[] = [];
const fixture = resolve('tests/fixtures/fake-codex.mjs');
const input = (text = 'hold') => ({ input: [{ type: 'text', text }] });
async function directory() {
  const result = await mkdtemp(join(tmpdir(), 'pocketagent-worker-test-'));
  directories.push(result); return result;
}
async function bridge() {
  const entries = new Map<string, { threadId: string; fingerprint: string }>();
  const ledger: SubmissionLedger = {
    readSubmission: id => entries.get(id) ?? null,
    recordSubmission: (id, threadId, fingerprint) => { entries.set(id, { threadId, fingerprint }); },
    forgetSubmission: id => { entries.delete(id); },
  };
  const result = new CodexBridge({ command: process.execPath, args: [fixture] }, ledger);
  bridges.push(result); await result.start(); return result;
}
async function server(dataDir: string, native: CodexBridge, options: Partial<Parameters<typeof createWorkerServer>[0]> = {}) {
  const result = createWorkerServer({ dataDir, bridge: native, ...options });
  servers.push(result); await result.start(); return result;
}
async function client(dataDir: string, options: Partial<ConstructorParameters<typeof WorkerClient>[0]> = {}) {
  const result = new WorkerClient({ dataDir, ...options });
  clients.push(result); await result.connect(); return result;
}
async function raw(dataDir: string) {
  const socket = createConnection(workerEndpoint(dataDir));
  sockets.push(socket); socket.on('error', () => {});
  const frames: Record<string, any>[] = [];
  readWorkerFrames(socket, frame => frames.push(frame), () => socket.destroy());
  await once(socket, 'connect');
  return { socket, frames, send: (frame: unknown) => writeWorkerFrame(socket, frame) };
}
async function authorize(dataDir: string) {
  const peer = await raw(dataDir);
  const nonce = workerNonce();
  peer.send({ type: 'hello', version: WORKER_PROTOCOL_VERSION, nonce });
  await vi.waitFor(() => expect(peer.frames[0]?.type).toBe('challenge'));
  const key = await readWorkerKey(dataDir);
  peer.send({ type: 'authenticate', version: WORKER_PROTOCOL_VERSION, proof: workerProof(key, 'client', nonce, peer.frames[0].nonce) });
  await vi.waitFor(() => expect(peer.frames.some(frame => frame.type === 'synchronized')).toBe(true));
  return peer;
}
afterEach(async () => {
  for (const item of clients.splice(0)) item.close();
  for (const item of sockets.splice(0)) item.destroy();
  await Promise.all(servers.splice(0).map(item => item.close()));
  await Promise.all(bridges.splice(0).map(item => item.stop()));
  await Promise.all(peers.splice(0).filter(item => item.listening).map(item => new Promise<void>(resolve => item.close(() => resolve()))));
  for (const item of directories.splice(0)) {
    const destination = resolve(item);
    if (!destination.startsWith(resolve(tmpdir()) + sep) || !basename(destination).startsWith('pocketagent-worker-test-')) throw new Error('Unexpected synthetic fixture directory');
    await rm(destination, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

describe('durable local worker and replaceable HTTP clients', () => {
  it('keeps the same turn and pending approval across three gateway replacements', async () => {
    const dataDir = await directory(); const native = await bridge(); await server(dataDir, native);
    let gateway = await client(dataDir);
    const generation = gateway.status.generation;
    await gateway.request('thread/start', { projectId: 'synthetic-project', cwd: '/synthetic/project' });
    expect(gateway.createdThreadProject('fixture-created-thread')).toBe('synthetic-project');
    await gateway.startTurn('synthetic-thread', input('approval'), 'synthetic-request');
    await vi.waitFor(() => expect(gateway.pendingRequestCount).toBe(1));
    const approval = gateway.pendingRequests[0];
    for (let index = 0; index < 3; index++) {
      gateway.close();
      gateway = await client(dataDir);
      expect(gateway.status.generation).toBe(generation);
      expect(gateway.activeTurnCount).toBe(1);
      expect(gateway.pendingRequests).toEqual([approval]);
      expect(gateway.createdThreadIds('synthetic-project')).toEqual(['fixture-created-thread']);
      await gateway.startTurn('synthetic-thread', input('approval'), 'synthetic-request');
      expect(await native.request('fixture/stats')).toMatchObject({ starts: 1, approvals: 1, active: ['synthetic-thread'] });
    }
    await gateway.respond(approval.id, { decision: 'accept' });
    await vi.waitFor(() => expect(gateway.activeTurnCount).toBe(0));
    expect(gateway.pendingRequests).toEqual([]);
    expect(await native.request('fixture/stats')).toMatchObject({ starts: 1, active: [] });
  });

  it('does not replay a mutating call whose acknowledgment was lost with its gateway', async () => {
    const dataDir = await directory(); const native = await bridge(); await server(dataDir, native);
    const first = await client(dataDir);
    const started = first.startTurn('synthetic-pending-thread', input('deferred-start-response'), 'synthetic-pending-request');
    const disconnected = expect(started).rejects.toThrow('WORKER_DISCONNECTED');
    await vi.waitFor(async () => expect(await native.request('fixture/stats')).toHaveProperty('starts', 1));
    first.close(); await disconnected;
    const second = await client(dataDir);
    expect(await native.request('fixture/stats')).toMatchObject({ starts: 1, active: ['synthetic-pending-thread'] });
    const same = second.startTurn('synthetic-pending-thread', input('deferred-start-response'), 'synthetic-pending-request');
    await native.request('fixture/reply-start', { threadId: 'synthetic-pending-thread' });
    await expect(same).resolves.toHaveProperty('turn.id');
    expect(await native.request('fixture/stats')).toHaveProperty('starts', 1);
  });

  it('bounds pending call deadlines without cancelling or automatically retrying its turn', async () => {
    const dataDir = await directory(); const native = await bridge(); await server(dataDir, native);
    const gateway = await client(dataDir, { requestTimeoutMs: 30 });
    await expect(gateway.startTurn('synthetic-timeout-thread', input('deferred-start-response'), 'synthetic-timeout-request')).rejects.toThrow('WORKER_REQUEST_TIMEOUT');
    expect(gateway.connected).toBe(true);
    expect(await native.request('fixture/stats')).toMatchObject({ starts: 1, active: ['synthetic-timeout-thread'] });
    await native.request('fixture/reply-start', { threadId: 'synthetic-timeout-thread' });
    await expect(gateway.startTurn('synthetic-timeout-thread', input('deferred-start-response'), 'synthetic-timeout-request')).resolves.toHaveProperty('turn.id');
    expect(await native.request('fixture/stats')).toHaveProperty('starts', 1);
  });

  it('allows an unavailable gateway to reconnect later and refuses unsupported native methods', async () => {
    const dataDir = await directory();
    const gateway = new WorkerClient({ dataDir, connectTimeoutMs: 100 }); clients.push(gateway);
    await expect(gateway.connect()).rejects.toThrow('WORKER_UNAVAILABLE');
    const native = await bridge(); await server(dataDir, native); await gateway.connect();
    await expect(gateway.request('turn/start', input())).rejects.toThrow('WORKER_METHOD_NOT_ALLOWED');
    const peer = await authorize(dataDir);
    peer.send({ type: 'call', id: 1, operation: 'request', params: { method: 'account/read', params: {} } });
    await vi.waitFor(() => expect(peer.frames.find(frame => frame.type === 'reply')?.error?.code).toBe('WORKER_METHOD_NOT_ALLOWED'));
    expect(await native.request('fixture/stats')).toHaveProperty('starts', 0);
  });

  it('rejects incompatible versions, unauthenticated calls and invalid nonce proofs before agent work', async () => {
    const dataDir = await directory(); const native = await bridge(); await server(dataDir, native, { handshakeTimeoutMs: 100 });
    const old = await raw(dataDir); old.send({ type: 'hello', version: 0, nonce: workerNonce() });
    await vi.waitFor(() => expect(old.frames[0]?.code).toBe('WORKER_PROTOCOL_MISMATCH'));
    const noHandshake = await raw(dataDir); noHandshake.send({ type: 'call', id: 1, operation: 'recover', params: {} });
    await vi.waitFor(() => expect(noHandshake.frames[0]?.code).toBe('WORKER_PROTOCOL_MISMATCH'));
    const bad = await raw(dataDir); bad.send({ type: 'hello', version: WORKER_PROTOCOL_VERSION, nonce: workerNonce() });
    await vi.waitFor(() => expect(bad.frames[0]?.type).toBe('challenge'));
    bad.send({ type: 'authenticate', version: WORKER_PROTOCOL_VERSION, proof: '0'.repeat(64) });
    await vi.waitFor(() => expect(bad.frames.some(frame => frame.code === 'WORKER_AUTHENTICATION_FAILED')).toBe(true));
    expect(await native.request('fixture/stats')).toHaveProperty('starts', 0);
  });

  it('authenticates the server and rejects an impersonator without sending client proof', async () => {
    const dataDir = await directory(); await readWorkerKey(dataDir, true);
    const received: Record<string, any>[] = [];
    const impostor = createServer(socket => {
      sockets.push(socket); socket.on('error', () => {});
      readWorkerFrames(socket, frame => {
        received.push(frame);
        writeWorkerFrame(socket, { type: 'challenge', version: WORKER_PROTOCOL_VERSION, nonce: workerNonce(), proof: '0'.repeat(64) });
      }, () => socket.destroy());
    });
    peers.push(impostor); await new Promise<void>(resolve => impostor.listen(workerEndpoint(dataDir), resolve));
    const gateway = new WorkerClient({ dataDir }); clients.push(gateway);
    await expect(gateway.connect()).rejects.toThrow('WORKER_AUTHENTICATION_FAILED');
    expect(received.map(frame => frame.type)).toEqual(['hello']);
  });

  it('limits frames before decoding an unbounded no-newline input', async () => {
    const dataDir = await directory(); const native = await bridge(); await server(dataDir, native, { maxFrameBytes: 1024 });
    const peer = await raw(dataDir);
    peer.socket.write(Buffer.alloc(2048, 65));
    await vi.waitFor(() => expect(peer.frames[0]?.code).toBe('WORKER_FRAME_TOO_LARGE'));
    expect(await native.request('fixture/stats')).toHaveProperty('starts', 0);
  });

  it('resets colliding cursors when a different worker starts and keeps prompts unreplayed', async () => {
    const dataDir = await directory(); const native = await bridge(); const first = await server(dataDir, native);
    const gateway = await client(dataDir); const previous = gateway.status.generation;
    for (let index = 0; index < 20; index++) native.publish('synthetic/event', { index });
    await vi.waitFor(() => expect(gateway.eventsSince(0).events.length).toBeGreaterThan(20));
    const cursor = gateway.eventsSince(0).events.at(-1)!.seq;
    await first.close(); await native.stop();
    await vi.waitFor(() => expect(gateway.connected).toBe(false));
    const replacement = await bridge();
    for (let index = 0; index < 30; index++) replacement.publish('synthetic/event', { index });
    await server(dataDir, replacement);
    const updates: AppEvent[] = []; gateway.on('event', event => updates.push(event));
    await gateway.connect();
    expect(gateway.status.generation).not.toBe(previous);
    expect(gateway.eventsSince(cursor, previous).reset).toBe(true);
    expect(updates.some(event => event.method === 'pocketagent/reset')).toBe(true);
    expect(await replacement.request('fixture/stats')).toHaveProperty('starts', 0);
  });

  it('changes generation on explicit Codex recovery and excludes old-generation replay', async () => {
    const dataDir = await directory(); const native = await bridge(); await server(dataDir, native);
    const gateway = await client(dataDir); const generation = gateway.status.generation;
    await gateway.startTurn('synthetic-recovery-thread', input(), 'synthetic-recovery-request');
    native.publish('item/agentMessage/delta', { threadId: 'synthetic-recovery-thread', turnId: 'synthetic-turn', itemId: 'synthetic-item', delta: 'SYNTHETIC_OLD_GENERATION' });
    await gateway.recover();
    expect(gateway.status.codex).toBe('ready');
    expect(gateway.status.generation).not.toBe(generation);
    expect(gateway.eventsSince(0).events.some(event => event.params.delta === 'SYNTHETIC_OLD_GENERATION')).toBe(false);
    const reconnect = await client(dataDir);
    expect(reconnect.eventsSince(0).events.some(event => event.params.delta === 'SYNTHETIC_OLD_GENERATION')).toBe(false);
    expect(await native.request('fixture/stats')).toHaveProperty('starts', 0);
  });

  it('relays only sanitized diagnostics and hides upstream errors from gateway replies', async () => {
    const dataDir = await directory(); const native = await bridge();
    const diagnostic = vi.fn<DiagnosticSink>(); await server(dataDir, native, { diagnostic });
    const gateway = await client(dataDir);
    gateway.diagnostic({ component: 'http', code: 'SYNTHETIC_PRIVATE_CODE', operation: '/api/threads/SYNTHETIC_PRIVATE_ID', method: 'GET', httpStatus: 500 });
    await vi.waitFor(() => expect(diagnostic).toHaveBeenCalled());
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('SYNTHETIC_PRIVATE');
    vi.spyOn(native, 'request').mockRejectedValueOnce(new Error('SYNTHETIC_PRIVATE_UPSTREAM_TEXT'));
    await expect(gateway.request('thread/read', { threadId: 'synthetic-thread' })).rejects.toThrow('WORKER_REQUEST_FAILED');
  });

  it('claims maintenance atomically across clients and retains it after the updater disconnects', async () => {
    const dataDir = await directory(); const native = await bridge(); await server(dataDir, native);
    const first = await client(dataDir); const second = await client(dataDir);
    const claims = await Promise.all([first.beginMaintenanceIfIdle(), second.beginMaintenanceIfIdle()]);
    expect([...claims].sort()).toEqual([false, true]);
    first.close(); second.close();
    const replacement = await client(dataDir);
    expect(replacement.maintenance).toBe(true);
    await expect(replacement.startTurn('synthetic-maintenance-thread', input(), 'synthetic-maintenance-request')).rejects.toThrow('WORKER_MAINTENANCE');
    await expect(replacement.request('thread/start', { projectId: 'synthetic-project' })).rejects.toThrow('WORKER_MAINTENANCE');
    await expect(replacement.recover()).rejects.toThrow('WORKER_MAINTENANCE');
    await expect(replacement.request('thread/read', { threadId: 'synthetic-idle-thread', fixtureReadCurrent: true })).resolves.toHaveProperty('thread.id');
    expect(await native.request('fixture/stats')).toHaveProperty('starts', 0);
    await replacement.endMaintenance();
    await expect(replacement.startTurn('synthetic-maintenance-thread', input(), 'synthetic-maintenance-request')).resolves.toHaveProperty('turn.id');
    expect(await replacement.beginMaintenanceIfIdle()).toBe(false);
  });

  it('keeps maintenance busy until native work settles after its IPC reply deadline', async () => {
    const dataDir = await directory(); const native = await bridge(); await server(dataDir, native, { requestTimeoutMs: 20 });
    const gateway = await client(dataDir);
    let finish!: (result: unknown) => void;
    vi.spyOn(native, 'request').mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await expect(gateway.request('thread/read', { threadId: 'synthetic-slow-read' })).rejects.toThrow('WORKER_REQUEST_TIMEOUT');
    expect(await gateway.beginMaintenanceIfIdle()).toBe(false);
    finish({ thread: { id: 'synthetic-slow-read', status: { type: 'idle' } } });
    await vi.waitFor(async () => expect(await gateway.beginMaintenanceIfIdle()).toBe(true));
    await gateway.endMaintenance();
    const internalRead = native.request('fixture/echo', { value: 'synthetic-background-operation', delay: 40 });
    expect(await gateway.beginMaintenanceIfIdle()).toBe(false);
    await internalRead;
    expect(await gateway.beginMaintenanceIfIdle()).toBe(true);
    await gateway.endMaintenance();
  });

  it('never admits a new turn after a competing maintenance claim succeeds and releases an expired lease', async () => {
    const dataDir = await directory(); const native = await bridge(); await server(dataDir, native, { maintenanceTtlMs: 60 });
    const updater = await client(dataDir); const gateway = await client(dataDir);
    const [claim, turn] = await Promise.allSettled([
      updater.beginMaintenanceIfIdle(), gateway.startTurn('synthetic-racing-thread', input(), 'synthetic-racing-request'),
    ]);
    expect(claim.status).toBe('fulfilled');
    if (claim.status === 'fulfilled' && claim.value) {
      expect(turn.status).toBe('rejected');
      if (turn.status === 'rejected') expect(turn.reason.message).toBe('WORKER_MAINTENANCE');
      expect(await native.request('fixture/stats')).toHaveProperty('starts', 0);
      await vi.waitFor(async () => { await expect(gateway.startTurn('synthetic-racing-thread', input(), 'synthetic-racing-request')).resolves.toHaveProperty('turn.id'); });
    } else {
      expect(turn.status).toBe('fulfilled');
      expect(await updater.beginMaintenanceIfIdle()).toBe(false);
    }
    expect(await native.request('fixture/stats')).toHaveProperty('starts', 1);
  });
});
