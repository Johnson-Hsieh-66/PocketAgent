import { EventEmitter } from 'node:events';
import { createConnection, type Socket } from 'node:net';
import type { AppEvent, PendingRequest, ServiceStatus } from '../shared/types.js';
import type { ApprovalsReviewer } from '../../.generated/codex/v2/ApprovalsReviewer.js';
import { sanitizeDiagnostic, type DiagnosticInput, type DiagnosticSink } from './diagnostics.js';
import {
  MAX_WORKER_FRAME_BYTES, MAX_WORKER_REPLAY_BYTES, WORKER_NATIVE_METHODS, WORKER_PROTOCOL_VERSION,
  readWorkerFrames, readWorkerKey, validNonce, validProof, workerEndpoint, workerFailure, workerNonce,
  workerObject, workerProof, writeWorkerFrame, type WorkerSnapshot,
} from './worker-protocol.js';

export interface WorkerClientOptions {
  dataDir: string;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
  maxFrameBytes?: number;
  diagnosticFallback?: DiagnosticSink;
}
type PendingCall = { resolve(value: any): void; reject(error: Error): void; timer: NodeJS.Timeout };

/** HTTP-facing bridge. Reconnecting synchronizes state; it never replays a call. */
export class WorkerClient extends EventEmitter {
  status: ServiceStatus = { codex: 'offline', error: 'WORKER_OFFLINE' };
  private requests: PendingRequest[] = [];
  private assignments = new Map<string, string>();
  private active = 0;
  private maintenanceActive = false;
  private boot = '';
  private socket?: Socket;
  private connection?: Promise<void>;
  private ready = false;
  private closed = false;
  private calls = new Map<number, PendingCall>();
  private nextId = 1;
  private journal: AppEvent[] = [];
  private journalBytes = 0;
  private seq = 0;
  private maxFrameBytes: number;
  constructor(private options: WorkerClientOptions) { super(); this.maxFrameBytes = options.maxFrameBytes ?? MAX_WORKER_FRAME_BYTES; }
  get connected() { return this.ready; }
  get bootGeneration() { return this.boot || undefined; }
  get activeTurnCount() { return this.active; }
  get pendingRequestCount() { return this.requests.length; }
  get maintenance() { return this.maintenanceActive; }
  get pendingRequests() { return this.requests; }
  createdThreadProject(threadId: string) { return this.assignments.get(threadId); }
  createdThreadIds(projectId: string) { return [...this.assignments].filter(([, id]) => id === projectId).map(([id]) => id); }
  eventsSince(after: number, generation?: string) {
    const reset = (!!generation && generation !== this.status.generation) || after > this.seq || (after > 0 && after < (this.journal[0]?.seq ?? this.seq + 1) - 1);
    return { events: this.journal.filter(event => event.seq > after), reset };
  }
  private emitEvent(event: AppEvent) {
    // A broken HTTP subscriber cannot take down the worker connection or peers.
    for (const listener of this.rawListeners('event')) {
      try { listener.call(this, event); } catch { /* Only curated diagnostics cross IPC. */ }
    }
  }
  private append(event: AppEvent) {
    if (event.seq <= this.seq) return;
    this.seq = event.seq;
    this.journal.push(event);
    this.journalBytes += Buffer.byteLength(JSON.stringify(event));
    while (this.journal.length > 2000 || this.journalBytes > MAX_WORKER_REPLAY_BYTES) {
      const removed = this.journal.shift();
      if (removed) this.journalBytes -= Buffer.byteLength(JSON.stringify(removed));
    }
  }
  private state(raw: unknown): WorkerSnapshot {
    const snapshot = workerObject(raw) as WorkerSnapshot;
    if (typeof snapshot.bootGeneration !== 'string' || snapshot.bootGeneration.length > 128 || !snapshot.bootGeneration.length ||
      !Number.isSafeInteger(snapshot.seq) || snapshot.seq < 0 || !Number.isSafeInteger(snapshot.firstSeq) || snapshot.firstSeq < 1 ||
      !Number.isSafeInteger(snapshot.activeTurnCount) || snapshot.activeTurnCount < 0 ||
      !Array.isArray(snapshot.pendingRequests) || !Array.isArray(snapshot.assignments) ||
      !['ready', 'starting', 'offline'].includes(snapshot.status?.codex) || typeof snapshot.status.generation !== 'string' || snapshot.status.generation.length > 200) throw new Error('WORKER_FRAME_INVALID');
    for (const pair of snapshot.assignments) if (!Array.isArray(pair) || pair.length !== 2 || pair.some(value => typeof value !== 'string' || value.length > 128)) throw new Error('WORKER_FRAME_INVALID');
    this.status = snapshot.status;
    this.requests = snapshot.pendingRequests;
    this.assignments = new Map(snapshot.assignments);
    this.active = snapshot.activeTurnCount;
    this.maintenanceActive = snapshot.maintenance === true;
    this.boot = snapshot.bootGeneration;
    return snapshot;
  }
  connect(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('WORKER_CLOSED'));
    if (this.ready) return Promise.resolve();
    if (this.connection) return this.connection;
    const result = this.open().finally(() => { if (this.connection === result) this.connection = undefined; });
    this.connection = result;
    return result;
  }
  private async open() {
    let key: Buffer;
    try { key = await readWorkerKey(this.options.dataDir); }
    catch { throw new Error('WORKER_UNAVAILABLE'); }
    if (this.closed) throw new Error('WORKER_CLOSED');
    const previousSeq = this.seq;
    const previousGeneration = this.status.generation;
    const previousBoot = this.boot;
    const socket = createConnection(workerEndpoint(this.options.dataDir));
    this.socket = socket;
    const nonce = workerNonce();
    let phase: 'challenge' | 'snapshot' | 'synchronizing' | 'ready' = 'challenge';
    let synchronized = false;
    let initialSnapshot: WorkerSnapshot | undefined;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => fail('WORKER_UNAVAILABLE'), this.options.connectTimeoutMs ?? 5000);
      timer.unref();
      const fail = (code: string) => {
        clearTimeout(timer);
        if (!synchronized) reject(new Error(code));
        socket.destroy();
      };
      socket.on('connect', () => {
        try { writeWorkerFrame(socket, { type: 'hello', version: WORKER_PROTOCOL_VERSION, nonce }, this.maxFrameBytes); }
        catch { fail('WORKER_UNAVAILABLE'); }
      });
      socket.on('error', () => fail('WORKER_UNAVAILABLE'));
      socket.on('close', () => {
        clearTimeout(timer);
        if (!synchronized) reject(new Error(this.closed ? 'WORKER_CLOSED' : 'WORKER_DISCONNECTED'));
        if (this.socket !== socket) return;
        this.socket = undefined;
        this.ready = false;
        this.requests = []; this.assignments.clear(); this.active = 0;
        for (const call of this.calls.values()) { clearTimeout(call.timer); call.reject(new Error('WORKER_DISCONNECTED')); }
        this.calls.clear();
        this.status = { ...this.status, codex: 'offline', error: 'WORKER_OFFLINE' };
        this.emitEvent({ seq: 0, method: 'pocketagent/status', params: { status: this.status } });
        this.emitEvent({ seq: 0, method: 'pocketagent/requests', params: { requests: [] } });
      });
      readWorkerFrames(socket, frame => {
        if (frame.type === 'failure') { fail(workerFailure(new Error(frame.code)).code); return; }
        if (phase === 'challenge') {
          if (frame.type !== 'challenge' || frame.version !== WORKER_PROTOCOL_VERSION) { fail('WORKER_PROTOCOL_MISMATCH'); return; }
          if (!validNonce(frame.nonce) || !validProof(frame.proof, workerProof(key, 'server', nonce, frame.nonce))) { fail('WORKER_AUTHENTICATION_FAILED'); return; }
          writeWorkerFrame(socket, { type: 'authenticate', version: WORKER_PROTOCOL_VERSION, proof: workerProof(key, 'client', nonce, frame.nonce) }, this.maxFrameBytes);
          phase = 'snapshot';
          return;
        }
        if (phase === 'snapshot') {
          if (frame.type !== 'snapshot' || frame.version !== WORKER_PROTOCOL_VERSION) { fail('WORKER_PROTOCOL_MISMATCH'); return; }
          initialSnapshot = this.state(frame.snapshot);
          this.journal = []; this.journalBytes = 0; this.seq = 0;
          phase = 'synchronizing';
          return;
        }
        if (phase === 'synchronizing' && frame.type === 'synchronized') {
          const snapshot = this.state(frame.snapshot);
          this.seq = Math.max(this.seq, snapshot.seq);
          clearTimeout(timer); phase = 'ready'; synchronized = true; this.ready = true;
          const reset = previousBoot && (previousBoot !== snapshot.bootGeneration || previousGeneration !== snapshot.status.generation || previousSeq > snapshot.seq || previousSeq > 0 && previousSeq < snapshot.firstSeq - 1);
          if (reset) this.emitEvent({ seq: 0, method: 'pocketagent/reset', params: {} });
          else for (const event of this.journal) if (event.seq > previousSeq) this.emitEvent(event);
          this.emitEvent({ seq: 0, method: 'pocketagent/status', params: { status: this.status } });
          this.emitEvent({ seq: 0, method: 'pocketagent/requests', params: { requests: this.requests } });
          resolve();
          return;
        }
        if (frame.type === 'event' && (phase === 'synchronizing' || phase === 'ready')) {
          const event = workerObject(frame.event) as AppEvent;
          if (frame.bootGeneration !== this.boot || !Number.isSafeInteger(event.seq) || event.seq < 1 || typeof event.method !== 'string') { fail('WORKER_FRAME_INVALID'); return; }
          workerObject(event.params);
          if (phase === 'ready' && event.method === 'pocketagent/status') {
            const incoming = workerObject(event.params.status) as ServiceStatus;
            if (incoming.generation !== this.status.generation) {
              this.journal = []; this.journalBytes = 0; this.seq = 0;
              this.emitEvent({ seq: 0, method: 'pocketagent/reset', params: {} });
            }
            this.status = incoming;
          }
          if (phase === 'ready' && event.method === 'pocketagent/requests') this.requests = Array.isArray(event.params.requests) ? event.params.requests as PendingRequest[] : [];
          const fresh = event.seq > this.seq;
          this.append(event);
          if (phase === 'ready' && fresh) this.emitEvent(event);
          return;
        }
        if (phase === 'ready' && frame.type === 'state') { this.state(frame.snapshot); return; }
        if (phase === 'ready' && frame.type === 'reply') {
          const pending = this.calls.get(frame.id);
          if (!pending) return;
          clearTimeout(pending.timer); this.calls.delete(frame.id);
          if (frame.error) {
            const failure = workerFailure(Object.assign(new Error(String(frame.error.code)), { rpcCode: frame.error.rpcCode }));
            pending.reject(Object.assign(new Error(failure.code), failure.rpcCode === undefined ? {} : { rpcCode: failure.rpcCode }));
          } else pending.resolve(frame.result);
          return;
        }
        fail('WORKER_FRAME_INVALID');
      }, fail, this.maxFrameBytes);
    });
    if (!initialSnapshot) throw new Error('WORKER_FRAME_INVALID');
  }
  private call(operation: string, params: Record<string, unknown>, timeoutMs = this.options.requestTimeoutMs ?? 55_000): Promise<any> {
    if (!this.ready || !this.socket || this.closed) return Promise.reject(new Error('CODEX_OFFLINE'));
    if (this.calls.size >= 64) return Promise.reject(new Error('WORKER_BUSY'));
    const socket = this.socket;
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.calls.delete(id); reject(new Error('WORKER_REQUEST_TIMEOUT')); }, timeoutMs);
      timer.unref();
      this.calls.set(id, { resolve, reject, timer });
      try { writeWorkerFrame(socket, { type: 'call', id, operation, params }, this.maxFrameBytes); }
      catch (error) { clearTimeout(timer); this.calls.delete(id); reject(new Error(workerFailure(error).code)); }
    });
  }
  request(method: string, params: any = {}) {
    if (!WORKER_NATIVE_METHODS.has(method)) return Promise.reject(new Error('WORKER_METHOD_NOT_ALLOWED'));
    return this.call('request', { method, params });
  }
  startTurn(threadId: string, params: any, requestId: string, reviewer?: ApprovalsReviewer) {
    return this.call('startTurn', { threadId, params, requestId, ...(reviewer ? { reviewer } : {}) });
  }
  interrupt(threadId: string) { return this.call('interrupt', { threadId }); }
  respond(id: string | number, result: any): Promise<void> { return this.call('respond', { id, result }); }
  recover(): Promise<void> { return this.call('recover', {}, 125_000); }
  beginMaintenanceIfIdle(): Promise<boolean> { return this.call('beginMaintenanceIfIdle', {}); }
  endMaintenance(): Promise<void> { return this.call('endMaintenance', {}); }
  diagnostic = (entry: DiagnosticInput): void => {
    const safe = sanitizeDiagnostic(entry);
    if (!this.ready) { try { this.options.diagnosticFallback?.(safe); } catch { /* best effort */ } return; }
    void this.call('diagnostic', safe as unknown as Record<string, unknown>, 5000).catch(() => {});
  };
  close() {
    this.closed = true;
    this.ready = false;
    this.socket?.destroy();
  }
}
