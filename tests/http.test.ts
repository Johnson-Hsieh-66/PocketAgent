import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter, once } from 'node:events';
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../src/server/config.js';
import type { AppEvent, PendingRequest, ServiceStatus } from '../src/shared/types.js';
import { Store } from '../src/server/store.js';
import { Files } from '../src/server/files.js';
import { buildApp } from '../src/server/http.js';
import { validateRequestResult } from '../src/server/auth.js';

class FakeBridge extends EventEmitter {
  status: ServiceStatus = { codex: 'ready', authenticated: true };
  pendingRequests: PendingRequest[] = [];
  history: AppEvent[] = [];
  cwd = '';
  response = vi.fn();
  startTurn = vi.fn(async (_id: string, _params: unknown, _requestId: string) => ({ turn: { id: 'synthetic-turn', status: 'inProgress', items: [] } }));
  interrupt = vi.fn(async () => ({}));
  eventsSince(after: number) { return { events: this.history.filter(event => event.seq > after), reset: after > 100 }; }
  respond(id: string | number, result: unknown) { this.response(id, result); }
  request = vi.fn(async (method: string, params: any) => {
    if (method === 'thread/read') return { thread: { id: params.threadId, cwd: this.cwd, preview: 'Synthetic', turns: [] } };
    if (method === 'thread/list') return { data: [{ id: 'synthetic-thread', cwd: this.cwd, preview: 'Synthetic' }], nextCursor: 'next-synthetic-page' };
    if (method === 'thread/turns/list') return { data: [{ id: 'synthetic-turn', items: [], status: 'completed' }], nextCursor: null };
    if (method === 'model/list') return { data: [{ id: 'synthetic-model', model: 'synthetic-model', displayName: 'Synthetic' }] };
    return {};
  });
}

describe('private HTTP boundary and project access', () => {
  let temp: string;
  let store: Store;
  let files: Files;
  let app: FastifyInstance;
  let bridge: FakeBridge;
  let config: AppConfig;
  let projectId: string;
  let cookie: string;
  const headers = { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000' };
  beforeEach(async () => {
    temp = await mkdtemp(path.join(os.tmpdir(), 'pocketagent-http-test-'));
    const projects = path.join(temp, 'projects');
    const project = path.join(projects, 'Synthetic Project');
    await mkdir(project, { recursive: true });
    await writeFile(path.join(project, 'hello.txt'), 'Synthetic file content');
    await writeFile(path.join(project, '.env'), 'SYNTHETIC_ONLY=example');
    config = { host: '127.0.0.1', port: 3000, dataDir: path.join(temp, 'runtime'), checkoutDir: path.join(temp, 'checkout'), projectRoots: [projects] };
    store = new Store(config.dataDir);
    files = new Files(config, store);
    projectId = (await files.projects())[0].id;
    bridge = new FakeBridge();
    bridge.cwd = project;
    app = await buildApp({ config, store, files, bridge });
    await app.ready();
    const { code } = store.issuePairCode();
    const paired = await app.inject({ method: 'POST', url: '/api/auth/pair', headers, payload: { code, deviceName: 'Synthetic mobile' } });
    expect(paired.statusCode).toBe(200);
    cookie = `pa_session=${paired.cookies[0].value}`;
  });
  afterEach(async () => {
    await app?.close();
    store?.close();
    await rm(temp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  it('requires paired authentication and rejects invalid Host, Origin and originless mutations', async () => {
    expect((await app.inject({ url: '/api/projects', headers })).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/projects', headers: { ...headers, cookie, host: 'attacker.invalid:3000' } })).statusCode).toBe(403);
    expect((await app.inject({ url: '/api/projects', headers: { ...headers, cookie, origin: 'http://attacker.invalid' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { host: headers.host, cookie } })).statusCode).toBe(403);
    expect((await app.inject({ url: '/api/projects', headers: { ...headers, cookie } })).json().projects).toHaveLength(1);
  });
  it('uses one-time pairing codes and immediately revokes device sessions', async () => {
    const { code } = store.issuePairCode();
    const result = store.pair(code, 'Synthetic second device');
    expect(result).not.toBeNull();
    expect(store.pair(code, 'Synthetic replay')).toBeNull();
    expect(store.authenticate(result!.token)?.name).toBe('Synthetic second device');
    store.revoke(result!.device.id);
    expect(store.authenticate(result!.token)).toBeNull();
    const logout = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { ...headers, cookie } });
    expect(logout.statusCode).toBe(200);
    expect((await app.inject({ url: '/api/status', headers: { ...headers, cookie } })).statusCode).toBe(401);
  });
  it('bounds previews and blocks traversal, sensitive paths, binaries and escaping links', async () => {
    const tree = await files.tree(projectId);
    expect(tree.entries.map(entry => entry.name)).toEqual(['hello.txt']);
    expect((await files.read(projectId, 'hello.txt')).content).toBe('Synthetic file content');
    await expect(files.read(projectId, '../outside.txt')).rejects.toMatchObject({ statusCode: 403 });
    await expect(files.read(projectId, '.env')).rejects.toMatchObject({ statusCode: 403 });
    await writeFile(path.join(bridge.cwd, 'binary.dat'), Buffer.from([1, 0, 2]));
    await expect(files.read(projectId, 'binary.dat')).rejects.toMatchObject({ statusCode: 415 });
    await writeFile(path.join(bridge.cwd, 'large.txt'), 'x'.repeat(300 * 1024));
    expect((await files.read(projectId, 'large.txt')).truncated).toBe(true);
    const outside = path.join(temp, 'outside');
    await mkdir(outside);
    await writeFile(path.join(outside, 'private.txt'), 'Synthetic outside content');
    await symlink(outside, path.join(bridge.cwd, 'escaped'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(files.read(projectId, 'escaped/private.txt')).rejects.toMatchObject({ statusCode: 403 });
    await mkdir(path.join(bridge.cwd, '.git'));
    await writeFile(path.join(bridge.cwd, '.git', 'config'), 'Synthetic private metadata');
    await symlink(path.join(bridge.cwd, '.git'), path.join(bridge.cwd, 'metadata-alias'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(files.read(projectId, 'metadata-alias/config')).rejects.toMatchObject({ statusCode: 403 });
  });
  it('checks thread project ownership before history, messages and interruptions', async () => {
    const response = await app.inject({ url: `/api/threads?projectId=${projectId}&cursor=synthetic-cursor`, headers: { ...headers, cookie } });
    expect(response.statusCode).toBe(200);
    expect(response.json().nextCursor).toBe('next-synthetic-page');
    expect(bridge.request).toHaveBeenCalledWith('thread/list', expect.objectContaining({ cwd: bridge.cwd, cursor: 'synthetic-cursor', modelProviders: [], sourceKinds: ['cli', 'vscode', 'appServer'] }));
    const history = await app.inject({ url: `/api/threads/synthetic-thread/turns?projectId=${projectId}`, headers: { ...headers, cookie } });
    expect(history.statusCode).toBe(200);
    expect(bridge.request).toHaveBeenCalledWith('thread/turns/list', expect.objectContaining({ itemsView: 'full' }));
    bridge.cwd = temp;
    const rejected = await app.inject({ method: 'POST', url: '/api/threads/synthetic-thread/messages', headers: { ...headers, cookie }, payload: { projectId, text: 'Synthetic prompt', requestId: 'synthetic-request' } });
    expect(rejected.statusCode).toBe(403);
    expect(bridge.startTurn).not.toHaveBeenCalled();
    const interruption = await app.inject({ method: 'POST', url: '/api/threads/synthetic-thread/interrupt', headers: { ...headers, cookie }, payload: { projectId } });
    expect(interruption.statusCode).toBe(403);
    expect(bridge.interrupt).not.toHaveBeenCalled();
  });
  it('accepts bounded real image types and routes only project-owned server image paths', async () => {
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
    await expect(files.upload(projectId, 'unsafe.svg', 'image/svg+xml', Buffer.from('<svg/>'))).rejects.toMatchObject({ statusCode: 415 });
    const uploaded = await files.upload(projectId, 'synthetic.png', 'image/png', png);
    const response = await app.inject({ method: 'POST', url: '/api/threads/synthetic-thread/messages', headers: { ...headers, cookie }, payload: { projectId, text: '', attachmentIds: [uploaded.id], requestId: 'synthetic-upload-request' } });
    expect(response.statusCode).toBe(200);
    expect(bridge.startTurn).toHaveBeenCalledWith('synthetic-thread', expect.objectContaining({ input: [{ type: 'localImage', path: path.join(config.dataDir, 'uploads', uploaded.id) }] }), 'synthetic-upload-request');
    const otherDir = path.join(config.projectRoots[0], 'Other Synthetic Project');
    await mkdir(otherDir);
    const otherId = (await files.projects()).find(project => project.name === 'Other Synthetic Project')!.id;
    await expect(files.attachment(uploaded.id, otherId)).rejects.toMatchObject({ statusCode: 404 });
    const preview = await app.inject({ url: `/api/uploads/${uploaded.id}`, headers: { ...headers, cookie } });
    expect(preview.statusCode).toBe(200);
    expect(preview.headers['content-type']).toBe('image/png');
  });
  it('restricts approval replies to requested turn permissions and known pending IDs', async () => {
    bridge.pendingRequests = [{ id: 7, method: 'item/commandExecution/requestApproval', params: {} }];
    const unauthorized = await app.inject({ method: 'POST', url: '/api/requests/7', headers: { ...headers, cookie }, payload: { result: { decision: 'acceptForSession' } } });
    expect(unauthorized.statusCode).toBe(400);
    expect(bridge.response).not.toHaveBeenCalled();
    const accepted = await app.inject({ method: 'POST', url: '/api/requests/7', headers: { ...headers, cookie }, payload: { result: { decision: 'accept' } } });
    expect(accepted.statusCode).toBe(200);
    expect(bridge.response).toHaveBeenCalledWith(7, { decision: 'accept' });
    const pending = { id: 8, method: 'item/permissions/requestApproval', params: { permissions: { network: { enabled: true } } } };
    expect(validateRequestResult(pending, { permissions: {}, scope: 'turn' })).toEqual({ permissions: {}, scope: 'turn' });
    expect(() => validateRequestResult(pending, { permissions: { fileSystem: { write: ['/synthetic-extra'] } }, scope: 'turn' })).toThrow('PERMISSIONS_EXCEED_REQUEST');
    expect(() => validateRequestResult(pending, { permissions: {}, scope: 'session' })).toThrow('INVALID_PERMISSION_APPROVAL');
    expect(validateRequestResult({ id: 9, method: 'mcpServer/elicitation/request', params: {} }, { action: 'decline' })).toEqual({ action: 'decline', content: null, _meta: null });
  });
  it('streams authenticated events and detaches browsers without interrupting work', async () => {
    const ws = await app.injectWS('/api/events?after=0', { headers: { ...headers, cookie } });
    const eventPromise = once(ws, 'message');
    bridge.emit('event', { seq: 1, method: 'synthetic/event', params: { synthetic: true } });
    const [message] = await eventPromise;
    expect(JSON.parse(message.toString()).method).toBe('synthetic/event');
    ws.terminate();
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(bridge.interrupt).not.toHaveBeenCalled();
    expect(bridge.listenerCount('event')).toBe(0);
    await expect(app.injectWS('/api/events', { headers: { ...headers, origin: 'http://attacker.invalid', cookie } })).rejects.toThrow();
  });
});
