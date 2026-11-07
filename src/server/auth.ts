import type { FastifyRequest } from 'fastify';
import type { AppConfig } from './config.js';
import { HttpError } from './files.js';
import { Store, type Device } from './store.js';
import type { AuthState, PendingRequest } from '../shared/types.js';

export const COOKIE_NAME = 'pa_session';
export const COOKIE_OPTIONS = { path: '/', httpOnly: true, sameSite: 'strict' as const, secure: false, maxAge: 30 * 24 * 60 * 60 };

export function checkBoundary(request: FastifyRequest, config: AppConfig): void {
  const authorities = new Set([`${config.host}:${config.port}`, ...(config.port === 80 ? [config.host] : [])]);
  if (config.host.startsWith('127.')) {
    authorities.add(`localhost:${config.port}`);
    if (config.port === 80) authorities.add('localhost');
  }
  const host = request.headers.host?.toLowerCase();
  if (!host || !authorities.has(host)) throw new HttpError(403, 'HOST_NOT_ALLOWED');
  const origin = request.headers.origin;
  const isWebSocket = request.headers.upgrade?.toLowerCase() === 'websocket';
  if ((isWebSocket || !['GET', 'HEAD', 'OPTIONS'].includes(request.method)) && !origin) throw new HttpError(403, 'ORIGIN_REQUIRED');
  if (origin) {
    let parsed: URL;
    try { parsed = new URL(origin); } catch { throw new HttpError(403, 'ORIGIN_NOT_ALLOWED'); }
    if (parsed.protocol !== 'http:' || !authorities.has(parsed.host) || parsed.origin !== origin) throw new HttpError(403, 'ORIGIN_NOT_ALLOWED');
  }
}

export function authenticate(request: FastifyRequest, store: Store): Device | null {
  return store.authenticate(request.cookies[COOKIE_NAME]);
}

export function accessState(request: FastifyRequest, store: Store): AuthState {
  const paired = !!authenticate(request, store);
  const pairingRequired = store.pairingRequired();
  return { authenticated: !pairingRequired || paired, pairingRequired, paired };
}
export function tokenAuthorized(token: string | undefined, store: Store): boolean {
  return !store.pairingRequired() || !!store.authenticate(token);
}

function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (record(value)) return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}

export function validateRequestResult(pending: PendingRequest, value: unknown): Record<string, unknown> {
  if (!record(value)) throw new HttpError(400, 'INVALID_REQUEST_RESPONSE');
  const keys = Object.keys(value);
  if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(pending.method)) {
    if (keys.length !== 1 || keys[0] !== 'decision' || !['accept', 'decline', 'cancel'].includes(String(value.decision))) throw new HttpError(400, 'INVALID_APPROVAL');
    return value;
  }
  if (pending.method === 'item/permissions/requestApproval') {
    if (keys.length !== 2 || !keys.includes('permissions') || !keys.includes('scope') || value.scope !== 'turn' || !record(value.permissions)) throw new HttpError(400, 'INVALID_PERMISSION_APPROVAL');
    if (Object.keys(value.permissions).length && canonical(value.permissions) !== canonical(pending.params.permissions)) throw new HttpError(400, 'PERMISSIONS_EXCEED_REQUEST');
    return value;
  }
  if (pending.method === 'mcpServer/elicitation/request') {
    if (keys.some(key => !['action', 'content', '_meta'].includes(key)) || !['decline', 'cancel'].includes(String(value.action)) || (value.content !== undefined && value.content !== null) || (value._meta !== undefined && value._meta !== null)) throw new HttpError(400, 'ELICITATION_ACCEPTANCE_UNSUPPORTED');
    return { action: value.action, content: null, _meta: null };
  }
  if (pending.method === 'item/tool/requestUserInput') {
    if (keys.length !== 1 || !record(value.answers) || !Array.isArray(pending.params.questions)) throw new HttpError(400, 'INVALID_USER_INPUT');
    const questions = pending.params.questions as Record<string, unknown>[];
    if (Object.keys(value.answers).length !== questions.length) throw new HttpError(400, 'INVALID_USER_INPUT');
    for (const question of questions) {
      const answer = value.answers[String(question.id)];
      if (!record(answer) || Object.keys(answer).length !== 1 || !Array.isArray(answer.answers) || answer.answers.length < 1 || answer.answers.length > 16 || answer.answers.some(item => typeof item !== 'string' || item.length > 8000)) throw new HttpError(400, 'INVALID_USER_INPUT');
    }
    return value;
  }
  throw new HttpError(400, 'REQUEST_METHOD_UNSUPPORTED');
}
