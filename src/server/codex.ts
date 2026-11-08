import { EventEmitter } from 'node:events';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createHash, randomUUID } from 'node:crypto';
import type { AppEvent, PendingRequest, ServiceStatus } from '../shared/types.js';
import type { ClientRequest } from '../../.generated/codex/ClientRequest.js';
import type { InitializeParams } from '../../.generated/codex/InitializeParams.js';
import type { ApprovalsReviewer } from '../../.generated/codex/v2/ApprovalsReviewer.js';
import { sanitizeDiagnostic, type DiagnosticInput, type DiagnosticSink } from './diagnostics.js';

export interface CodexCommand { command: string; args: string[] }
export interface SubmissionLedger {
  readSubmission(id: string): { threadId: string; fingerprint: string } | null;
  recordSubmission(id: string, threadId: string, fingerprint: string): void;
  forgetSubmission(id: string): void;
}
export class CodexRpcError extends Error {
  constructor(message: 'CODEX_RPC_ERROR' | 'THREAD_WRITER_CONFLICT', public readonly rpcCode?: number) { super(message); this.name = 'CodexRpcError'; }
}
type RpcPending = { method: string; threadId?: string; createdProjectId?: string; startedAt: number; resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };
export class CodexBridge extends EventEmitter {
  status: ServiceStatus = { codex: 'offline' };
  private child?: ChildProcessWithoutNullStreams;
  private rpc = new Map<number, RpcPending>();
  private nextId = 1;
  private seq = 0;
  private journal: AppEvent[] = [];
  private requests = new Map<string, PendingRequest>();
  private active = new Map<string, string>();
  private starting = new Map<string, object>();
  private sends = new Map<string, { threadId: string; fingerprint: string; result: Promise<any> }>();
  private createdProjects = new Map<string, string>();
  private stopping = false;
  private startPromise?: Promise<void>;
  private stopPromise?: Promise<void>;
  private recoveryPromise?: Promise<void>;
  private lifecycle = 0;
  private generation = randomUUID();
  get pendingRequests() { return [...this.requests.values()]; }
  get activeTurnCount() { return this.active.size; }
  get pendingRpcCount() { return this.rpc.size; }
  createdThreadAssignments(): [string, string][] { return [...this.createdProjects]; }
  createdThreadProject(threadId: string) { return this.createdProjects.get(threadId); }
  createdThreadIds(projectId: string) { return [...this.createdProjects].filter(([, id]) => id === projectId).map(([id]) => id); }
  constructor(private executable: CodexCommand, private ledger?: SubmissionLedger, private diagnostic?: DiagnosticSink) { super(); }
  private report(entry: Omit<DiagnosticInput, 'component'>) {
    try { this.diagnostic?.(sanitizeDiagnostic({ component: 'codex', ...entry })); } catch { /* Diagnostics never affect agent work. */ }
  }
  publish(method: string, params: Record<string, unknown> = {}) {
    const event: AppEvent = { seq: ++this.seq, method, params };
    this.journal.push(event);
    if (this.journal.length > 2000) this.journal.shift();
    this.emit('event', event);
    return event;
  }
  eventsSince(after: number) {
    return { events: this.journal.filter(e => e.seq > after), reset: after > this.seq || (after > 0 && after < (this.journal[0]?.seq ?? 1) - 1) };
  }
  private setStatus(status: ServiceStatus) {
    status = { ...status, generation: this.generation };
    this.status = status;
    this.report({ code: status.codex === 'starting' ? 'CODEX_STARTING' : status.codex === 'ready' ? 'CODEX_READY' : status.error || 'CODEX_OFFLINE' });
    this.publish('pocketagent/status', { status });
  }
  start(): Promise<void> {
    if (this.recoveryPromise) return this.recoveryPromise;
    return this.beginStart();
  }
  private beginStart(): Promise<void> {
    if (this.stopPromise) return Promise.reject(new Error('CODEX_OFFLINE'));
    if (this.startPromise) return this.startPromise;
    if (this.child) return this.status.codex === 'ready' && !this.stopping ? Promise.resolve() : Promise.reject(new Error('CODEX_OFFLINE'));
    this.stopping = false;
    const result = Promise.resolve().then(() => this.launchChild()).finally(() => {
      if (this.startPromise === result) this.startPromise = undefined;
    });
    this.startPromise = result;
    return result;
  }
  private async launchChild() {
    if (this.stopping) throw new Error('CODEX_OFFLINE');
    this.generation = randomUUID();
    this.setStatus({ codex: 'starting' });
    const child = spawn(this.executable.command, [...this.executable.args, 'app-server', '--listen', 'stdio://'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false });
    this.child = child;
    child.stdin.on('error', () => { /* Process lifecycle reports failures without raw diagnostics. */ });
    child.stderr.resume(); // Never forward possibly sensitive CLI diagnostics to logs.
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on('line', line => {
      if (this.child !== child || this.stopping) return;
      try { this.receive(JSON.parse(line)); } catch { this.report({ code: 'INVALID_RPC_MESSAGE' }); this.publish('pocketagent/protocolError', { code: 'INVALID_RPC_MESSAGE' }); }
    });
    child.on('error', () => {
      lines.close();
      if (this.child !== child) return;
      this.stopping = true;
      if (!child.pid || this.hasExited(child)) this.child = undefined;
      this.disconnected('CODEX_START_FAILED');
    });
    child.on('exit', () => {
      lines.close();
      if (this.child !== child) return;
      this.child = undefined;
      this.disconnected(this.stopping ? 'STOPPED' : 'CODEX_EXITED');
    });
    try {
      const init: InitializeParams = { clientInfo: { name: 'pocketagent', title: 'PocketAgent', version: '0.1.0' }, capabilities: { experimentalApi: true, requestAttestation: false } };
      const result = await this.request('initialize', init);
      this.write({ method: 'initialized', params: {} });
      let authenticated = false;
      try { const account = await this.request('account/read', {}); authenticated = !!account.account; } catch { /* status remains explicit */ }
      if (this.child !== child || this.stopping || this.hasExited(child)) throw new Error('CODEX_EXITED');
      this.setStatus({ codex: 'ready', authenticated, version: typeof result?.userAgent === 'string' ? result.userAgent.match(/\d+\.\d+\.\d+/)?.[0] : undefined });
    } catch {
      if (this.child === child) await this.stopOwnedChild();
      // A retired child must never change the status of its replacement.
      if (this.child && this.child !== child) throw new Error('CODEX_OFFLINE');
      this.setStatus({ codex: 'offline', error: 'CODEX_INITIALIZE_FAILED' });
      throw new Error('CODEX_INITIALIZE_FAILED');
    }
  }
  private disconnected(code: string) {
    this.starting.clear();
    for (const p of this.rpc.values()) { clearTimeout(p.timer); p.reject(new Error(code)); }
    this.rpc.clear();
    for (const [threadId, turnId] of this.active) this.publish('pocketagent/interrupted', { threadId, ...(turnId === 'starting' || turnId === 'external-active' ? {} : { turnId }), code });
    this.active.clear(); this.requests.clear(); this.createdProjects.clear();
    this.publish('pocketagent/requests', { requests: [] });
    this.setStatus({ codex: 'offline', error: code });
  }
  private write(message: object) {
    if (this.stopping || !this.child?.stdin.writable) throw new Error('CODEX_OFFLINE');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }
  private hasPendingStart(threadId: string) {
    return [...this.rpc.values()].some(pending => pending.method === 'turn/start' && pending.threadId === threadId);
  }
  request(method: ClientRequest['method'] | string, params: any = {}): Promise<any> {
    if (this.stopping || (this.status.codex !== 'ready' && !['initialize', 'account/read'].includes(method))) return Promise.reject(new Error('CODEX_OFFLINE'));
    const id = this.nextId++;
    const startedAt = performance.now();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.rpc.delete(id); this.report({ code: 'CODEX_REQUEST_TIMEOUT', operation: method, durationMs: Math.round(performance.now() - startedAt) }); reject(new Error('CODEX_REQUEST_TIMEOUT')); }, 45_000);
      timer.unref();
      this.rpc.set(id, { method, threadId: typeof params.threadId === 'string' ? params.threadId : undefined, createdProjectId: method === 'thread/start' && typeof params.projectId === 'string' ? params.projectId : undefined, startedAt, resolve, reject, timer });
      try { this.write({ id, method, params }); } catch (error) {
        clearTimeout(timer); this.rpc.delete(id);
        this.report({ code: error instanceof Error && error.message === 'CODEX_OFFLINE' ? 'CODEX_OFFLINE' : 'CODEX_RPC_WRITE_FAILED', operation: method, durationMs: Math.round(performance.now() - startedAt) });
        reject(error);
      }
    });
  }
  private receive(message: any) {
    if (message.id !== undefined && !message.method) {
      const pending = this.rpc.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer); this.rpc.delete(message.id);
      if (message.error) {
        const rpcCode = Number.isInteger(message.error.code) ? message.error.code : undefined;
        const conflict = rpcCode === -32600 && typeof message.error.message === 'string' && /^thread\s+\S+\s+already has an active writer\.?$/i.test(message.error.message.trim());
        const code = conflict ? 'THREAD_WRITER_CONFLICT' : 'CODEX_RPC_ERROR';
        const err = new CodexRpcError(code, rpcCode);
        this.report({ code, operation: pending.method, rpcCode, durationMs: Math.round(performance.now() - pending.startedAt) });
        pending.reject(err);
      }
      else {
        if (['thread/read', 'thread/resume', 'thread/start'].includes(pending.method)) {
          const thread = message.result?.thread;
          const timedOutStart = thread?.id && this.active.get(thread.id) === 'starting' && !this.hasPendingStart(thread.id);
          if (thread?.id && thread.status?.type === 'active' && (!this.active.has(thread.id) || timedOutStart)) {
            const running = thread.turns?.find((turn: any) => turn.status === 'inProgress');
            this.active.set(thread.id, running?.id ?? 'external-active');
          } else if (thread?.id && ((this.active.get(thread.id) === 'external-active' && thread.status?.type !== 'active') || (timedOutStart && thread.status?.type === 'idle'))) this.active.delete(thread.id);
        }
        const created = message.result?.thread;
        if (pending.method === 'thread/start' && pending.createdProjectId && typeof created?.id === 'string' && created.projectId === pending.createdProjectId) {
          if (this.createdProjects.size >= 1000) this.createdProjects.delete(this.createdProjects.keys().next().value!);
          this.createdProjects.set(created.id, pending.createdProjectId);
        }
        if (pending.method === 'thread/read' && created?.projectId && this.createdProjects.get(created.id) === created.projectId) this.createdProjects.delete(created.id);
        pending.resolve(message.result);
      }
      return;
    }
    if (typeof message.method !== 'string') return;
    const params = message.params ?? {};
    if (message.method === 'thread/closed') {
      this.createdProjects.delete(params.threadId);
      this.starting.delete(params.threadId);
      const turnId = this.active.get(params.threadId);
      this.active.delete(params.threadId);
      for (const [id, req] of this.requests) if (req.params.threadId === params.threadId) this.requests.delete(id);
      if (turnId) this.publish('pocketagent/interrupted', { threadId: params.threadId, ...(turnId === 'starting' || turnId === 'external-active' ? {} : { turnId }), code: 'THREAD_CLOSED' });
      this.publish('pocketagent/requests', { requests: this.pendingRequests });
    }
    if (message.id !== undefined) {
      this.requests.set(String(message.id), { id: message.id, method: message.method, params });
      this.publish('pocketagent/requests', { requests: this.pendingRequests });
    }
    if (message.method === 'turn/started' && params.threadId) this.active.set(params.threadId, params.turn?.id ?? 'starting');
    if (message.method === 'thread/status/changed' && params.threadId) {
      if (params.status?.type === 'active' && !this.active.has(params.threadId)) this.active.set(params.threadId, 'external-active');
      if (params.status?.type !== 'active') { this.active.delete(params.threadId); this.starting.delete(params.threadId); }
    }
    if (message.method === 'turn/completed' && params.threadId) {
      this.active.delete(params.threadId);
      this.starting.delete(params.threadId);
      for (const [id, req] of this.requests) if (req.params.threadId === params.threadId) this.requests.delete(id);
      this.publish('pocketagent/requests', { requests: this.pendingRequests });
    }
    if (message.method === 'serverRequest/resolved') {
      this.requests.delete(String(params.requestId));
      this.publish('pocketagent/requests', { requests: this.pendingRequests });
    }
    this.publish(message.method, params);
  }
  respond(id: string | number, result: any) {
    const req = this.requests.get(String(id));
    if (!req) throw new Error('REQUEST_ALREADY_RESOLVED');
    this.write({ id: req.id, result });
    this.requests.delete(String(id));
    this.publish('pocketagent/requests', { requests: this.pendingRequests });
  }
  startTurn(threadId: string, params: any, requestId: string, approvalsReviewer?: ApprovalsReviewer) {
    if (this.stopping || this.recoveryPromise || this.status.codex !== 'ready') return Promise.reject(new Error('CODEX_OFFLINE'));
    const fingerprint = createHash('sha256').update(JSON.stringify(params)).digest('hex');
    const previous = this.sends.get(requestId);
    if (previous) {
      if (previous.threadId !== threadId || previous.fingerprint !== fingerprint) return Promise.reject(new Error('REQUEST_ID_CONFLICT'));
      return previous.result;
    }
    const persisted = this.ledger?.readSubmission(requestId);
    if (persisted) return Promise.reject(new Error(persisted.threadId !== threadId || persisted.fingerprint !== fingerprint ? 'REQUEST_ID_CONFLICT' : 'REQUEST_ALREADY_SUBMITTED'));
    if (this.active.has(threadId)) return Promise.reject(new Error('THREAD_BUSY'));
    if (this.sends.size >= 2000) this.sends.delete(this.sends.keys().next().value!);
    this.active.set(threadId, 'starting');
    try { this.ledger?.recordSubmission(requestId, threadId, fingerprint); } catch (error) { this.active.delete(threadId); return Promise.reject(error); }
    const claim = {};
    this.starting.set(threadId, claim);
    // Desktop preferences are execution settings, not part of the submitted
    // message identity. A retry after an App mode change still reuses its claim.
    const result = this.request('turn/start', { ...params, threadId, ...(approvalsReviewer ? { approvalsReviewer } : {}) }).then(value => {
      // Completion (and even a new turn) may precede this RPC response.
      if (this.starting.get(threadId) === claim && this.active.has(threadId)) this.active.set(threadId, value.turn?.id ?? 'starting');
      return value;
    }).catch(error => {
      if (this.starting.get(threadId) === claim && error?.message !== 'CODEX_REQUEST_TIMEOUT') this.active.delete(threadId);
      if (error instanceof CodexRpcError) { this.ledger?.forgetSubmission(requestId); this.sends.delete(requestId); }
      throw error;
    }).finally(() => {
      if (this.starting.get(threadId) === claim) this.starting.delete(threadId);
    });
    this.sends.set(requestId, { threadId, fingerprint, result });
    return result;
  }
  async interrupt(threadId: string) {
    let turnId = this.active.get(threadId);
    if (turnId === 'external-active' || turnId === 'starting') {
      const page = await this.request('thread/turns/list', { threadId, limit: 10, itemsView: 'notLoaded' });
      turnId = page.data?.find((turn: any) => turn.status === 'inProgress')?.id;
    }
    if (!turnId || turnId === 'starting') return Promise.reject(new Error('NO_ACTIVE_TURN'));
    return this.request('turn/interrupt', { threadId, turnId });
  }
  recover(): Promise<void> {
    if (this.recoveryPromise) return this.recoveryPromise;
    const generation = ++this.lifecycle;
    const previousStart = this.startPromise;
    this.stopping = true;
    const result = Promise.resolve().then(async () => {
      this.setStatus({ codex: 'starting' });
      await this.stopOwnedChild();
      await previousStart?.catch(() => {});
      if (generation !== this.lifecycle) throw new Error('CODEX_RECOVERY_FAILED');
      await this.beginStart();
      if (generation !== this.lifecycle) throw new Error('CODEX_RECOVERY_FAILED');
    }).catch(error => {
      this.stopping = true;
      const code = error instanceof Error && error.message === 'CODEX_STOP_FAILED' ? 'CODEX_STOP_FAILED' : 'CODEX_RECOVERY_FAILED';
      this.setStatus({ codex: 'offline', error: code });
      throw new Error(code);
    }).finally(() => {
      if (this.recoveryPromise === result) this.recoveryPromise = undefined;
    });
    this.recoveryPromise = result;
    return result;
  }
  stop(): Promise<void> {
    ++this.lifecycle;
    this.stopping = true;
    return this.stopOwnedChild();
  }
  private hasExited(child: ChildProcessWithoutNullStreams) {
    return child.exitCode !== null || child.signalCode !== null || !child.pid;
  }
  private waitForExit(child: ChildProcessWithoutNullStreams, milliseconds: number): Promise<boolean> {
    if (this.hasExited(child)) return Promise.resolve(true);
    return new Promise(resolve => {
      const finish = (exited: boolean) => { clearTimeout(timer); child.off('exit', onExit); resolve(exited); };
      const onExit = () => finish(true);
      const timer = setTimeout(() => finish(this.hasExited(child)), milliseconds);
      timer.unref();
      child.once('exit', onExit);
    });
  }
  private async killOwnedTree(child: ChildProcessWithoutNullStreams) {
    if (!child.pid || this.hasExited(child)) return;
    if (process.platform !== 'win32') { child.kill('SIGTERM'); return; }
    await new Promise<void>(resolve => {
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      const finish = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => { killer.kill(); finish(); }, 3000);
      timer.unref();
      killer.once('error', finish);
      killer.once('exit', finish);
    });
  }
  private stopOwnedChild(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    const result = Promise.resolve().then(async () => {
      const child = this.child;
      if (!child) { this.disconnected('STOPPED'); return; }
      try { child.stdin.end(); } catch { /* The exit check below remains authoritative. */ }
      let exited = await this.waitForExit(child, 2000);
      if (!exited) {
        try { await this.killOwnedTree(child); } catch { /* Never assume a failed kill means exit. */ }
        exited = await this.waitForExit(child, 3000);
      }
      if (!exited) {
        this.setStatus({ codex: 'offline', error: 'CODEX_STOP_FAILED' });
        throw new Error('CODEX_STOP_FAILED');
      }
      if (this.child === child) { this.child = undefined; this.disconnected('STOPPED'); }
    }).finally(() => {
      if (this.stopPromise === result) this.stopPromise = undefined;
    });
    this.stopPromise = result;
    return result;
  }
}
