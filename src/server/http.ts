import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { createReadStream } from 'node:fs';
import type { AppEvent, PendingRequest, ServiceStatus } from '../shared/types.js';
import type { AppConfig } from './config.js';
import { Store } from './store.js';
import { Files, HttpError } from './files.js';
import { accessState, authenticate, checkBoundary, COOKIE_NAME, COOKIE_OPTIONS, tokenAuthorized, validateRequestResult } from './auth.js';

export interface HttpBridge {
  status: ServiceStatus;
  pendingRequests: PendingRequest[];
  eventsSince(seq: number): { events: AppEvent[]; reset: boolean };
  on(event: 'event', handler: (event: AppEvent) => void): unknown;
  off(event: 'event', handler: (event: AppEvent) => void): unknown;
  request(method: string, params?: any): Promise<any>;
  respond(id: string | number, result: any): void;
  startTurn(threadId: string, params: any, requestId: string): Promise<any>;
  interrupt(threadId: string): Promise<any>;
}
interface AppOptions { config: AppConfig; store: Store; bridge: HttpBridge; files: Files }
type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'INVALID_INPUT');
  return value as ObjectValue;
};
const string = (value: unknown, max = 1000): string => {
  if (typeof value !== 'string' || !value.length || value.length > max) throw new HttpError(400, 'INVALID_INPUT');
  return value;
};
const query = (request: FastifyRequest): ObjectValue => (request.query || {}) as ObjectValue;
const params = (request: FastifyRequest): ObjectValue => request.params as ObjectValue;

export async function buildApp({ config, store, bridge, files }: AppOptions): Promise<FastifyInstance> {
  if (config.host === 'tailscale' || config.host === 'private') throw new Error('LISTENER_HOST_NOT_RESOLVED');
  const app = Fastify({ logger: false, bodyLimit: 256 * 1024, requestTimeout: 30_000, trustProxy: false });
  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 0, parts: 1 } });
  await app.register(websocket, { options: { maxPayload: 4096 } });

  app.addHook('onRequest', async (request, reply) => {
    checkBoundary(request, config);
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Cross-Origin-Resource-Policy', 'same-origin');
    reply.header('Content-Security-Policy', `default-src 'self'; script-src 'self'; connect-src 'self' ws://${config.host}:${config.port}; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`);
    const pathname = request.url.split('?')[0];
    if (pathname.startsWith('/api/')) {
      reply.header('Cache-Control', 'no-store');
      if (!['/api/auth', '/api/auth/pair'].includes(pathname) && !accessState(request, store).authenticated) throw new HttpError(401, 'AUTHENTICATION_REQUIRED');
    }
  });
  app.setErrorHandler((error, _request, reply) => {
    const message = error instanceof Error ? error.message : '';
    const rawStatus = typeof error === 'object' && error !== null && 'statusCode' in error ? error.statusCode : undefined;
    const safeCode = error instanceof HttpError ? error.message : /^[A-Z][A-Z_]{2,79}$/.test(message) ? message : 'REQUEST_FAILED';
    const statusCode = error instanceof HttpError ? error.statusCode : typeof rawStatus === 'number' && rawStatus >= 400 && rawStatus < 600 ? rawStatus : safeCode === 'THREAD_BUSY' ? 409 : safeCode === 'CODEX_OFFLINE' ? 503 : 500;
    reply.code(statusCode).send({ error: safeCode });
  });

  app.get('/api/auth', async request => accessState(request, store));
  app.post('/api/settings/pairing', async request => {
    const body = object(request.body);
    if (Object.keys(body).length !== 1 || typeof body.required !== 'boolean') throw new HttpError(400, 'INVALID_PAIRING_SETTING');
    store.setPairingRequired(body.required);
    return accessState(request, store);
  });
  app.post('/api/auth/pair', async (request, reply) => {
    const body = object(request.body);
    if (typeof body.code !== 'string' || body.code.length > 128) throw new HttpError(400, 'PAIRING_CODE_FORMAT_INVALID');
    const code = body.code.normalize('NFKC').replace(/[\s-]/g, '');
    if (!/^\d{8}$/.test(code)) throw new HttpError(400, 'PAIRING_CODE_FORMAT_INVALID');
    if (body.deviceName !== undefined && (typeof body.deviceName !== 'string' || body.deviceName.length > 100)) throw new HttpError(400, 'DEVICE_NAME_INVALID');
    const deviceName = (typeof body.deviceName === 'string' ? body.deviceName.trim().replace(/[\x00-\x1f\x7f]/g, '') : '') || '我的裝置';
    const paired = store.pair(code, deviceName);
    if (!paired) throw new HttpError(401, 'PAIRING_CODE_INVALID_OR_EXPIRED');
    reply.setCookie(COOKIE_NAME, paired.token, COOKIE_OPTIONS);
    return { authenticated: true };
  });
  app.post('/api/auth/logout', async (request, reply) => {
    const device = authenticate(request, store);
    if (device) store.revoke(device.id);
    reply.clearCookie(COOKIE_NAME, { path: '/' });
    return {};
  });
  app.get('/api/status', async () => bridge.status);
  app.get('/api/projects', async () => ({ projects: await files.projects() }));
  app.get('/api/projects/:id/tree', async request => files.tree(string(params(request).id), typeof query(request).path === 'string' ? query(request).path as string : ''));
  app.get('/api/projects/:id/file', async request => files.read(string(params(request).id), string(query(request).path, 4000)));
  app.get('/api/models', async () => bridge.request('model/list', { limit: 100 }));

  async function checkedThread(threadId: string, projectId: string): Promise<any> {
    await files.project(projectId);
    const response = await bridge.request('thread/read', { threadId, includeTurns: false });
    if (!response?.thread || response.thread.id !== threadId || typeof response.thread.cwd !== 'string') throw new HttpError(404, 'THREAD_NOT_FOUND');
    const assigned = response.thread.projectId;
    if (assigned !== projectId && (assigned || !(await files.threadIds(projectId)).includes(threadId))) throw new HttpError(403, 'THREAD_NOT_IN_PROJECT');
    await files.assertThread(projectId, response.thread.cwd);
    return response.thread;
  }

  app.get('/api/threads', async request => {
    const projectId = string(query(request).projectId);
    await files.project(projectId);
    const legacyIds = await files.threadIds(projectId);
    const cursor = query(request).cursor;
    const response = await bridge.request('thread/list', { projectId, sourceKinds: ['cli', 'vscode', 'exec', 'appServer', 'unknown'], modelProviders: [], sortKey: 'updated_at', limit: 40, ...(cursor ? { cursor: string(cursor) } : {}) });
    const data: any[] = [];
    const seen = new Set<string>();
    for (const thread of Array.isArray(response.data) ? response.data : []) {
      if (typeof thread?.id !== 'string' || seen.has(thread.id) || (thread.projectId !== projectId && (thread.projectId || !legacyIds.includes(thread.id)))) continue;
      try { await files.assertThread(projectId, thread.cwd); data.push(thread); seen.add(thread.id); } catch { /* Filter escaped or unavailable roots. */ }
    }
    if (!cursor) for (const id of legacyIds) {
      if (seen.has(id)) continue;
      try { const thread = await checkedThread(id, projectId); data.push(thread); seen.add(id); } catch { /* A draft or unavailable legacy thread cannot hide the remaining history. */ }
    }
    data.sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0));
    return { data, nextCursor: response.nextCursor || null };
  });
  app.post('/api/threads', async request => {
    const body = object(request.body);
    const project = await files.project(string(body.projectId));
    if (!project.path) throw new HttpError(400, 'PROJECT_HAS_NO_LOCAL_ROOTS');
    return bridge.request('thread/start', { projectId: project.id, cwd: project.path, approvalPolicy: 'on-request', sandbox: 'workspace-write', ...(body.model ? { model: string(body.model) } : {}) });
  });
  app.get('/api/threads/:id', async request => ({ thread: await checkedThread(string(params(request).id), string(query(request).projectId)) }));
  app.get('/api/threads/:id/turns', async request => {
    const threadId = string(params(request).id);
    await checkedThread(threadId, string(query(request).projectId));
    const cursor = query(request).cursor;
    return bridge.request('thread/turns/list', { threadId, limit: 40, itemsView: 'full', ...(cursor ? { cursor: string(cursor) } : {}) });
  });
  app.post('/api/threads/:id/resume', async request => {
    const body = object(request.body);
    const threadId = string(params(request).id);
    const thread = await checkedThread(threadId, string(body.projectId));
    return bridge.request('thread/resume', { threadId, cwd: thread.cwd, approvalPolicy: 'on-request', sandbox: 'workspace-write', excludeTurns: true });
  });
  app.patch('/api/threads/:id', async request => {
    const body = object(request.body);
    const threadId = string(params(request).id);
    await checkedThread(threadId, string(body.projectId));
    await bridge.request('thread/name/set', { threadId, name: string(body.name, 200).trim() });
    return {};
  });
  app.post('/api/threads/:id/messages', async request => {
    const body = object(request.body);
    const projectId = string(body.projectId);
    const threadId = string(params(request).id);
    await checkedThread(threadId, projectId);
    const text = body.text === undefined ? '' : typeof body.text === 'string' && body.text.length <= 100_000 ? body.text : string(body.text, 100_000);
    const attachmentIds = body.attachmentIds === undefined ? [] : body.attachmentIds;
    if (!Array.isArray(attachmentIds) || attachmentIds.length > 8 || new Set(attachmentIds).size !== attachmentIds.length) throw new HttpError(400, 'INVALID_ATTACHMENTS');
    const input: ObjectValue[] = text.trim() ? [{ type: 'text', text, text_elements: [] }] : [];
    for (const id of attachmentIds) {
      const attachment = await files.attachment(string(id), projectId);
      input.push({ type: 'localImage', path: attachment.path });
    }
    if (!input.length) throw new HttpError(400, 'MESSAGE_REQUIRED');
    const requestId = string(body.requestId, 128);
    if (requestId.length < 8) throw new HttpError(400, 'INVALID_REQUEST_ID');
    return bridge.startTurn(threadId, { input, ...(body.model ? { model: string(body.model) } : {}) }, requestId);
  });
  app.post('/api/threads/:id/interrupt', async request => {
    const body = object(request.body);
    const threadId = string(params(request).id);
    await checkedThread(threadId, string(body.projectId));
    return bridge.interrupt(threadId);
  });
  app.post('/api/uploads', async request => {
    const projectId = string(query(request).projectId);
    await files.project(projectId);
    const part = await request.file();
    if (!part) throw new HttpError(400, 'IMAGE_REQUIRED');
    const bytes = await part.toBuffer();
    if (part.file.truncated) throw new HttpError(413, 'IMAGE_TOO_LARGE');
    return files.upload(projectId, part.filename, part.mimetype, bytes);
  });
  app.get('/api/uploads/:id', async (request, reply) => {
    const attachment = await files.attachment(string(params(request).id));
    reply.type(attachment.mime);
    return reply.send(createReadStream(attachment.path));
  });
  app.get('/api/requests', async () => ({ requests: bridge.pendingRequests }));
  app.post('/api/requests/:id', async request => {
    const id = string(params(request).id);
    const pending = bridge.pendingRequests.find(item => String(item.id) === id);
    if (!pending) throw new HttpError(404, 'REQUEST_NOT_FOUND');
    const body = object(request.body);
    bridge.respond(pending.id, validateRequestResult(pending, body.result));
    return {};
  });

  app.get('/api/events', { websocket: true }, (socket, request) => {
    const token = request.cookies[COOKIE_NAME];
    const send = (event: AppEvent): void => {
      if (!tokenAuthorized(token, store)) { socket.close(4401, 'Authentication required'); return; }
      if (socket.readyState !== 1) return;
      if (socket.bufferedAmount > 1024 * 1024) { socket.close(1013, 'Reconnect to refresh'); return; }
      socket.send(JSON.stringify(event));
    };
    const rawAfter = query(request).after;
    const after = rawAfter === undefined ? 0 : Number(rawAfter);
    if (!Number.isSafeInteger(after) || after < 0) { socket.close(4400, 'Invalid cursor'); return; }
    const replay = bridge.eventsSince(after);
    if (replay.reset) send({ seq: 0, method: 'pocketagent/reset', params: {} });
    else for (const event of replay.events) send(event);
    send({ seq: 0, method: 'pocketagent/status', params: { status: bridge.status } });
    send({ seq: 0, method: 'pocketagent/requests', params: { requests: bridge.pendingRequests } });
    bridge.on('event', send);
    const authTimer = setInterval(() => { if (!tokenAuthorized(token, store)) socket.close(4401, 'Authentication required'); }, 5000);
    authTimer.unref();
    socket.on('message', () => {
      if (!tokenAuthorized(token, store)) socket.close(4401, 'Authentication required');
      else socket.close(4400, 'Read-only event stream');
    });
    socket.on('error', () => { /* No raw messages or errors are logged. */ });
    socket.on('close', () => { clearInterval(authTimer); bridge.off('event', send); });
  });
  if (config.staticDir && existsSync(config.staticDir)) {
    await app.register(fastifyStatic, { root: config.staticDir, wildcard: false });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) return reply.code(404).send({ error: 'NOT_FOUND' });
      reply.header('Cache-Control', 'no-store');
      return reply.sendFile('index.html');
    });
  }
  return app;
}
