import { EventEmitter } from 'node:events';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import type { AppEvent, PendingRequest, ServiceStatus } from '../shared/types.js';
import type { ClientRequest } from '../../.generated/codex/ClientRequest.js';
import type { InitializeParams } from '../../.generated/codex/InitializeParams.js';

export interface CodexCommand { command: string; args: string[] }
export interface SubmissionLedger {
  readSubmission(id: string): { threadId: string; fingerprint: string } | null;
  recordSubmission(id: string, threadId: string, fingerprint: string): void;
  forgetSubmission(id: string): void;
}
type RpcPending = { method: string; resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };
export class CodexBridge extends EventEmitter {
  status: ServiceStatus = { codex: 'offline' };
  private child?: ChildProcessWithoutNullStreams;
  private rpc = new Map<number, RpcPending>();
  private nextId = 1;
  private seq = 0;
  private journal: AppEvent[] = [];
  private requests = new Map<string, PendingRequest>();
  private active = new Map<string, string>();
  private sends = new Map<string, { threadId: string; fingerprint: string; result: Promise<any> }>();
  private stopping = false;
  get pendingRequests() { return [...this.requests.values()]; }
  constructor(private executable: CodexCommand, private ledger?: SubmissionLedger) { super(); }
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
  private setStatus(status: ServiceStatus) { this.status = status; this.publish('pocketagent/status', { status }); }
  async start() {
    if (this.child) return;
    this.stopping = false;
    this.setStatus({ codex: 'starting' });
    const child = spawn(this.executable.command, [...this.executable.args, 'app-server', '--listen', 'stdio://', '-c', 'approval_policy="on-request"', '-c', 'sandbox_mode="workspace-write"'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false });
    this.child = child;
    child.stdin.on('error', () => { /* Process lifecycle reports failures without raw diagnostics. */ });
    child.stderr.resume(); // Never forward possibly sensitive CLI diagnostics to logs.
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on('line', line => {
      try { this.receive(JSON.parse(line)); } catch { this.publish('pocketagent/protocolError', { code: 'INVALID_RPC_MESSAGE' }); }
    });
    child.on('error', () => { if (this.child === child) this.child = undefined; lines.close(); this.disconnected('CODEX_START_FAILED'); });
    child.on('exit', () => { lines.close(); this.child = undefined; this.disconnected(this.stopping ? 'STOPPED' : 'CODEX_EXITED'); });
    try {
      const init: InitializeParams = { clientInfo: { name: 'pocketagent', title: 'PocketAgent', version: '0.1.0' }, capabilities: { experimentalApi: true, requestAttestation: false } };
      const result = await this.request('initialize', init);
      this.write({ method: 'initialized', params: {} });
      let authenticated = false;
      try { const account = await this.request('account/read', {}); authenticated = !!account.account; } catch { /* status remains explicit */ }
      if (this.child !== child || child.exitCode !== null) throw new Error('CODEX_EXITED');
      this.setStatus({ codex: 'ready', authenticated, version: typeof result?.userAgent === 'string' ? result.userAgent.match(/\d+\.\d+\.\d+/)?.[0] : undefined });
    } catch {
      await this.stop();
      this.setStatus({ codex: 'offline', error: 'CODEX_INITIALIZE_FAILED' });
      throw new Error('CODEX_INITIALIZE_FAILED');
    }
  }
  private disconnected(code: string) {
    for (const p of this.rpc.values()) { clearTimeout(p.timer); p.reject(new Error(code)); }
    this.rpc.clear();
    for (const [threadId, turnId] of this.active) this.publish('pocketagent/interrupted', { threadId, turnId, code });
    this.active.clear(); this.requests.clear();
    this.publish('pocketagent/requests', { requests: [] });
    this.setStatus({ codex: 'offline', error: code });
  }
  private write(message: object) {
    if (!this.child?.stdin.writable) throw new Error('CODEX_OFFLINE');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }
  request(method: ClientRequest['method'] | string, params: any = {}): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.rpc.delete(id); reject(new Error('CODEX_REQUEST_TIMEOUT')); }, 45_000);
      timer.unref();
      this.rpc.set(id, { method, resolve, reject, timer });
      try { this.write({ id, method, params }); } catch (error) { clearTimeout(timer); this.rpc.delete(id); reject(error); }
    });
  }
  private receive(message: any) {
    if (message.id !== undefined && !message.method) {
      const pending = this.rpc.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer); this.rpc.delete(message.id);
      if (message.error) { const err = new Error('CODEX_RPC_ERROR'); Object.assign(err, { rpcCode: message.error.code }); pending.reject(err); }
      else {
        if (['thread/read', 'thread/resume', 'thread/start'].includes(pending.method)) {
          const thread = message.result?.thread;
          if (thread?.id && thread.status?.type === 'active' && !this.active.has(thread.id)) {
            const running = thread.turns?.find((turn: any) => turn.status === 'inProgress');
            this.active.set(thread.id, running?.id ?? 'external-active');
          } else if (thread?.id && thread.status?.type !== 'active' && this.active.get(thread.id) === 'external-active') this.active.delete(thread.id);
        }
        pending.resolve(message.result);
      }
      return;
    }
    if (typeof message.method !== 'string') return;
    const params = message.params ?? {};
    if (message.id !== undefined) {
      this.requests.set(String(message.id), { id: message.id, method: message.method, params });
      this.publish('pocketagent/requests', { requests: this.pendingRequests });
    }
    if (message.method === 'turn/started' && params.threadId) this.active.set(params.threadId, params.turn?.id ?? 'starting');
    if (message.method === 'thread/status/changed' && params.threadId) {
      if (params.status?.type === 'active' && !this.active.has(params.threadId)) this.active.set(params.threadId, 'external-active');
      if (params.status?.type !== 'active') this.active.delete(params.threadId);
    }
    if (message.method === 'turn/completed' && params.threadId) {
      this.active.delete(params.threadId);
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
  startTurn(threadId: string, params: any, requestId: string) {
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
    const result = this.request('turn/start', { ...params, threadId }).then(value => {
      // Completion notifications may arrive before the RPC response.
      if (this.active.has(threadId)) this.active.set(threadId, value.turn?.id ?? 'starting');
      return value;
    }).catch(error => {
      if (error?.message !== 'CODEX_REQUEST_TIMEOUT') this.active.delete(threadId);
      if (error?.message === 'CODEX_RPC_ERROR') { this.ledger?.forgetSubmission(requestId); this.sends.delete(requestId); }
      throw error;
    });
    this.sends.set(requestId, { threadId, fingerprint, result });
    return result;
  }
  async interrupt(threadId: string) {
    let turnId = this.active.get(threadId);
    if (turnId === 'external-active') {
      const page = await this.request('thread/turns/list', { threadId, limit: 10, itemsView: 'notLoaded' });
      turnId = page.data?.find((turn: any) => turn.status === 'inProgress')?.id;
    }
    if (!turnId || turnId === 'starting') return Promise.reject(new Error('NO_ACTIVE_TURN'));
    return this.request('turn/interrupt', { threadId, turnId });
  }
  async stop() {
    this.stopping = true;
    const child = this.child;
    if (!child) return;
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
    child.stdin.end();
    const graceful = await Promise.race([exited.then(() => true), new Promise<false>(resolve => { const timer = setTimeout(() => resolve(false), 2000); timer.unref(); })]);
    if (!graceful && child.pid && child.exitCode === null) {
      if (process.platform === 'win32') {
        await new Promise<void>(resolve => { const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); killer.on('error', () => resolve()); killer.on('exit', () => resolve()); });
      } else child.kill('SIGTERM');
    }
    await Promise.race([exited, new Promise<void>(resolve => { const timer = setTimeout(resolve, 3000); timer.unref(); })]);
  }
}
