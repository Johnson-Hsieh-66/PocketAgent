import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { Socket } from 'node:net';
import type { AppEvent, PendingRequest, ServiceStatus } from '../shared/types.js';
import type { ApprovalsReviewer } from '../../.generated/codex/v2/ApprovalsReviewer.js';
import { isWithin } from './config.js';
import { checkoutRoot } from './launcher.js';
import { safeDiagnosticCode } from './diagnostics.js';

export const WORKER_PROTOCOL_VERSION = 1;
export const MAX_WORKER_FRAME_BYTES = 8 * 1024 * 1024;
export const MAX_WORKER_REPLAY_BYTES = 4 * 1024 * 1024;
export const WORKER_NATIVE_METHODS = new Set([
  'project/list', 'project/read', 'model/list', 'thread/list', 'thread/read',
  'thread/start', 'thread/resume', 'thread/turns/list', 'thread/name/set', 'thread/settings/update',
]);

export interface WorkerBridge {
  status: ServiceStatus;
  pendingRequests: PendingRequest[];
  readonly activeTurnCount?: number;
  readonly pendingRpcCount?: number;
  createdThreadAssignments?(): [string, string][];
  createdThreadProject?(threadId: string): string | undefined;
  createdThreadIds?(projectId: string): string[];
  eventsSince(seq: number): { events: AppEvent[]; reset: boolean };
  on(event: 'event', handler: (event: AppEvent) => void): unknown;
  off(event: 'event', handler: (event: AppEvent) => void): unknown;
  request(method: string, params?: any): Promise<any>;
  startTurn(threadId: string, params: any, requestId: string, reviewer?: ApprovalsReviewer): Promise<any>;
  respond(id: string | number, result: any): void | Promise<void>;
  interrupt(threadId: string): Promise<any>;
  recover(): Promise<void>;
}

export interface WorkerSnapshot {
  bootGeneration: string;
  status: ServiceStatus;
  pendingRequests: PendingRequest[];
  assignments: [string, string][];
  activeTurnCount: number;
  pendingRequestCount: number;
  seq: number;
  firstSeq: number;
  maintenance: boolean;
}

export function workerEndpoint(dataDir: string): string {
  if (process.platform !== 'win32') return path.join(path.resolve(dataDir), 'worker.sock');
  const identity = createHash('sha256').update(path.resolve(dataDir).toLowerCase()).digest('hex').slice(0, 24);
  return `\\\\.\\pipe\\pocketagent-worker-${identity}`;
}

/** This key authenticates only local IPC. It never contains Codex credentials. */
export async function readWorkerKey(dataDir: string, create = false): Promise<Buffer> {
  const root = await realpath(checkoutRoot());
  const candidate = path.resolve(dataDir);
  if (isWithin(root, candidate)) throw new Error('WORKER_RUNTIME_INVALID');
  if (create) await mkdir(candidate, { recursive: true, mode: 0o700 });
  const actual = await realpath(candidate);
  if (isWithin(root, actual)) throw new Error('WORKER_RUNTIME_INVALID');
  const file = path.join(actual, 'worker.key');
  if (create) {
    let handle;
    try {
      handle = await open(file, 'wx', 0o600);
      await handle.writeFile(randomBytes(32));
    } catch (error: any) { if (error.code !== 'EEXIST') throw new Error('WORKER_KEY_UNAVAILABLE'); }
    finally { await handle?.close(); }
  }
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== 32) throw new Error('WORKER_KEY_UNAVAILABLE');
  const key = await readFile(file);
  if (key.length !== 32) throw new Error('WORKER_KEY_UNAVAILABLE');
  return key;
}

export const workerNonce = () => randomBytes(32).toString('hex');
export const validNonce = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export function workerProof(key: Buffer, role: 'client' | 'server', clientNonce: string, serverNonce: string): string {
  return createHmac('sha256', key).update(`${role}\0${WORKER_PROTOCOL_VERSION}\0${clientNonce}\0${serverNonce}`).digest('hex');
}
export function validProof(value: unknown, expected: string): boolean {
  return validNonce(value) && timingSafeEqual(Buffer.from(value, 'hex'), Buffer.from(expected, 'hex'));
}
export function workerObject(value: unknown): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('WORKER_FRAME_INVALID');
  return value as Record<string, any>;
}
export function workerString(value: unknown, max = 128): string {
  if (typeof value !== 'string' || !value.length || value.length > max) throw new Error('INVALID_INPUT');
  return value;
}

const workerCodes = new Set([
  'WORKER_OFFLINE', 'WORKER_DISCONNECTED', 'WORKER_REQUEST_TIMEOUT', 'WORKER_REQUEST_FAILED',
  'WORKER_METHOD_NOT_ALLOWED', 'WORKER_PROTOCOL_MISMATCH', 'WORKER_AUTHENTICATION_FAILED',
  'WORKER_FRAME_INVALID', 'WORKER_FRAME_TOO_LARGE', 'WORKER_BACKPRESSURE', 'WORKER_BUSY',
  'WORKER_UNAVAILABLE', 'WORKER_CLOSED', 'WORKER_KEY_UNAVAILABLE', 'WORKER_RUNTIME_INVALID', 'WORKER_MAINTENANCE',
]);
export function workerFailure(error: unknown): { code: string; rpcCode?: number } {
  const message = error instanceof Error ? error.message : '';
  const code = workerCodes.has(message) ? message : safeDiagnosticCode(message) !== 'REQUEST_FAILED' || message === 'REQUEST_FAILED' ? safeDiagnosticCode(message) : 'WORKER_REQUEST_FAILED';
  const rpcCode = error && typeof error === 'object' && 'rpcCode' in error && Number.isInteger(error.rpcCode) ? error.rpcCode as number : undefined;
  return { code, ...(rpcCode === undefined ? {} : { rpcCode }) };
}

export function writeWorkerFrame(socket: Socket, value: unknown, maxBytes = MAX_WORKER_FRAME_BYTES): void {
  const frame = Buffer.from(JSON.stringify(value) + '\n');
  if (frame.length > maxBytes) throw new Error('WORKER_FRAME_TOO_LARGE');
  if (socket.destroyed || !socket.writable) throw new Error('WORKER_DISCONNECTED');
  if (socket.writableLength + frame.length > maxBytes * 2) throw new Error('WORKER_BACKPRESSURE');
  socket.write(frame);
}

/** Frame limits apply before decoding; a missing newline cannot grow memory indefinitely. */
export function readWorkerFrames(socket: Socket, receive: (frame: Record<string, any>) => void, fail: (code: string) => void, maxBytes = MAX_WORKER_FRAME_BYTES): void {
  let pending = Buffer.alloc(0);
  socket.on('data', chunk => {
    if (socket.destroyed) return;
    pending = Buffer.concat([pending, chunk]);
    for (;;) {
      const end = pending.indexOf(10);
      if (end < 0) break;
      if (end + 1 > maxBytes) { fail('WORKER_FRAME_TOO_LARGE'); return; }
      const line = pending.subarray(0, end);
      pending = pending.subarray(end + 1);
      try { receive(workerObject(JSON.parse(line.toString('utf8')))); }
      catch { fail('WORKER_FRAME_INVALID'); return; }
      if (socket.destroyed) return;
    }
    if (pending.length >= maxBytes) fail('WORKER_FRAME_TOO_LARGE');
  });
}
