import { appendFileSync, existsSync, lstatSync, mkdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isWithin } from './config.js';
import { checkoutRoot } from './launcher.js';

export type DiagnosticComponent = 'server' | 'http' | 'codex' | 'network';
export interface DiagnosticInput {
  code: string;
  component: DiagnosticComponent;
  operation?: string;
  method?: string;
  httpStatus?: number;
  rpcCode?: number;
  durationMs?: number;
  count?: number;
}
export type DiagnosticSink = (entry: DiagnosticInput) => void;
export interface DiagnosticRecord extends DiagnosticInput { time: string }

const codes = new Set([
  'REQUEST_FAILED', 'SERVICE_STARTING', 'SERVICE_STOPPING', 'SERVICE_STOPPED',
  'BOOTSTRAP_FAILED', 'STARTUP_FAILED', 'UNCAUGHT_EXCEPTION', 'UNHANDLED_REJECTION',
  'SERVICE_ALREADY_RUNNING', 'INVALID_SERVICE_LOCK', 'CODEX_UNAVAILABLE',
  'HTTP_READY', 'HTTP_LISTENER_UNAVAILABLE', 'HTTP_LISTENER_CLOSE_FAILED',
  'NETWORK_REFRESH_FAILED', 'WAITING_FOR_PRIVATE_NETWORK', 'WEBSOCKET_ERROR',
  'CODEX_STARTING', 'CODEX_READY', 'CODEX_START_FAILED', 'CODEX_EXITED', 'STOPPED',
  'CODEX_INITIALIZE_FAILED', 'CODEX_OFFLINE', 'CODEX_RPC_ERROR', 'CODEX_REQUEST_TIMEOUT',
  'CODEX_RPC_WRITE_FAILED', 'CODEX_RPC_COMPLETED', 'CODEX_RPC_FAILED', 'CODEX_TURN_FAILED',
  'INVALID_RPC_MESSAGE', 'AUTHENTICATION_REQUIRED', 'HOST_NOT_ALLOWED', 'ORIGIN_REQUIRED',
  'ORIGIN_NOT_ALLOWED', 'INVALID_INPUT', 'INVALID_PAIRING_SETTING', 'DEVICE_NAME_INVALID',
  'PAIRING_CODE_FORMAT_INVALID', 'PAIRING_CODE_INVALID_OR_EXPIRED', 'INVALID_ATTACHMENTS',
  'INVALID_REQUEST_ID', 'MESSAGE_REQUIRED', 'IMAGE_REQUIRED', 'IMAGE_TOO_LARGE',
  'UNSUPPORTED_IMAGE', 'BINARY_FILE', 'ATTACHMENT_NOT_FOUND', 'ATTACHMENT_NOT_ALLOWED',
  'PROJECT_NOT_FOUND', 'PROJECT_HAS_NO_LOCAL_ROOTS', 'PROJECT_ROOT_REQUIRED',
  'PROJECT_ROOT_UNAVAILABLE', 'PROJECT_PAGINATION_INVALID', 'THREAD_NOT_FOUND',
  'THREAD_NOT_IN_PROJECT', 'THREAD_OUTSIDE_PROJECT', 'THREAD_BUSY', 'THREAD_WRITER_CONFLICT', 'NO_ACTIVE_TURN',
  'PATH_NOT_ALLOWED', 'PATH_OUTSIDE_PROJECT', 'FILE_NOT_FOUND', 'NOT_A_FILE',
  'NOT_A_DIRECTORY', 'REQUEST_NOT_FOUND', 'REQUEST_ALREADY_RESOLVED',
  'REQUEST_ALREADY_SUBMITTED', 'REQUEST_ID_CONFLICT', 'INVALID_APPROVAL',
  'INVALID_PERMISSION_APPROVAL', 'PERMISSIONS_EXCEED_REQUEST', 'INVALID_USER_INPUT',
  'INVALID_REQUEST_RESPONSE', 'REQUEST_METHOD_UNSUPPORTED', 'ELICITATION_ACCEPTANCE_UNSUPPORTED',
  'NOT_FOUND', 'UNSUPPORTED_REASONING_EFFORT', 'DESKTOP_REVIEWER_NOT_APPLIED',
  'RECOVERY_CONFIRMATION_REQUIRED', 'RECOVERY_UNAVAILABLE', 'CODEX_RECOVERY_FAILED', 'CODEX_STOP_FAILED',
  'WORKER_UNAVAILABLE',
  'WORKER_MAINTENANCE',
  'WORKER_OFFLINE', 'WORKER_DISCONNECTED', 'WORKER_REQUEST_TIMEOUT', 'WORKER_REQUEST_FAILED',
  'WORKER_METHOD_NOT_ALLOWED', 'WORKER_PROTOCOL_MISMATCH', 'WORKER_AUTHENTICATION_FAILED',
  'WORKER_FRAME_INVALID', 'WORKER_FRAME_TOO_LARGE', 'WORKER_BACKPRESSURE', 'WORKER_BUSY',
  'WORKER_CLOSED', 'WORKER_KEY_UNAVAILABLE', 'WORKER_RUNTIME_INVALID',
]);
const operations = new Set([
  'startup', 'shutdown', 'retry', 'lock', 'listeners', 'UNKNOWN_OPERATION',
  '/api/auth', '/api/auth/pair', '/api/auth/logout', '/api/settings/pairing',
  '/api/status', '/api/recovery', '/api/projects', '/api/projects/:id/tree', '/api/projects/:id/file',
  '/api/models', '/api/threads', '/api/threads/:id', '/api/threads/:id/turns',
  '/api/threads/:id/resume', '/api/threads/:id/messages', '/api/threads/:id/interrupt',
  '/api/uploads', '/api/uploads/:id', '/api/requests', '/api/requests/:id', '/api/events',
  'initialize', 'account/read', 'project/list', 'project/read', 'thread/list',
  'thread/read', 'thread/start', 'thread/resume', 'thread/turns/list', 'thread/items/list',
  'thread/name/set', 'thread/settings/update', 'turn/start', 'turn/interrupt', 'model/list', 'thread/status/changed',
  'turn/started', 'turn/completed', 'serverRequest/resolved', 'item/started', 'item/completed',
  'item/commandExecution/requestApproval', 'item/fileChange/requestApproval',
  'item/permissions/requestApproval', 'item/tool/requestUserInput', 'mcpServer/elicitation/request',
  'error',
]);
const components = new Set(['server', 'http', 'codex', 'network']);
const methods = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

export const safeDiagnosticCode = (value: unknown): string => typeof value === 'string' && codes.has(value) ? value : 'REQUEST_FAILED';

/** Values as well as field names are allowlisted. Never stringify the supplied object. */
export function sanitizeDiagnostic(input: DiagnosticInput): DiagnosticRecord {
  const record: DiagnosticRecord = {
    time: new Date().toISOString(),
    code: safeDiagnosticCode(input.code),
    component: components.has(input.component) ? input.component : 'server',
    operation: typeof input.operation === 'string' && operations.has(input.operation) ? input.operation : 'UNKNOWN_OPERATION',
  };
  if (typeof input.method === 'string' && methods.has(input.method)) record.method = input.method;
  if (Number.isInteger(input.httpStatus) && input.httpStatus! >= 100 && input.httpStatus! <= 599) record.httpStatus = input.httpStatus;
  if (Number.isInteger(input.rpcCode) && input.rpcCode! >= -2_147_483_648 && input.rpcCode! <= 2_147_483_647) record.rpcCode = input.rpcCode;
  if (typeof input.durationMs === 'number' && Number.isFinite(input.durationMs) && input.durationMs >= 0) record.durationMs = Math.round(Math.min(input.durationMs, 86_400_000) * 100) / 100;
  if (Number.isSafeInteger(input.count) && input.count! >= 0 && input.count! <= 1_000_000_000) record.count = input.count;
  return record;
}

interface LoggerOptions { maxBytes?: number; maxFiles?: number }
const defaultDataDir = () => process.env.POCKETAGENT_DATA_DIR || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'), 'PocketAgent');

/** One service process serializes writes synchronously. Disk failures never escape into a task. */
export function createDiagnosticLogger(dataDir = defaultDataDir(), options: LoggerOptions = {}): DiagnosticSink {
  const maxBytes = Number.isInteger(options.maxBytes) && options.maxBytes! >= 512 && options.maxBytes! <= 16 * 1024 * 1024 ? options.maxBytes! : 1024 * 1024;
  const maxFiles = Number.isInteger(options.maxFiles) && options.maxFiles! >= 1 && options.maxFiles! <= 10 ? options.maxFiles! : 3;
  return input => {
    try {
      const checkout = realpathSync(checkoutRoot());
      const candidate = path.resolve(dataDir);
      if (isWithin(checkout, candidate)) return;
      mkdirSync(candidate, { recursive: true, mode: 0o700 });
      const external = realpathSync(candidate);
      if (isWithin(checkout, external)) return;
      const directory = path.join(external, 'logs');
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const actualDirectory = realpathSync(directory);
      if (!isWithin(external, actualDirectory) || isWithin(checkout, actualDirectory)) return;
      const file = path.join(actualDirectory, 'diagnostics.jsonl');
      if (existsSync(file) && lstatSync(file).isSymbolicLink()) return;
      const line = JSON.stringify(sanitizeDiagnostic(input)) + '\n';
      if (existsSync(file) && statSync(file).size + Buffer.byteLength(line) > maxBytes) {
        if (maxFiles === 1) writeFileSync(file, '', { mode: 0o600 });
        else for (let index = maxFiles - 1; index >= 1; index--) {
          const previous = index === 1 ? file : `${file}.${index - 1}`;
          const destination = `${file}.${index}`;
          if (existsSync(destination)) rmSync(destination);
          if (existsSync(previous)) renameSync(previous, destination);
        }
      }
      appendFileSync(file, line, { encoding: 'utf8', mode: 0o600 });
    } catch { /* Never expose raw filesystem errors or break a Codex task. */ }
  };
}
