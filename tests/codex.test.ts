import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { CodexBridge, type SubmissionLedger } from '../src/server/codex.js';
import type { AppEvent } from '../src/shared/types.js';
import type { DiagnosticSink } from '../src/server/diagnostics.js';

const fixture = resolve('tests/fixtures/fake-codex.mjs');
const bridges: CodexBridge[] = [];
const directories: string[] = [];
const input = (text = 'hold') => ({ input: [{ type: 'text', text }] });
async function start(path = fixture, ledger?: SubmissionLedger, diagnostic?: DiagnosticSink) {
  const bridge = new CodexBridge({ command: process.execPath, args: [path] }, ledger, diagnostic);
  bridges.push(bridge);
  await bridge.start();
  return bridge;
}
function memoryLedger() {
  const entries = new Map<string, { threadId: string; fingerprint: string }>();
  const ledger: SubmissionLedger = {
    readSubmission: id => entries.get(id) ?? null,
    recordSubmission: (id, threadId, fingerprint) => { entries.set(id, { threadId, fingerprint }); },
    forgetSubmission: id => { entries.delete(id); },
  };
  return { ledger, entries };
}
function hasEvent(bridge: CodexBridge, method: string, threadId?: string) {
  return bridge.eventsSince(0).events.some(event => event.method === method && (!threadId || event.params.threadId === threadId));
}
afterEach(async () => {
  await Promise.all(bridges.splice(0).map(bridge => bridge.stop()));
  for (const directory of directories.splice(0)) {
    const destination = resolve(directory);
    if (!destination.startsWith(resolve(tmpdir()) + sep) || !basename(destination).startsWith('pocketagent-codex-test-')) {
      throw new Error('Refusing to remove an unexpected fixture directory.');
    }
    rmSync(destination, { recursive: true, force: true });
  }
});

describe('Codex stdio bridge with a synthetic child', () => {
  it('starts a CLI path containing spaces and Unicode without a shell', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'pocketagent-codex-test-模擬 cli '));
    directories.push(directory);
    const copy = join(directory, '模擬 codex.mjs');
    copyFileSync(fixture, copy);
    const bridge = await start(copy);
    expect(bridge.status).toMatchObject({ codex: 'ready', authenticated: true, version: '0.167.0' });
    expect(await bridge.request('fixture/stats')).toMatchObject({ initializes: 1, starts: 0 });
  });

  it('correlates interleaved RPC replies by request ID', async () => {
    const bridge = await start();
    const order: string[] = [];
    const slow = bridge.request('fixture/echo', { value: 'slow', delay: 40 }).then(result => { order.push(result.value); return result; });
    const fast = bridge.request('fixture/echo', { value: 'fast', delay: 1 }).then(result => { order.push(result.value); return result; });
    expect(await Promise.all([slow, fast])).toEqual([{ value: 'slow' }, { value: 'fast' }]);
    expect(order).toEqual(['fast', 'slow']);
  });

  it('does not report ready when the child exits during account/read startup', async () => {
    const bridge = new CodexBridge({ command: process.execPath, args: [fixture, '--fixture-crash-account-read'] });
    bridges.push(bridge);
    await expect(bridge.start()).rejects.toThrow('CODEX_INITIALIZE_FAILED');
    expect(bridge.status).toMatchObject({ codex: 'offline', error: 'CODEX_INITIALIZE_FAILED' });
    expect(bridge.eventsSince(0).events.some(event => event.method === 'pocketagent/status' &&
      (event.params.status as { codex?: string })?.codex === 'ready')).toBe(false);
  });

  it.each(['thread/read', 'thread/resume'])('adopts an already active %s result without turn/started', async method => {
    const bridge = await start();
    await bridge.request(method, { threadId: 'resumed-active-thread' });
    expect(hasEvent(bridge, 'turn/started', 'resumed-active-thread')).toBe(false);
    await expect(bridge.startTurn('resumed-active-thread', input(), 'resumed-request')).rejects.toThrow('THREAD_BUSY');
    // The bridge discovers the running turn before interrupting an adopted thread.
    await bridge.interrupt('resumed-active-thread');
    await expect(bridge.startTurn('resumed-active-thread', input(), 'after-resume-request')).resolves.toHaveProperty('turn.id');
    expect(await bridge.request('fixture/stats')).toMatchObject({ starts: 1 });
  });

  it('deduplicates identical sends and rejects conflicts and concurrent turns', async () => {
    const bridge = await start();
    const first = bridge.startTurn('fixture-thread', input(), 'fixture-request');
    const duplicate = bridge.startTurn('fixture-thread', input(), 'fixture-request');
    expect(duplicate).toBe(first);
    await expect(bridge.startTurn('fixture-thread', input('changed'), 'fixture-request')).rejects.toThrow('REQUEST_ID_CONFLICT');
    await expect(bridge.startTurn('other-thread', input(), 'fixture-request')).rejects.toThrow('REQUEST_ID_CONFLICT');
    await first;
    await expect(bridge.startTurn('fixture-thread', input(), 'second-request')).rejects.toThrow('THREAD_BUSY');
    expect(await bridge.request('fixture/stats')).toMatchObject({ starts: 1 });
    await bridge.interrupt('fixture-thread');
    await expect(bridge.startTurn('fixture-thread', input(), 'third-request')).resolves.toHaveProperty('turn.id');
    expect(await bridge.request('fixture/stats')).toMatchObject({ starts: 2 });
  });

  it('keeps running when a browser event subscriber disconnects', async () => {
    const bridge = await start();
    const browser = vi.fn<(event: AppEvent) => void>();
    bridge.on('event', browser);
    await bridge.startTurn('disconnected-browser', input(), 'disconnect-request');
    bridge.off('event', browser);
    const callsAtDisconnect = browser.mock.calls.length;
    expect(await bridge.request('fixture/stats')).toMatchObject({ active: ['disconnected-browser'] });
    await bridge.request('fixture/complete', { threadId: 'disconnected-browser' });
    expect(bridge.status.codex).toBe('ready');
    expect(hasEvent(bridge, 'turn/completed', 'disconnected-browser')).toBe(true);
    expect(browser.mock.calls.length).toBe(callsAtDisconnect);
  });

  it('retains pending approvals offline and resolves them exactly once', async () => {
    const bridge = await start();
    await bridge.startTurn('approval-thread', input('approval'), 'approval-request');
    await vi.waitFor(() => expect(bridge.pendingRequests).toHaveLength(1));
    const request = bridge.pendingRequests[0];
    expect(request).toMatchObject({ method: 'item/commandExecution/requestApproval', params: { threadId: 'approval-thread' } });
    expect(await bridge.request('fixture/stats')).toMatchObject({ active: ['approval-thread'], approvals: 1 });
    bridge.respond(request.id, { decision: 'accept' });
    expect(bridge.pendingRequests).toHaveLength(0);
    expect(() => bridge.respond(request.id, { decision: 'accept' })).toThrow('REQUEST_ALREADY_RESOLVED');
    await vi.waitFor(() => expect(hasEvent(bridge, 'serverRequest/resolved', 'approval-thread')).toBe(true));
    expect(hasEvent(bridge, 'turn/completed', 'approval-thread')).toBe(true);
  });

  it('marks active turns interrupted on crash and never replays them after restart', async () => {
    const bridge = await start();
    await bridge.startTurn('crash-thread', input(), 'crash-request');
    await expect(bridge.request('fixture/crash')).rejects.toThrow('CODEX_EXITED');
    expect(bridge.status).toMatchObject({ codex: 'offline', error: 'CODEX_EXITED' });
    expect(hasEvent(bridge, 'pocketagent/interrupted', 'crash-thread')).toBe(true);
    expect(bridge.pendingRequests).toHaveLength(0);
    await bridge.start();
    expect(await bridge.request('fixture/stats')).toMatchObject({ starts: 0, active: [] });
    await bridge.startTurn('crash-thread', input(), 'crash-request');
    expect(await bridge.request('fixture/stats')).toMatchObject({ starts: 0 });
  });

  it('retains only a fingerprint and prevents duplicate submission across bridge instances', async () => {
    const { ledger, entries } = memoryLedger();
    const firstBridge = await start(fixture, ledger);
    const pending = firstBridge.startTurn('ledger-thread', input(), 'ledger-request');
    // The durable claim exists before the child can acknowledge a turn.
    expect(entries.get('ledger-request')).toMatchObject({ threadId: 'ledger-thread', fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(JSON.stringify([...entries.values()])).not.toContain('"text"');
    expect(firstBridge.startTurn('ledger-thread', input(), 'ledger-request')).toBe(pending);
    await pending;
    await firstBridge.stop();
    const secondBridge = await start(fixture, ledger);
    await expect(secondBridge.startTurn('ledger-thread', input(), 'ledger-request')).rejects.toThrow('REQUEST_ALREADY_SUBMITTED');
    await expect(secondBridge.startTurn('ledger-thread', input('different'), 'ledger-request')).rejects.toThrow('REQUEST_ID_CONFLICT');
    await expect(secondBridge.startTurn('another-thread', input(), 'ledger-request')).rejects.toThrow('REQUEST_ID_CONFLICT');
    expect(await secondBridge.request('fixture/stats')).toMatchObject({ starts: 0 });
  });

  it('retains an ambiguous submission when the child disappears before acknowledging it', async () => {
    const { ledger, entries } = memoryLedger();
    const firstBridge = await start(fixture, ledger);
    await expect(firstBridge.startTurn('ambiguous-thread', input('crash-during-start'), 'ambiguous-request')).rejects.toThrow('CODEX_EXITED');
    expect(entries.has('ambiguous-request')).toBe(true);
    expect(hasEvent(firstBridge, 'pocketagent/interrupted', 'ambiguous-thread')).toBe(true);
    const replacement = await start(fixture, ledger);
    await expect(replacement.startTurn('ambiguous-thread', input('crash-during-start'), 'ambiguous-request')).rejects.toThrow('REQUEST_ALREADY_SUBMITTED');
    expect(await replacement.request('fixture/stats')).toMatchObject({ starts: 0 });
  });

  it('forgets a definitively rejected request so a later bridge can submit it', async () => {
    const { ledger, entries } = memoryLedger();
    const firstBridge = await start(fixture, ledger);
    await expect(firstBridge.startTurn('rejected-thread', input('reject-start'), 'rejected-request')).rejects.toThrow('CODEX_RPC_ERROR');
    expect(entries.has('rejected-request')).toBe(false);
    await firstBridge.stop();
    const replacement = await start(fixture, ledger);
    await expect(replacement.startTurn('rejected-thread', input(), 'rejected-request')).resolves.toHaveProperty('turn.id');
    expect(await replacement.request('fixture/stats')).toMatchObject({ starts: 1 });
  });

  it('does not send a turn if its durable submission claim fails', async () => {
    const { ledger } = memoryLedger();
    let fail = true;
    const durableRecord = ledger.recordSubmission;
    ledger.recordSubmission = (id, threadId, fingerprint) => {
      if (fail) { fail = false; throw new Error('SYNTHETIC_LEDGER_UNAVAILABLE'); }
      durableRecord(id, threadId, fingerprint);
    };
    const bridge = await start(fixture, ledger);
    await expect(bridge.startTurn('ledger-error-thread', input(), 'failed-record-request')).rejects.toThrow('SYNTHETIC_LEDGER_UNAVAILABLE');
    expect(await bridge.request('fixture/stats')).toMatchObject({ starts: 0 });
    await expect(bridge.startTurn('ledger-error-thread', input(), 'successful-record-request')).resolves.toHaveProperty('turn.id');
    expect(await bridge.request('fixture/stats')).toMatchObject({ starts: 1 });
  });

  it('handles completion before the turn/start RPC reply without leaving the thread busy', async () => {
    const bridge = await start();
    await bridge.startTurn('quick-thread', input('complete-before-response'), 'quick-request');
    await expect(bridge.startTurn('quick-thread', input(), 'after-quick-request')).resolves.toHaveProperty('turn.id');
    expect(await bridge.request('fixture/stats')).toMatchObject({ starts: 2 });
  });

  it('limits replay and signals when a reconnect cursor is stale or invalid', () => {
    const bridge = new CodexBridge({ command: process.execPath, args: [fixture] });
    bridges.push(bridge);
    for (let index = 0; index < 2005; index++) bridge.publish('fixture/event', { index });
    expect(bridge.eventsSince(0).events).toHaveLength(2000);
    expect(bridge.eventsSince(1).reset).toBe(true);
    expect(bridge.eventsSince(2004)).toMatchObject({ reset: false, events: [{ seq: 2005 }] });
    expect(bridge.eventsSince(9000).reset).toBe(true);
  });

  it('exposes structured RPC failure codes without upstream diagnostic text', async () => {
    const diagnostic = vi.fn<DiagnosticSink>();
    const bridge = await start(fixture, undefined, diagnostic);
    await expect(bridge.request('fixture/error', { syntheticPrivateValue: 'Synthetic request payload stays private' })).rejects.toMatchObject({ message: 'CODEX_RPC_ERROR', rpcCode: -32602 });
    expect(diagnostic).toHaveBeenCalledWith(expect.objectContaining({ component: 'codex', code: 'CODEX_RPC_ERROR', operation: 'UNKNOWN_OPERATION', rpcCode: -32602, durationMs: expect.any(Number) }));
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('Synthetic upstream diagnostic');
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('Synthetic request payload stays private');
    expect(JSON.stringify(bridge.eventsSince(0).events)).not.toContain('Synthetic upstream diagnostic');
  });
  it('does not let a failing diagnostic callback break agent requests', async () => {
    const bridge = await start(fixture, undefined, () => { throw new Error('SYNTHETIC_DIAGNOSTIC_FAILURE'); });
    expect(bridge.status.codex).toBe('ready');
    await expect(bridge.request('fixture/error')).rejects.toMatchObject({ message: 'CODEX_RPC_ERROR', rpcCode: -32602 });
    expect(await bridge.request('fixture/stats')).toHaveProperty('starts', 0);
  });
  it('classifies writer ownership without retaining upstream identifiers and permits retry after a definite rejection', async () => {
    const diagnostic = vi.fn<DiagnosticSink>();
    const { ledger, entries } = memoryLedger();
    const bridge = await start(fixture, ledger, diagnostic);
    await expect(bridge.request('thread/resume', { threadId: 'writer-conflict-thread' })).rejects.toMatchObject({ message: 'THREAD_WRITER_CONFLICT', rpcCode: -32600 });
    expect(diagnostic).toHaveBeenCalledWith(expect.objectContaining({ code: 'THREAD_WRITER_CONFLICT', operation: 'thread/resume', rpcCode: -32600 }));
    await expect(bridge.startTurn('writer-rejected-thread', input('writer-conflict'), 'writer-rejected-request')).rejects.toMatchObject({ message: 'THREAD_WRITER_CONFLICT', rpcCode: -32600 });
    expect(entries.has('writer-rejected-request')).toBe(false);
    await expect(bridge.startTurn('writer-rejected-thread', input(), 'writer-rejected-request')).resolves.toHaveProperty('turn.id');
    expect(await bridge.request('fixture/stats')).toHaveProperty('starts', 1);
    const logs = JSON.stringify(diagnostic.mock.calls);
    expect(logs).not.toContain('00000000-0000-4000-8000-000000000000');
    expect(logs).not.toContain('synthetic.jsonl');
    expect(logs).not.toContain('already has an active writer');
  });
});
