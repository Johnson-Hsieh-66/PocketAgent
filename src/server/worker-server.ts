import { createServer, type Server, type Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import type { AppEvent, ServiceStatus } from '../shared/types.js';
import { validateRequestResult } from './auth.js';
import { sanitizeDiagnostic, type DiagnosticInput, type DiagnosticSink } from './diagnostics.js';
import {
  MAX_WORKER_FRAME_BYTES, MAX_WORKER_REPLAY_BYTES, WORKER_NATIVE_METHODS, WORKER_PROTOCOL_VERSION,
  readWorkerFrames, readWorkerKey, validNonce, validProof, workerEndpoint, workerFailure, workerNonce,
  workerObject, workerProof, workerString, writeWorkerFrame, type WorkerBridge, type WorkerSnapshot,
} from './worker-protocol.js';

export interface WorkerServerOptions {
  dataDir: string;
  bridge: WorkerBridge;
  diagnostic?: DiagnosticSink;
  handshakeTimeoutMs?: number;
  requestTimeoutMs?: number;
  maxFrameBytes?: number;
  maintenanceTtlMs?: number;
}

/** Owns only local IPC connections. Closing a gateway never stops the Codex bridge. */
export class WorkerServer {
  readonly bootGeneration = randomUUID();
  readonly endpoint: string;
  private server?: Server;
  private clients = new Map<Socket, { authorized: boolean }>();
  private starting?: Promise<void>;
  private closed = false;
  private key?: Buffer;
  private nativeGeneration?: string;
  private generationStartSeq = 0;
  private maxFrameBytes: number;
  private nativeInFlight = 0;
  private maintenanceUntil = 0;
  constructor(private options: WorkerServerOptions) {
    this.endpoint = workerEndpoint(options.dataDir);
    this.maxFrameBytes = options.maxFrameBytes ?? MAX_WORKER_FRAME_BYTES;
    this.nativeGeneration = options.bridge.status.generation;
    for (const event of options.bridge.eventsSince(0).events) {
      if (event.method === 'pocketagent/status' && workerObject(event.params.status).generation !== this.nativeGeneration) this.generationStartSeq = event.seq + 1;
    }
  }
  get status(): ServiceStatus {
    return { ...this.options.bridge.status, generation: `${this.bootGeneration}:${this.options.bridge.status.generation ?? 'initial'}` };
  }
  get maintenance() { return this.maintenanceUntil > Date.now(); }
  private event(event: AppEvent): AppEvent {
    if (event.method !== 'pocketagent/status') return event;
    const status = workerObject(event.params.status);
    return { ...event, params: { ...event.params, status: { ...status, generation: `${this.bootGeneration}:${status.generation ?? 'initial'}` } } };
  }
  private replay(): AppEvent[] {
    const source = this.options.bridge.eventsSince(0).events;
    const events: AppEvent[] = [];
    let bytes = 0;
    for (let index = source.length - 1; index >= 0; index--) {
      if (source[index].seq < this.generationStartSeq) break;
      const event = this.event(source[index]);
      const size = Buffer.byteLength(JSON.stringify(event));
      if (bytes + size > Math.min(MAX_WORKER_REPLAY_BYTES, this.maxFrameBytes)) break;
      bytes += size;
      events.push(event);
    }
    return events.reverse();
  }
  private snapshot(events?: AppEvent[]): WorkerSnapshot {
    const bridge = this.options.bridge;
    const all = bridge.eventsSince(0).events;
    const seq = all.at(-1)?.seq ?? 0;
    return {
      bootGeneration: this.bootGeneration, status: this.status,
      pendingRequests: bridge.pendingRequests, assignments: bridge.createdThreadAssignments?.() ?? [],
      activeTurnCount: bridge.activeTurnCount ?? 0, pendingRequestCount: bridge.pendingRequests.length,
      seq, firstSeq: events ? events[0]?.seq ?? seq + 1 : Math.max(all[0]?.seq ?? seq + 1, this.generationStartSeq),
      maintenance: this.maintenanceUntil > Date.now(),
    };
  }
  private send(socket: Socket, value: unknown) {
    try { writeWorkerFrame(socket, value, this.maxFrameBytes); }
    catch { socket.destroy(); }
  }
  private broadcastState() {
    const state = { type: 'state', snapshot: this.snapshot() };
    for (const [socket, client] of this.clients) if (client.authorized) this.send(socket, state);
  }
  private onEvent = (event: AppEvent) => {
    const generation = this.options.bridge.status.generation;
    if (generation !== this.nativeGeneration) {
      this.nativeGeneration = generation;
      this.generationStartSeq = event.seq;
    }
    const outgoing = { type: 'event', bootGeneration: this.bootGeneration, event: this.event(event) };
    for (const [socket, client] of this.clients) if (client.authorized) this.send(socket, outgoing);
    if (['pocketagent/status', 'pocketagent/requests', 'thread/closed', 'turn/started', 'turn/completed', 'thread/status/changed'].includes(event.method)) this.broadcastState();
  };
  start(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('WORKER_CLOSED'));
    if (this.starting) return this.starting;
    if (this.server?.listening) return Promise.resolve();
    const result = this.listen().finally(() => { if (this.starting === result) this.starting = undefined; });
    this.starting = result;
    return result;
  }
  private async listen() {
    this.key = await readWorkerKey(this.options.dataDir, true);
    const server = createServer(socket => this.accept(socket));
    server.maxConnections = 16;
    this.server = server;
    server.on('error', () => { /* Listen errors are fixed below; no raw diagnostics. */ });
    await new Promise<void>((resolve, reject) => {
      const error = () => reject(new Error('WORKER_UNAVAILABLE'));
      server.once('error', error);
      server.listen({ path: this.endpoint, readableAll: false, writableAll: false }, () => { server.off('error', error); resolve(); });
    });
    this.options.bridge.on('event', this.onEvent);
  }
  private accept(socket: Socket) {
    const client = { authorized: false };
    this.clients.set(socket, client);
    let phase: 'hello' | 'authenticate' | 'ready' = 'hello';
    let clientNonce = '';
    const serverNonce = workerNonce();
    const inFlight = new Set<number>();
    let failed = false;
    const fail = (code: string) => {
      failed = true;
      if (!socket.destroyed) { this.send(socket, { type: 'failure', code }); socket.end(); socket.destroySoon(); }
    };
    const timer = setTimeout(() => { fail('WORKER_AUTHENTICATION_FAILED'); socket.destroy(); }, this.options.handshakeTimeoutMs ?? 5000);
    timer.unref();
    socket.on('error', () => { /* A failed client cannot affect other clients or an active turn. */ });
    socket.on('close', () => { clearTimeout(timer); this.clients.delete(socket); });
    readWorkerFrames(socket, frame => {
      if (failed) return;
      if (phase === 'hello') {
        if (frame.type !== 'hello' || frame.version !== WORKER_PROTOCOL_VERSION) { fail('WORKER_PROTOCOL_MISMATCH'); return; }
        if (!validNonce(frame.nonce)) { fail('WORKER_AUTHENTICATION_FAILED'); return; }
        clientNonce = frame.nonce;
        phase = 'authenticate';
        this.send(socket, { type: 'challenge', version: WORKER_PROTOCOL_VERSION, nonce: serverNonce, proof: workerProof(this.key!, 'server', clientNonce, serverNonce) });
        return;
      }
      if (phase === 'authenticate') {
        if (frame.type !== 'authenticate' || frame.version !== WORKER_PROTOCOL_VERSION || !validProof(frame.proof, workerProof(this.key!, 'client', clientNonce, serverNonce))) { fail('WORKER_AUTHENTICATION_FAILED'); return; }
        clearTimeout(timer);
        phase = 'ready'; client.authorized = true;
        const events = this.replay();
        this.send(socket, { type: 'snapshot', version: WORKER_PROTOCOL_VERSION, snapshot: this.snapshot(events) });
        for (const event of events) this.send(socket, { type: 'event', bootGeneration: this.bootGeneration, event });
        this.send(socket, { type: 'synchronized', snapshot: this.snapshot(events) });
        return;
      }
      if (frame.type !== 'call' || !Number.isSafeInteger(frame.id) || frame.id < 1 || inFlight.has(frame.id)) { fail('WORKER_FRAME_INVALID'); return; }
      if (inFlight.size >= 64) { this.send(socket, { type: 'reply', id: frame.id, error: { code: 'WORKER_BUSY' } }); return; }
      inFlight.add(frame.id);
      void this.call(frame.operation, frame.params).then(result => {
        if (socket.destroyed) return;
        // Flush transient assignments before acknowledging operations that create/read them.
        this.broadcastState();
        try { writeWorkerFrame(socket, { type: 'reply', id: frame.id, result }, this.maxFrameBytes); }
        catch (error) { this.send(socket, { type: 'reply', id: frame.id, error: workerFailure(error) }); }
      }, error => this.send(socket, { type: 'reply', id: frame.id, error: workerFailure(error) })).finally(() => { inFlight.delete(frame.id); });
    }, fail, this.maxFrameBytes);
  }
  private async call(operation: unknown, raw: unknown): Promise<unknown> {
    const params = workerObject(raw);
    const bridge = this.options.bridge;
    if (operation === 'beginMaintenanceIfIdle') {
      // This check and claim contain no await. A competing turn or updater can
      // only run before the claim or observe its mutation gate afterwards.
      if (this.maintenance || this.nativeInFlight || bridge.pendingRpcCount || bridge.activeTurnCount || bridge.pendingRequests.length) return false;
      this.maintenanceUntil = Date.now() + (this.options.maintenanceTtlMs ?? 120_000);
      return true;
    }
    if (operation === 'endMaintenance') { this.maintenanceUntil = 0; return {}; }
    if (operation === 'diagnostic') {
      try { this.options.diagnostic?.(sanitizeDiagnostic(params as DiagnosticInput)); } catch { /* Diagnostics are best effort. */ }
      return {};
    }
    if (!['request', 'startTurn', 'interrupt', 'recover', 'respond'].includes(String(operation))) throw new Error('WORKER_METHOD_NOT_ALLOWED');
    const nativeMethod = operation === 'request' ? workerString(params.method, 100) : '';
    if (operation === 'request' && !WORKER_NATIVE_METHODS.has(nativeMethod)) throw new Error('WORKER_METHOD_NOT_ALLOWED');
    const readOnly = operation === 'request' && ['project/list', 'project/read', 'model/list', 'thread/list', 'thread/read', 'thread/turns/list'].includes(nativeMethod);
    if (this.maintenanceUntil > Date.now() && !readOnly) throw new Error('WORKER_MAINTENANCE');
    let result: Promise<unknown>;
    this.nativeInFlight++;
    try {
    switch (operation) {
      case 'request': {
        result = bridge.request(nativeMethod, workerObject(params.params ?? {}));
        break;
      }
      case 'startTurn': {
        const turn = workerObject(params.params);
        if (Object.keys(turn).some(key => !['input', 'model', 'effort'].includes(key))) throw new Error('INVALID_INPUT');
        if (params.reviewer !== undefined && !['user', 'auto_review', 'guardian_subagent'].includes(params.reviewer)) throw new Error('INVALID_INPUT');
        const requestId = workerString(params.requestId);
        if (requestId.length < 8) throw new Error('INVALID_REQUEST_ID');
        result = bridge.startTurn(workerString(params.threadId), turn, requestId, params.reviewer);
        break;
      }
      case 'interrupt': result = bridge.interrupt(workerString(params.threadId)); break;
      case 'recover': result = bridge.recover(); break;
      case 'respond': {
        if ((typeof params.id !== 'string' && typeof params.id !== 'number') || String(params.id).length > 128) throw new Error('INVALID_INPUT');
        const pending = bridge.pendingRequests.find(request => String(request.id) === String(params.id));
        if (!pending) throw new Error('REQUEST_ALREADY_RESOLVED');
        result = Promise.resolve(bridge.respond(pending.id, validateRequestResult(pending, params.result)));
        break;
      }
      default: throw new Error('WORKER_METHOD_NOT_ALLOWED');
    }
    } catch (error) { this.nativeInFlight--; throw error; }
    // Keep the claim busy until the native operation actually settles, even
    // when a gateway disappears or its bounded reply deadline expires first.
    void result.then(() => { this.nativeInFlight--; }, () => { this.nativeInFlight--; });
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([result, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('WORKER_REQUEST_TIMEOUT')), operation === 'recover' ? 120_000 : this.options.requestTimeoutMs ?? 50_000);
        timer.unref();
      })]);
    } finally { if (timer) clearTimeout(timer); }
  }
  async close() {
    this.closed = true;
    await this.starting?.catch(() => {});
    this.options.bridge.off('event', this.onEvent);
    for (const socket of this.clients.keys()) socket.destroy();
    if (this.server?.listening) await new Promise<void>(resolve => this.server!.close(() => resolve()));
  }
}

export const createWorkerServer = (options: WorkerServerOptions) => new WorkerServer(options);
