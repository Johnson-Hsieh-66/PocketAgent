import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, applyThreadEvent, errorText, mergeHistory, mergeTurn } from '../src/client/App';
import type { AppEvent, Turn } from '../src/shared/types';

const event = (method: string, params: Record<string, unknown>): AppEvent => ({ seq: 1, method, params: { threadId: 'fixture-thread', turnId: 'fixture-turn', ...params } });
const turn = (text: string, status = 'inProgress'): Turn => ({ id: 'fixture-turn', status, items: [{ id: 'fixture-message', type: 'agentMessage', text }] });

afterEach(() => vi.unstubAllGlobals());

describe('recoverable API errors', () => {
  it('retains the submission code for recovery while rendering a Chinese warning against accidental replay', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'REQUEST_ALREADY_SUBMITTED' }), { status: 409 })));
    const failure = await api('/threads/fixture-thread/messages', { method: 'POST', body: '{}' }).catch((reason: unknown) => reason);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe('REQUEST_ALREADY_SUBMITTED');
    expect(errorText(failure)).toBe('這則訊息可能已送出。請先查看對話紀錄，確認後再編輯或建立新訊息。');
    expect((failure as Error).message).toBe('REQUEST_ALREADY_SUBMITTED');
  });

  it('gives pairing and access failures a concrete recovery action', () => {
    expect(errorText(new Error('PAIRING_CODE_INVALID_OR_EXPIRED'))).toContain('npm run pair');
    expect(errorText(new Error('HOST_NOT_ALLOWED'))).toContain('Tailscale IP');
    expect(errorText(new Error('ORIGIN_NOT_ALLOWED'))).toContain('PocketAgent 的服務位址');
    expect(errorText(new Error('THREAD_BUSY'))).toContain('先停止目前的工作');
    expect(errorText(new Error('CODEX_OFFLINE'))).toContain('確認 CLI 狀態');
  });
});

describe('mobile conversation event reconciliation', () => {
  it('accumulates stream deltas before a history snapshot contains the active item', () => {
    const first = applyThreadEvent([], event('item/agentMessage/delta', { itemId: 'fixture-message', delta: 'Hello' }));
    const next = applyThreadEvent(first, event('item/agentMessage/delta', { itemId: 'fixture-message', delta: ' world' }));
    expect(next).toEqual([turn('Hello world')]);
    expect(mergeHistory([], next)).toEqual(next);
  });

  it('preserves streamed text and the terminal state when an older snapshot arrives during reconnect', () => {
    const live = [turn('Completed response', 'completed')];
    const merged = mergeHistory([turn('Completed')], live);
    expect(merged[0].items[0].text).toBe('Completed response');
    expect(merged[0].status).toBe('completed');
    expect(merged).toHaveLength(1);
  });

  it('combines history with new live turns without duplicating overlapping IDs', () => {
    const historical: Turn = { id: 'older-turn', status: 'completed', items: [{ id: 'older-message', type: 'agentMessage', text: 'Earlier message' }] };
    const snapshot = [historical, turn('Part')];
    const merged = mergeHistory(snapshot, [turn('Partial response')]);
    expect(merged.map((entry) => entry.id)).toEqual(['older-turn', 'fixture-turn']);
    expect(merged[1].items).toHaveLength(1);
    expect(merged[1].items[0].text).toBe('Partial response');
  });

  it('does not erase active items when turn acknowledgement has no items', () => {
    const merged = mergeTurn([turn('Streaming reply')], { id: 'fixture-turn', status: 'inProgress', items: [] });
    expect(merged[0].items[0].text).toBe('Streaming reply');
  });

  it('keeps command output independently from agent text and reconciles completion', () => {
    let state = applyThreadEvent([], event('item/started', { item: { id: 'fixture-command', type: 'commandExecution', command: 'fixture-command', status: 'inProgress' } }));
    state = applyThreadEvent(state, event('item/commandExecution/outputDelta', { itemId: 'fixture-command', delta: 'synthetic output' }));
    state = applyThreadEvent(state, event('item/completed', { item: { id: 'fixture-command', type: 'commandExecution', command: 'fixture-command', status: 'completed', aggregatedOutput: 'synthetic output', exitCode: 0 } }));
    state = applyThreadEvent(state, event('turn/completed', { turn: { id: 'fixture-turn', status: 'completed', items: [] } }));
    expect(state[0].status).toBe('completed');
    expect(state[0].items[0].aggregatedOutput).toBe('synthetic output');
    expect(state[0].items[0].exitCode).toBe(0);
    expect(state[0].items).toHaveLength(1);
  });
});
