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
  created = new Map<string, string>();
  createdThreadProject(id: string) { return this.created.get(id); }
  createdThreadIds(projectId: string) { return [...this.created].filter(([, id]) => id === projectId).map(([id]) => id); }
  startTurn = vi.fn(async (_id: string, _params: unknown, _requestId: string) => ({ turn: { id: 'synthetic-turn', status: 'inProgress', items: [] } }));
  interrupt = vi.fn(async () => ({}));
  recover = vi.fn(async () => {});
  eventsSince(after: number) { return { events: this.history.filter(event => event.seq > after), reset: after > 100 }; }
  respond(id: string | number, result: unknown) { this.response(id, result); }
  request = vi.fn<(method: string, params: any) => Promise<any>>(async (method: string, params: any) => {
    if (method === 'thread/start') { this.created.set('synthetic-new-thread', params.projectId); return { thread: { id: 'synthetic-new-thread', projectId: params.projectId, cwd: this.cwd, preview: '', turns: [] } }; }
    if (method === 'thread/read') return { thread: { id: params.threadId, projectId: params.threadId === 'synthetic-new-thread' ? null : 'synthetic-desktop-project', cwd: this.cwd, model: 'synthetic-model', preview: 'Synthetic', turns: [] } };
    if (method === 'thread/list') return { data: [{ id: 'synthetic-thread', projectId: 'synthetic-desktop-project', cwd: this.cwd, preview: 'Synthetic' }], nextCursor: 'next-synthetic-page' };
    if (method === 'thread/turns/list') return { data: [{ id: 'synthetic-turn', items: [], status: 'completed' }], nextCursor: null };
    if (method === 'model/list') return { data: [{ id: 'synthetic-model', model: 'synthetic-model', displayName: 'Synthetic', isDefault: true, defaultReasoningEffort: 'medium', supportedReasoningEfforts: ['low', 'medium', 'high'].map(reasoningEffort => ({ reasoningEffort, description: 'Synthetic effort' })) }] };
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
  it('serves rebuilt assets without restarting and never falls back to HTML for missing JavaScript', async () => {
    const staticDir = path.join(temp, 'synthetic-web');
    await mkdir(path.join(staticDir, 'assets'), { recursive: true });
    await writeFile(path.join(staticDir, 'index.html'), '<!doctype html><script type="module" src="/assets/old.js"></script>');
    await writeFile(path.join(staticDir, 'assets', 'old.js'), 'export const synthetic = "old";');
    const web = await buildApp({ config: { ...config, staticDir }, store, files, bridge });
    try {
      await web.ready();
      expect((await web.inject({ url: '/assets/old.js', headers })).headers['content-type']).toMatch(/javascript/);
      // Model a new Vite build replacing hashes after HTTP routes already exist.
      await writeFile(path.join(staticDir, 'assets', 'new.js'), 'export const synthetic = "new";');
      await writeFile(path.join(staticDir, 'index.html'), '<!doctype html><script type="module" src="/assets/new.js"></script>');
      await rm(path.join(staticDir, 'assets', 'old.js'));
      const page = await web.inject({ url: '/', headers });
      expect(page.statusCode).toBe(200);
      expect(page.body).toContain('/assets/new.js');
      expect(page.headers['cache-control']).toBe('no-store');
      const asset = await web.inject({ url: '/assets/new.js', headers });
      expect(asset.statusCode).toBe(200);
      expect(asset.headers['content-type']).toMatch(/javascript/);
      expect(asset.body).toBe('export const synthetic = "new";');
      const missing = await web.inject({ url: '/assets/old.js?cache=synthetic', headers });
      expect(missing.statusCode).toBe(404);
      expect(missing.headers['content-type']).not.toMatch(/html/);
      expect((await web.inject({ url: '/api/not-real', headers: { ...headers, cookie } })).statusCode).toBe(404);
      expect((await web.inject({ url: '/synthetic-navigation', headers })).body).toContain('/assets/new.js');
    } finally { await web.close(); }
  });
  it('requires paired authentication and rejects invalid Host, Origin and originless mutations', async () => {
    expect((await app.inject({ url: '/api/projects', headers })).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/projects', headers: { ...headers, cookie, host: 'attacker.invalid:3000' } })).statusCode).toBe(403);
    expect((await app.inject({ url: '/api/projects', headers: { ...headers, cookie, origin: 'http://attacker.invalid' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { host: headers.host, cookie } })).statusCode).toBe(403);
    expect((await app.inject({ url: '/api/projects', headers: { ...headers, cookie } })).json().projects).toHaveLength(1);
  });
  it('requires authenticated explicit confirmation for recovery and remains available while Codex recovery is pending', async () => {
    const recoverRequest = { method: 'POST' as const, url: '/api/recovery', payload: { confirm: true } };
    expect((await app.inject({ ...recoverRequest, headers })).statusCode).toBe(401);
    expect((await app.inject({ ...recoverRequest, headers: { host: headers.host, cookie } })).statusCode).toBe(403);
    expect((await app.inject({ ...recoverRequest, headers: { ...headers, cookie, origin: 'http://attacker.invalid' } })).statusCode).toBe(403);
    for (const payload of [{}, { confirm: false }, { confirm: 'true' }, { confirm: true, extra: true }]) {
      expect((await app.inject({ ...recoverRequest, headers: { ...headers, cookie }, payload })).statusCode).toBe(400);
    }
    expect(bridge.recover).not.toHaveBeenCalled();
    let release!: () => void;
    bridge.recover.mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
    bridge.status = { codex: 'offline' };
    bridge.request.mockImplementation(async () => { throw new Error('CODEX_OFFLINE'); });
    const accepted = await app.inject({ ...recoverRequest, headers: { ...headers, cookie } });
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json()).toEqual({ accepted: true });
    expect(bridge.recover).toHaveBeenCalledOnce();
    expect((await app.inject({ url: '/api/status', headers: { ...headers, cookie } })).statusCode).toBe(200);
    expect(bridge.request).not.toHaveBeenCalled();
    expect(bridge.startTurn).not.toHaveBeenCalled();
    release();
  });
  it('disconnects event clients on all shared listeners for confirmed recovery', async () => {
    const disconnectClients = vi.fn(() => {
      for (const listener of [app, recoveryApp]) for (const client of listener.websocketServer.clients) client.terminate();
    });
    const recoveryApp: FastifyInstance = await buildApp({ config, store, files, bridge, disconnectClients });
    await recoveryApp.ready();
    const first = await app.injectWS('/api/events', { headers: { ...headers, cookie } });
    const second = await recoveryApp.injectWS('/api/events', { headers: { ...headers, cookie } });
    try {
      const closed = Promise.all([once(first, 'close'), once(second, 'close')]);
      const accepted = await recoveryApp.inject({ method: 'POST', url: '/api/recovery', headers: { ...headers, cookie }, payload: { confirm: true } });
      expect(accepted.statusCode).toBe(202);
      await closed;
      expect(disconnectClients).toHaveBeenCalledOnce();
      expect(bridge.listenerCount('event')).toBe(0);
      expect(bridge.startTurn).not.toHaveBeenCalled();
    } finally { first.terminate(); second.terminate(); await recoveryApp.close(); }
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
  it('reports another client writer as a conflict while leaving existing history readable', async () => {
    const originalRequest = bridge.request.getMockImplementation()!;
    bridge.request.mockImplementation(async (method, rpcParams) => {
      if (method === 'thread/resume') throw new Error('THREAD_WRITER_CONFLICT');
      return originalRequest(method, rpcParams);
    });
    const resumed = await app.inject({ method: 'POST', url: '/api/threads/synthetic-thread/resume', headers: { ...headers, cookie }, payload: { projectId } });
    expect(resumed.statusCode).toBe(409);
    expect(resumed.json()).toEqual({ error: 'THREAD_WRITER_CONFLICT' });
    const history = await app.inject({ url: `/api/threads/synthetic-thread/turns?projectId=${projectId}`, headers: { ...headers, cookie } });
    expect(history.statusCode).toBe(200);
    expect(history.json().data).toHaveLength(1);
    expect(bridge.startTurn).not.toHaveBeenCalled();
  });
  it('loads a small newest history page and validates page sizes before requesting history', async () => {
    const url = `/api/threads/synthetic-thread/turns?projectId=${projectId}`;
    expect((await app.inject({ url, headers: { ...headers, cookie } })).statusCode).toBe(200);
    expect(bridge.request).toHaveBeenCalledWith('thread/turns/list', { threadId: 'synthetic-thread', limit: 6, sortDirection: 'desc', itemsView: 'full' });
    expect((await app.inject({ url: url + '&limit=3&cursor=synthetic-older-page', headers: { ...headers, cookie } })).statusCode).toBe(200);
    expect(bridge.request).toHaveBeenCalledWith('thread/turns/list', { threadId: 'synthetic-thread', limit: 3, sortDirection: 'desc', itemsView: 'full', cursor: 'synthetic-older-page' });
    for (const limit of ['0', '21', '-1', '1.5', 'all']) {
      bridge.request.mockClear();
      expect((await app.inject({ url: url + `&limit=${limit}`, headers: { ...headers, cookie } })).statusCode).toBe(400);
      expect(bridge.request.mock.calls.some(([method]) => method === 'thread/turns/list')).toBe(false);
    }
  });
  it('bounds legacy thread reads and keeps remaining sessions reachable through opaque cursors', async () => {
    const ids = Array.from({ length: 45 }, (_, index) => `synthetic-legacy-${index}`);
    legacyAssignments[projectId] = ids;
    bridge.request.mockImplementation(async (method, rpcParams) => {
      if (method === 'thread/list') return { data: [], nextCursor: null };
      if (method === 'thread/read') return { thread: { id: rpcParams.threadId, projectId: null, cwd: bridge.cwd, preview: 'Synthetic', updatedAt: 1 } };
      return {};
    });
    const loaded: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 3; page++) {
      bridge.request.mockClear();
      const response = await app.inject({ url: `/api/threads?projectId=${projectId}${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`, headers: { ...headers, cookie } });
      expect(response.statusCode).toBe(200);
      const result: { data: { id: string }[]; nextCursor: string | null } = response.json();
      expect(result.data.length).toBeLessThanOrEqual(20);
      expect(bridge.request.mock.calls.filter(([method]) => method === 'thread/read').length).toBeLessThanOrEqual(20);
      loaded.push(...result.data.map((thread: any) => thread.id));
      cursor = result.nextCursor;
    }
    expect(cursor).toBeNull();
    expect(loaded).toEqual(ids);
    expect(bridge.request.mock.calls.some(([method]) => method === 'thread/list')).toBe(false);
    expect((await app.inject({ url: `/api/threads?projectId=${projectId}&cursor=pocketagent:1:invalid`, headers: { ...headers, cookie } })).statusCode).toBe(400);
  });
  it('does not skip a draft when canonical metadata removes earlier transient assignments between pages', async () => {
    const ids = ['synthetic-draft-a', 'synthetic-draft-b', 'synthetic-draft-c'];
    for (const id of ids) bridge.created.set(id, projectId);
    bridge.request.mockImplementation(async (method, rpcParams) => {
      if (method === 'thread/list') return { data: [], nextCursor: null };
      if (method === 'thread/read') {
        bridge.created.delete(rpcParams.threadId);
        return { thread: { id: rpcParams.threadId, projectId, cwd: bridge.cwd, preview: 'Synthetic', updatedAt: 1 } };
      }
      return {};
    });
    const loaded: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 3; page++) {
      const response = await app.inject({ url: `/api/threads?projectId=${projectId}&limit=1${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`, headers: { ...headers, cookie } });
      const result: { data: { id: string }[]; nextCursor: string | null } = response.json();
      loaded.push(...result.data.map(thread => thread.id));
      cursor = result.nextCursor;
    }
    expect(loaded).toEqual(ids);
    expect(cursor).toBeNull();
  });
  it('sends the first message of a verified new thread before its project assignment is persisted, including reasoning effort', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/threads', headers: { ...headers, cookie }, payload: { projectId, model: 'synthetic-model', effort: 'high' } });
    expect(created.statusCode).toBe(200);
    expect(bridge.request).toHaveBeenCalledWith('thread/start', expect.objectContaining({ projectId, config: { model_reasoning_effort: 'high' } }));
    const sent = await app.inject({ method: 'POST', url: '/api/threads/synthetic-new-thread/messages', headers: { ...headers, cookie }, payload: { projectId, text: 'Synthetic first message', effort: 'high', requestId: 'synthetic-new-request' } });
    expect(sent.statusCode).toBe(200);
    expect(bridge.startTurn).toHaveBeenCalledWith('synthetic-new-thread', expect.objectContaining({ effort: 'high', input: [expect.objectContaining({ text: 'Synthetic first message' })] }), 'synthetic-new-request');
    const listed = await app.inject({ url: `/api/threads?projectId=${projectId}`, headers: { ...headers, cookie } });
    expect(listed.json().data.some((thread: any) => thread.id === 'synthetic-new-thread')).toBe(true);
    const implementation = bridge.request.getMockImplementation()!;
    bridge.request.mockImplementation(async (method, params) => method === 'thread/read' ? { thread: { id: params.threadId, projectId: 'other-project', cwd: bridge.cwd } } : implementation(method, params));
    expect((await app.inject({ url: `/api/threads/synthetic-new-thread?projectId=${projectId}`, headers: { ...headers, cookie } })).statusCode).toBe(403);
    bridge.request.mockImplementation(async (method, params) => method === 'thread/read' ? { thread: { id: params.threadId, projectId: null, cwd: bridge.cwd } } : implementation(method, params));
    expect((await app.inject({ url: `/api/threads/unrelated-thread?projectId=${projectId}`, headers: { ...headers, cookie } })).statusCode).toBe(403);
    bridge.cwd = temp;
    expect((await app.inject({ url: `/api/threads/synthetic-new-thread?projectId=${projectId}`, headers: { ...headers, cookie } })).statusCode).toBe(403);
  });
  it('inherits native project and session authorization without forwarding browser permission overrides', async () => {
    const injected = { approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: 'danger-full-access', permissions: 'synthetic-unrequested-profile', config: { sandbox_mode: 'danger-full-access' } };
    const created = await app.inject({ method: 'POST', url: '/api/threads', headers: { ...headers, cookie }, payload: { projectId, model: 'synthetic-model', effort: 'high', ...injected } });
    expect(created.statusCode).toBe(200);
    expect(bridge.request).toHaveBeenCalledWith('thread/start', { projectId, cwd: bridge.cwd, model: 'synthetic-model', config: { model_reasoning_effort: 'high' } });
    const resumed = await app.inject({ method: 'POST', url: '/api/threads/synthetic-thread/resume', headers: { ...headers, cookie }, payload: { projectId, ...injected } });
    expect(resumed.statusCode).toBe(200);
    expect(bridge.request).toHaveBeenCalledWith('thread/resume', { threadId: 'synthetic-thread', cwd: bridge.cwd, excludeTurns: true });
    const sent = await app.inject({ method: 'POST', url: '/api/threads/synthetic-thread/messages', headers: { ...headers, cookie }, payload: { projectId, text: 'Synthetic message', requestId: 'synthetic-inherit-request', ...injected } });
    expect(sent.statusCode).toBe(200);
    expect(bridge.startTurn).toHaveBeenCalledWith('synthetic-thread', { input: [{ type: 'text', text: 'Synthetic message', text_elements: [] }] }, 'synthetic-inherit-request');
  });
  it('syncs the local desktop reviewer for thread creation, resume and turns without forwarding other permission overrides', async () => {
    config.codexHome = path.join(temp, 'synthetic-codex-home');
    await mkdir(config.codexHome);
    await writeFile(path.join(config.codexHome, '.codex-global-state.json'), JSON.stringify({
      'electron-persisted-atom-state': { 'permission-selection-by-host-id:local': { kind: 'agent-mode', agentMode: 'guardian-approvals' } },
    }));
    const injected = { approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: 'danger-full-access', sandboxPolicy: { type: 'dangerFullAccess' }, permissions: 'synthetic-unrequested-profile', config: { approvals_reviewer: 'user', sandbox_mode: 'danger-full-access' } };
    const created = await app.inject({ method: 'POST', url: '/api/threads', headers: { ...headers, cookie }, payload: { projectId, model: 'synthetic-model', effort: 'high', ...injected } });
    expect(created.statusCode).toBe(200);
    expect(bridge.request).toHaveBeenCalledWith('thread/start', { projectId, cwd: bridge.cwd, model: 'synthetic-model', config: { model_reasoning_effort: 'high' }, approvalsReviewer: 'auto_review' });
    const resumed = await app.inject({ method: 'POST', url: '/api/threads/synthetic-thread/resume', headers: { ...headers, cookie }, payload: { projectId, ...injected } });
    expect(resumed.statusCode).toBe(200);
    expect(bridge.request).toHaveBeenCalledWith('thread/resume', { threadId: 'synthetic-thread', cwd: bridge.cwd, excludeTurns: true, approvalsReviewer: 'auto_review' });
    const sent = await app.inject({ method: 'POST', url: '/api/threads/synthetic-thread/messages', headers: { ...headers, cookie }, payload: { projectId, text: 'Synthetic reviewer message', model: 'synthetic-model', effort: 'high', requestId: 'synthetic-review-request', ...injected } });
    expect(sent.statusCode).toBe(200);
    expect(bridge.startTurn).toHaveBeenCalledWith('synthetic-thread', { input: [{ type: 'text', text: 'Synthetic reviewer message', text_elements: [] }], model: 'synthetic-model', effort: 'high' }, 'synthetic-review-request', 'auto_review');
  });
  it('rereads desktop preferences between operations and omits unknown or custom review selections', async () => {
    config.codexHome = path.join(temp, 'synthetic-codex-home');
    await mkdir(config.codexHome);
    const statePath = path.join(config.codexHome, '.codex-global-state.json');
    await writeFile(statePath, JSON.stringify({
      'electron-persisted-atom-state': { 'permission-selection-by-host-id:local': { kind: 'agent-mode', agentMode: 'guardian-approvals' } },
    }));
    expect((await app.inject({ method: 'POST', url: '/api/threads/synthetic-thread/resume', headers: { ...headers, cookie }, payload: { projectId } })).statusCode).toBe(200);
    expect(bridge.request).toHaveBeenCalledWith('thread/resume', { threadId: 'synthetic-thread', cwd: bridge.cwd, excludeTurns: true, approvalsReviewer: 'auto_review' });
    for (const selection of [{ kind: 'agent-mode', agentMode: 'synthetic-future-mode' }, { kind: 'custom' }]) {
      await writeFile(statePath, JSON.stringify({
        'electron-persisted-atom-state': { 'permission-selection-by-host-id:local': selection, 'agent-mode-by-host-id': { local: 'guardian-approvals' } },
      }));
      bridge.request.mockClear();
      expect((await app.inject({ method: 'POST', url: '/api/threads', headers: { ...headers, cookie }, payload: { projectId } })).statusCode).toBe(200);
      expect(bridge.request).toHaveBeenCalledWith('thread/start', { projectId, cwd: bridge.cwd });
      expect((await app.inject({ method: 'POST', url: '/api/threads/synthetic-thread/resume', headers: { ...headers, cookie }, payload: { projectId } })).statusCode).toBe(200);
      expect(bridge.request).toHaveBeenCalledWith('thread/resume', { threadId: 'synthetic-thread', cwd: bridge.cwd, excludeTurns: true });
      bridge.startTurn.mockClear();
      expect((await app.inject({ method: 'POST', url: '/api/threads/synthetic-thread/messages', headers: { ...headers, cookie }, payload: { projectId, text: 'Synthetic preference update', requestId: 'synthetic-preference-request' } })).statusCode).toBe(200);
      expect(bridge.startTurn).toHaveBeenCalledWith('synthetic-thread', { input: [{ type: 'text', text: 'Synthetic preference update', text_elements: [] }] }, 'synthetic-preference-request');
    }
  });
  it('propagates native reviewer policy rejection without retrying with different authorization or starting work', async () => {
    config.codexHome = path.join(temp, 'synthetic-codex-home');
    await mkdir(config.codexHome);
    await writeFile(path.join(config.codexHome, '.codex-global-state.json'), JSON.stringify({
      'electron-persisted-atom-state': { 'permission-selection-by-host-id:local': { kind: 'agent-mode', agentMode: 'guardian-approvals' } },
    }));
    const originalRequest = bridge.request.getMockImplementation()!;
    bridge.request.mockImplementation(async (method, rpcParams) => {
      if (method === 'thread/resume') throw new Error('CODEX_RPC_ERROR');
      return originalRequest(method, rpcParams);
    });
    const resumed = await app.inject({ method: 'POST', url: '/api/threads/synthetic-thread/resume', headers: { ...headers, cookie }, payload: { projectId } });
    expect(resumed.statusCode).toBe(500);
    expect(resumed.json()).toEqual({ error: 'CODEX_RPC_ERROR' });
    expect(bridge.request.mock.calls.filter(([method]) => method === 'thread/resume')).toEqual([
      ['thread/resume', { threadId: 'synthetic-thread', cwd: bridge.cwd, excludeTurns: true, approvalsReviewer: 'auto_review' }],
    ]);
    expect(bridge.request.mock.calls.some(([method]) => method === 'thread/start')).toBe(false);
    expect(bridge.startTurn).not.toHaveBeenCalled();
  });
  it('updates a loaded thread whose resume ignores the reviewer and returns verified native settings', async () => {
    config.codexHome = path.join(temp, 'synthetic-codex-home');
    await mkdir(config.codexHome);
    await writeFile(path.join(config.codexHome, '.codex-global-state.json'), JSON.stringify({
      'electron-persisted-atom-state': { 'permission-selection-by-host-id:local': { kind: 'agent-mode', agentMode: 'guardian-approvals' } },
    }));
    const native = { thread: { id: 'synthetic-thread', projectId, cwd: bridge.cwd, turns: [] }, approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: { type: 'workspaceWrite', writableRoots: [bridge.cwd], networkAccess: false }, activePermissionProfile: { id: 'synthetic-managed-profile', extends: null }, model: 'synthetic-model', reasoningEffort: 'high' };
    let reviewer = 'user';
    const originalRequest = bridge.request.getMockImplementation()!;
    bridge.request.mockImplementation(async (method, rpcParams) => {
      if (method === 'thread/resume') return { ...native, approvalsReviewer: reviewer };
      if (method === 'thread/settings/update') { reviewer = rpcParams.approvalsReviewer; return {}; }
      return originalRequest(method, rpcParams);
    });
    const resumed = await app.inject({ method: 'POST', url: '/api/threads/synthetic-thread/resume', headers: { ...headers, cookie }, payload: { projectId } });
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json()).toEqual({ ...native, approvalsReviewer: 'auto_review' });
    expect(bridge.request.mock.calls.filter(([method]) => method !== 'thread/read')).toEqual([
      ['thread/resume', { threadId: 'synthetic-thread', cwd: bridge.cwd, excludeTurns: true, approvalsReviewer: 'auto_review' }],
      ['thread/settings/update', { threadId: 'synthetic-thread', approvalsReviewer: 'auto_review' }],
      ['thread/resume', { threadId: 'synthetic-thread', cwd: bridge.cwd, excludeTurns: true }],
    ]);
    expect(bridge.startTurn).not.toHaveBeenCalled();
    bridge.request.mockClear();
    expect((await app.inject({ method: 'POST', url: '/api/threads/synthetic-thread/resume', headers: { ...headers, cookie }, payload: { projectId } })).statusCode).toBe(200);
    expect(bridge.request.mock.calls.filter(([method]) => method !== 'thread/read')).toEqual([
      ['thread/resume', { threadId: 'synthetic-thread', cwd: bridge.cwd, excludeTurns: true, approvalsReviewer: 'auto_review' }],
    ]);
  });
  it('preserves native rejection when updating a loaded thread reviewer without starting work or retrying', async () => {
    config.codexHome = path.join(temp, 'synthetic-codex-home');
    await mkdir(config.codexHome);
    await writeFile(path.join(config.codexHome, '.codex-global-state.json'), JSON.stringify({
      'electron-persisted-atom-state': { 'permission-selection-by-host-id:local': { kind: 'agent-mode', agentMode: 'guardian-approvals' } },
    }));
    const originalRequest = bridge.request.getMockImplementation()!;
    bridge.request.mockImplementation(async (method, rpcParams) => {
      if (method === 'thread/resume') return { approvalsReviewer: 'user' };
      if (method === 'thread/settings/update') throw new Error('CODEX_RPC_ERROR');
      return originalRequest(method, rpcParams);
    });
    const resumed = await app.inject({ method: 'POST', url: '/api/threads/synthetic-thread/resume', headers: { ...headers, cookie }, payload: { projectId } });
    expect(resumed.statusCode).toBe(500);
    expect(resumed.json()).toEqual({ error: 'CODEX_RPC_ERROR' });
    expect(bridge.request.mock.calls.filter(([method]) => method !== 'thread/read')).toEqual([
      ['thread/resume', { threadId: 'synthetic-thread', cwd: bridge.cwd, excludeTurns: true, approvalsReviewer: 'auto_review' }],
      ['thread/settings/update', { threadId: 'synthetic-thread', approvalsReviewer: 'auto_review' }],
    ]);
    expect(bridge.startTurn).not.toHaveBeenCalled();
  });
  it('reports an unconfirmed desktop reviewer instead of claiming the loaded thread was synchronized', async () => {
    config.codexHome = path.join(temp, 'synthetic-codex-home');
    await mkdir(config.codexHome);
    await writeFile(path.join(config.codexHome, '.codex-global-state.json'), JSON.stringify({
      'electron-persisted-atom-state': { 'permission-selection-by-host-id:local': { kind: 'agent-mode', agentMode: 'guardian-approvals' } },
    }));
    const originalRequest = bridge.request.getMockImplementation()!;
    bridge.request.mockImplementation(async (method, rpcParams) => method === 'thread/resume' ? { approvalsReviewer: 'user' } : originalRequest(method, rpcParams));
    const resumed = await app.inject({ method: 'POST', url: '/api/threads/synthetic-thread/resume', headers: { ...headers, cookie }, payload: { projectId } });
    expect(resumed.statusCode).toBe(409);
    expect(resumed.json()).toEqual({ error: 'DESKTOP_REVIEWER_NOT_APPLIED' });
    expect(bridge.request.mock.calls.filter(([method]) => method !== 'thread/read')).toEqual([
      ['thread/resume', { threadId: 'synthetic-thread', cwd: bridge.cwd, excludeTurns: true, approvalsReviewer: 'auto_review' }],
      ['thread/settings/update', { threadId: 'synthetic-thread', approvalsReviewer: 'auto_review' }],
      ['thread/resume', { threadId: 'synthetic-thread', cwd: bridge.cwd, excludeTurns: true }],
    ]);
    expect(bridge.startTurn).not.toHaveBeenCalled();
  });
  it('rejects unsupported reasoning effort before creating a thread or dispatching a turn', async () => {
    for (const effort of ['unsupported', false, 5]) {
      expect((await app.inject({ method: 'POST', url: '/api/threads', headers: { ...headers, cookie }, payload: { projectId, effort } })).statusCode).toBe(400);
      expect((await app.inject({ method: 'POST', url: '/api/threads/synthetic-thread/messages', headers: { ...headers, cookie }, payload: { projectId, text: 'Synthetic', effort, requestId: 'synthetic-bad-effort' } })).statusCode).toBe(400);
    }
    expect(bridge.request.mock.calls.some(([method]) => method === 'thread/start')).toBe(false);
    expect(bridge.startTurn).not.toHaveBeenCalled();
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
  it('closes a half-open event stream and detaches its listener without interrupting the turn', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const ws = await app.injectWS('/api/events?after=0', { headers: { ...headers, cookie } });
    try {
      const serverSocket = [...app.websocketServer.clients][0];
      // Simulate a lost network path: no ping reaches the browser, so no pong returns.
      const ping = vi.spyOn(serverSocket, 'ping').mockImplementation(() => undefined);
      const heartbeat = once(ws, 'message');
      await vi.advanceTimersByTimeAsync(15_000);
      expect(JSON.parse((await heartbeat)[0].toString())).toEqual({ seq: 0, method: 'pocketagent/heartbeat', params: {} });
      expect(ping).toHaveBeenCalledOnce();
      const closed = once(ws, 'close');
      await vi.advanceTimersByTimeAsync(15_000);
      await closed;
      expect(bridge.listenerCount('event')).toBe(0);
      expect(bridge.interrupt).not.toHaveBeenCalled();
    } finally { ws.terminate(); vi.useRealTimers(); }
  });
});
