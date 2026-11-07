import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter, once } from 'node:events';
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../src/server/config.js';
import type { AppEvent, PendingRequest, ServiceStatus } from '../src/shared/types.js';
import type { Project } from '../src/shared/types.js';
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
  request = vi.fn<(method: string, params: any) => Promise<any>>(async (method: string, params: any) => {
    if (method === 'thread/read') return { thread: { id: params.threadId, projectId: 'synthetic-desktop-project', cwd: this.cwd, preview: 'Synthetic', turns: [] } };
    if (method === 'thread/list') return { data: [{ id: 'synthetic-thread', projectId: 'synthetic-desktop-project', cwd: this.cwd, preview: 'Synthetic' }], nextCursor: 'next-synthetic-page' };
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
  let registeredProjects: Project[];
  let legacyAssignments: Record<string, string[]>;
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
    registeredProjects = [{ id: 'synthetic-desktop-project', name: 'Synthetic Project', path: project, roots: [project] }];
    legacyAssignments = {};
    files = new Files(config, store, { projects: async () => registeredProjects, threadIds: async id => legacyAssignments[id] || [] });
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
  it('keeps Host, Origin and pairing checks independent on LAN and Tailscale listeners sharing one service', async () => {
    const hosts = [[192, 168, 50, 42], [100, 70, 50, 42]].map(octets => octets.join('.'));
    const listeners = await Promise.all(hosts.map(host => buildApp({ config: { ...config, host }, store, files, bridge })));
    const sockets: Awaited<ReturnType<FastifyInstance['injectWS']>>[] = [];
    try {
      await Promise.all(listeners.map(listener => listener.ready()));
      for (const [index, listener] of listeners.entries()) {
        const own = { host: `${hosts[index]}:3000`, origin: `http://${hosts[index]}:3000` };
        const other = { host: `${hosts[1 - index]}:3000`, origin: `http://${hosts[1 - index]}:3000` };
        expect((await listener.inject({ url: '/api/auth', headers: own })).json()).toEqual({ authenticated: false, pairingRequired: true, paired: false });
        expect((await listener.inject({ url: '/api/projects', headers: own })).statusCode).toBe(401);
        const { code } = store.issuePairCode();
        const paired = await listener.inject({ method: 'POST', url: '/api/auth/pair', headers: own, payload: { code, deviceName: `Synthetic listener ${index}` } });
        expect(paired.statusCode).toBe(200);
        const deviceCookie = `pa_session=${paired.cookies[0].value}`;
        expect((await listener.inject({ url: '/api/projects', headers: { ...own, cookie: deviceCookie } })).statusCode).toBe(200);
        expect((await listener.inject({ url: '/api/projects', headers: { ...own, host: other.host, cookie: deviceCookie } })).statusCode).toBe(403);
        expect((await listener.inject({ url: '/api/projects', headers: { ...own, origin: other.origin, cookie: deviceCookie } })).statusCode).toBe(403);
        await expect(listener.injectWS('/api/events', { headers: own })).rejects.toThrow('401');
        await expect(listener.injectWS('/api/events', { headers: { ...own, origin: other.origin, cookie: deviceCookie } })).rejects.toThrow('403');
        await expect(listener.injectWS('/api/events', { headers: { ...own, host: other.host, cookie: deviceCookie } })).rejects.toThrow('403');
        sockets.push(await listener.injectWS('/api/events', { headers: { ...own, cookie: deviceCookie } }));
      }
      const received = sockets.map(socket => once(socket, 'message'));
      bridge.emit('event', { seq: 1, method: 'synthetic/shared-event', params: {} });
      for (const [message] of await Promise.all(received)) expect(JSON.parse(message.toString()).method).toBe('synthetic/shared-event');
      store.revoke('all');
      for (const [index, listener] of listeners.entries()) {
        expect((await listener.inject({ url: '/api/projects', headers: { host: `${hosts[index]}:3000`, cookie } })).statusCode).toBe(401);
      }
      store.setPairingRequired(false);
      for (const [index, listener] of listeners.entries()) {
        const own = { host: `${hosts[index]}:3000`, origin: `http://${hosts[index]}:3000` };
        expect((await listener.inject({ url: '/api/auth', headers: own })).json()).toEqual({ authenticated: true, pairingRequired: false, paired: false });
        expect((await listener.inject({ url: '/api/projects', headers: own })).statusCode).toBe(200);
      }
      const reenabling = await listeners[0].inject({ method: 'POST', url: '/api/settings/pairing', headers: { host: `${hosts[0]}:3000`, origin: `http://${hosts[0]}:3000` }, payload: { required: true } });
      expect(reenabling.statusCode).toBe(200);
      expect((await listeners[1].inject({ url: '/api/projects', headers: { host: `${hosts[1]}:3000` } })).statusCode).toBe(401);
    } finally {
      for (const socket of sockets) socket.terminate();
      await new Promise(resolve => setTimeout(resolve, 10));
      await Promise.all(listeners.map(listener => listener.close()));
    }
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
  it('switches pairing with strict validation while preserving boundaries, existing cookies and logout revocation', async () => {
    expect((await app.inject({ url: '/api/auth', headers })).json()).toEqual({ authenticated: false, pairingRequired: true, paired: false });
    expect((await app.inject({ method: 'POST', url: '/api/settings/pairing', headers, payload: { required: false } })).statusCode).toBe(401);
    for (const payload of [{}, { required: 'false' }, { required: 0 }, { required: false, extra: true }]) {
      expect((await app.inject({ method: 'POST', url: '/api/settings/pairing', headers: { ...headers, cookie }, payload })).statusCode).toBe(400);
      expect(store.pairingRequired()).toBe(true);
    }
    const disabled = await app.inject({ method: 'POST', url: '/api/settings/pairing', headers: { ...headers, cookie }, payload: { required: false } });
    expect(disabled.json()).toEqual({ authenticated: true, pairingRequired: false, paired: true });
    expect((await app.inject({ url: '/api/auth', headers })).json()).toEqual({ authenticated: true, pairingRequired: false, paired: false });
    expect((await app.inject({ url: '/api/projects', headers })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/projects', headers: { ...headers, host: 'attacker.invalid:3000' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/settings/pairing', headers: { host: headers.host }, payload: { required: true } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/settings/pairing', headers: { ...headers, origin: 'http://attacker.invalid' }, payload: { required: true } })).statusCode).toBe(403);
    expect(store.pairingRequired()).toBe(false);
    const enabled = await app.inject({ method: 'POST', url: '/api/settings/pairing', headers, payload: { required: true } });
    expect(enabled.json()).toEqual({ authenticated: false, pairingRequired: true, paired: false });
    expect((await app.inject({ url: '/api/projects', headers })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/settings/pairing', headers, payload: { required: false } })).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/auth', headers: { ...headers, cookie } })).json()).toEqual({ authenticated: true, pairingRequired: true, paired: true });
    expect((await app.inject({ url: '/api/projects', headers: { ...headers, cookie } })).statusCode).toBe(200);
    store.setPairingRequired(false);
    await expect(app.injectWS('/api/events', { headers: { host: headers.host } })).rejects.toThrow('403');
    expect((await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { ...headers, cookie } })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/auth', headers: { ...headers, cookie } })).json()).toEqual({ authenticated: true, pairingRequired: false, paired: false });
    store.setPairingRequired(true);
    expect((await app.inject({ url: '/api/projects', headers: { ...headers, cookie } })).statusCode).toBe(401);
  });
  it('authorizes unpaired websocket access only while pairing is off and rechecks before each event and on its timer', async () => {
    store.setPairingRequired(false);
    await expect(app.injectWS('/api/events', { headers: { ...headers, origin: 'http://attacker.invalid' } })).rejects.toThrow('403');
    await expect(app.injectWS('/api/events', { headers: { ...headers, host: 'attacker.invalid:3000' } })).rejects.toThrow('403');
    const sockets: Awaited<ReturnType<FastifyInstance['injectWS']>>[] = [];
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const socket = await app.injectWS('/api/events?after=0', { headers });
      sockets.push(socket);
      const received = once(socket, 'message');
      bridge.emit('event', { seq: 1, method: 'synthetic/allowed-without-pairing', params: {} });
      expect(JSON.parse((await received)[0].toString()).method).toBe('synthetic/allowed-without-pairing');
      const onMessage = vi.fn();
      socket.on('message', onMessage);
      const closed = once(socket, 'close');
      store.setPairingRequired(true);
      bridge.emit('event', { seq: 2, method: 'synthetic/protected-after-enable', params: {} });
      expect((await closed)[0]).toBe(4401);
      expect(onMessage).not.toHaveBeenCalled();
      await expect(app.injectWS('/api/events', { headers })).rejects.toThrow('401');
      const pairedSocket = await app.injectWS('/api/events', { headers: { ...headers, cookie } });
      sockets.push(pairedSocket);
      const pairedReceived = once(pairedSocket, 'message');
      bridge.emit('event', { seq: 3, method: 'synthetic/still-paired', params: {} });
      expect(JSON.parse((await pairedReceived)[0].toString()).method).toBe('synthetic/still-paired');
      store.setPairingRequired(false);
      const timerSocket = await app.injectWS('/api/events', { headers });
      sockets.push(timerSocket);
      const timerClosed = once(timerSocket, 'close');
      store.setPairingRequired(true);
      await vi.advanceTimersByTimeAsync(5000);
      expect((await timerClosed)[0]).toBe(4401);
      expect(bridge.interrupt).not.toHaveBeenCalled();
    } finally {
      for (const socket of sockets) socket.terminate();
      vi.useRealTimers();
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  });
  it('accepts copied separators and fullwidth pairing digits without changing code identity', async () => {
    const formats = [
      (code: string) => ` ${code} `,
      (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`,
      (code: string) => Array.from(code, digit => String.fromCharCode(digit.charCodeAt(0) + 0xFEE0)).join(''),
    ];
    for (const format of formats) {
      const { code } = store.issuePairCode();
      const response = await app.inject({ method: 'POST', url: '/api/auth/pair', headers, payload: { code: format(code), deviceName: 'Synthetic copied-code device' } });
      expect(response.json()).toEqual({ authenticated: true });
      expect(response.statusCode).toBe(200);
      const reused = await app.inject({ method: 'POST', url: '/api/auth/pair', headers, payload: { code, deviceName: 'Synthetic reuse' } });
      expect(reused.json()).toEqual({ error: 'PAIRING_CODE_INVALID_OR_EXPIRED' });
    }
  });
  it('distinguishes malformed pairing codes from incorrect, expired and locked codes', async () => {
    const { code } = store.issuePairCode();
    for (const invalidCode of ['', code.slice(0, 7), code + '0', `Pairing code: ${code}`, 12345678]) {
      const response = await app.inject({ method: 'POST', url: '/api/auth/pair', headers, payload: { code: invalidCode, deviceName: 'Synthetic invalid format' } });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: 'PAIRING_CODE_FORMAT_INVALID' });
    }
    const incorrect = (code.startsWith('0') ? '1' : '0') + code.slice(1);
    for (let attempt = 0; attempt < 10; attempt++) {
      const response = await app.inject({ method: 'POST', url: '/api/auth/pair', headers, payload: { code: incorrect, deviceName: 'Synthetic incorrect code' } });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: 'PAIRING_CODE_INVALID_OR_EXPIRED' });
    }
    const locked = await app.inject({ method: 'POST', url: '/api/auth/pair', headers, payload: { code, deviceName: 'Synthetic locked code' } });
    expect(locked.json()).toEqual({ error: 'PAIRING_CODE_INVALID_OR_EXPIRED' });
    const expiry = store.issuePairCode();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(expiry.expiresAt + 1);
    try {
      const expired = await app.inject({ method: 'POST', url: '/api/auth/pair', headers, payload: { code: expiry.code, deviceName: 'Synthetic expired code' } });
      expect(expired.statusCode).toBe(401);
      expect(expired.json()).toEqual({ error: 'PAIRING_CODE_INVALID_OR_EXPIRED' });
    } finally { clock.mockRestore(); }
  });
  it('allows an optional blank device name and completes the exact UI pairing and initial workspace requests', async () => {
    for (const deviceName of [undefined, '   ', '我的裝置']) {
      const { code } = store.issuePairCode();
      const paired = await app.inject({ method: 'POST', url: '/api/auth/pair', headers, payload: { code, ...(deviceName === undefined ? {} : { deviceName }) } });
      expect(paired.statusCode).toBe(200);
      expect(paired.json()).toEqual({ authenticated: true });
      const pairedCookie = `pa_session=${paired.cookies[0].value}`;
      const bootstrap = await Promise.all(['/api/auth', '/api/projects', '/api/status', '/api/models', '/api/requests', `/api/threads?projectId=${projectId}`].map(url => app.inject({ url, headers: { ...headers, cookie: pairedCookie } })));
      for (const response of bootstrap) {
        expect(response.statusCode).toBe(200);
        expect(response.json()).not.toHaveProperty('error');
      }
    }
    expect(store.devices().filter(device => device.name === '我的裝置')).toHaveLength(3);
    const malformedBody = await app.inject({ method: 'POST', url: '/api/auth/pair', headers, payload: [] });
    expect(malformedBody.statusCode).toBe(400);
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
    expect(bridge.request).toHaveBeenCalledWith('thread/list', expect.objectContaining({ projectId, cursor: 'synthetic-cursor', modelProviders: [], sourceKinds: ['cli', 'vscode', 'exec', 'appServer', 'unknown'] }));
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
  it('reuses original desktop thread identities and merges only assigned legacy history on the first page', async () => {
    const native = { id: 'synthetic-native-thread', projectId, cwd: bridge.cwd, name: 'Synthetic native title', updatedAt: 100 };
    const legacy = { id: 'synthetic-legacy-thread', projectId: null, cwd: bridge.cwd, name: 'Synthetic original desktop title', updatedAt: 200 };
    const unassigned = { id: 'synthetic-unassigned-thread', projectId: null, cwd: bridge.cwd, name: 'Synthetic unrelated CLI title', updatedAt: 300 };
    const wrongProject = { id: 'synthetic-cross-project-thread', projectId: 'synthetic-other-official-project', cwd: bridge.cwd, updatedAt: 400 };
    legacyAssignments[projectId] = [legacy.id, native.id, 'synthetic-unavailable-thread', wrongProject.id];
    bridge.request.mockImplementation(async (method: string, rpcParams: any) => {
      if (method === 'thread/list') return { data: [native, unassigned, wrongProject], nextCursor: 'synthetic-native-next-page' };
      if (method === 'thread/read') {
        const thread = [native, legacy, unassigned, wrongProject].find(item => item.id === rpcParams.threadId);
        if (!thread) throw new Error('CODEX_RPC_ERROR');
        return { thread };
      }
      return {};
    });
    const first = await app.inject({ url: `/api/threads?projectId=${projectId}`, headers: { ...headers, cookie } });
    expect(first.statusCode).toBe(200);
    expect(first.json().data.map((thread: any) => ({ id: thread.id, name: thread.name }))).toEqual([
      { id: legacy.id, name: 'Synthetic original desktop title' },
      { id: native.id, name: 'Synthetic native title' },
    ]);
    expect(first.json().nextCursor).toBe('synthetic-native-next-page');
    expect(bridge.request).toHaveBeenCalledWith('thread/list', expect.objectContaining({ projectId, sourceKinds: ['cli', 'vscode', 'exec', 'appServer', 'unknown'] }));
    const nativeListCall = bridge.request.mock.calls.find(call => call[0] === 'thread/list');
    expect(nativeListCall?.[1]).not.toHaveProperty('cwd');
    bridge.request.mockClear();
    const next = await app.inject({ url: `/api/threads?projectId=${projectId}&cursor=synthetic-native-next-page`, headers: { ...headers, cookie } });
    expect(next.json().data.map((thread: any) => thread.id)).toEqual([native.id]);
    expect(bridge.request.mock.calls.some(call => call[0] === 'thread/read')).toBe(false);
    for (const threadId of [unassigned.id, wrongProject.id]) {
      const response = await app.inject({ url: `/api/threads/${threadId}?projectId=${projectId}`, headers: { ...headers, cookie } });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ error: 'THREAD_NOT_IN_PROJECT' });
    }
    const resumed = await app.inject({ method: 'POST', url: `/api/threads/${legacy.id}/resume`, headers: { ...headers, cookie }, payload: { projectId } });
    expect(resumed.statusCode).toBe(200);
    expect(bridge.request).toHaveBeenCalledWith('thread/resume', expect.objectContaining({ threadId: legacy.id, excludeTurns: true }));
    const created = await app.inject({ method: 'POST', url: '/api/threads', headers: { ...headers, cookie }, payload: { projectId } });
    expect(created.statusCode).toBe(200);
    expect(bridge.request).toHaveBeenCalledWith('thread/start', expect.objectContaining({ projectId, cwd: bridge.cwd }));
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
    registeredProjects.push({ id: 'synthetic-other-project', name: 'Other Synthetic Project', path: otherDir, roots: [otherDir] });
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
