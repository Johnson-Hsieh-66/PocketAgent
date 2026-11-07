import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { api, applyThreadEvent, errorText, mergeHistory, mergeTurn, ModelOptions, normalizePairingCode, Pairing } from '../src/client/App';
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
    expect(errorText(new Error('PAIRING_CODE_FORMAT_INVALID'))).toContain('8 位數字');
    expect(errorText(new Error('DEVICE_NAME_INVALID'))).toContain('裝置名稱');
    expect(errorText(new Error('HOST_NOT_ALLOWED'))).toContain('區網');
    expect(errorText(new Error('HOST_NOT_ALLOWED'))).toContain('Tailscale IP');
    expect(errorText(new Error('ORIGIN_NOT_ALLOWED'))).toContain('PocketAgent 的服務位址');
    expect(errorText(new Error('THREAD_BUSY'))).toContain('先停止目前的工作');
    expect(errorText(new Error('CODEX_OFFLINE'))).toContain('確認 CLI 狀態');
  });
});

describe('pairing input regression', () => {
  it('renders a fixed eight-digit input and blocks the initially empty submission', () => {
    const markup = renderToStaticMarkup(createElement(Pairing, { onPaired: vi.fn() }));
    const input = markup.match(/<input\b[^>]*\bid="pair-code"[^>]*>/)?.[0] || '';
    const submit = markup.match(/<button\b[^>]*\bclass="button accent pair-button"[^>]*>/)?.[0] || '';
    expect(input).toMatch(/maxLength="8"/i);
    expect(input).toMatch(/minLength="8"/i);
    expect(input).toContain('pattern="[0-9]{8}"');
    expect(input).toContain('inputMode="numeric"');
    expect(submit).toMatch(/\bdisabled(?:="")?/);
  });

  it('preserves leading zeroes and normalizes pasted full-width digits without accepting a ninth digit', () => {
    expect(normalizePairingCode('012345679')).toBe('01234567');
    expect(normalizePairingCode('０１２３ ４５６７９')).toBe('01234567');
    expect(normalizePairingCode('ab０１２３-cd４５６７')).toBe('01234567');
    expect(normalizePairingCode('0123456')).toHaveLength(7);
  });
});

describe('resumed conversation model selection', () => {
  const models = [{ id: 'catalog-model', model: 'catalog-model', displayName: 'Catalog model' }];
  const render = (model: string) => renderToStaticMarkup(createElement('select', { value: model, onChange: () => undefined }, createElement(ModelOptions, { models, model })));

  it('keeps a resumed model selected even when it is missing from the current catalog', () => {
    const markup = render('synthetic-resumed-model');
    expect(markup).toContain('<option value="synthetic-resumed-model" selected="">synthetic-resumed-model（目前對話）</option>');
    expect(markup).toContain('<option value="catalog-model">Catalog model</option>');
    expect(render('catalog-model').match(/value="catalog-model"/g)).toHaveLength(1);
  });

  it('lets a conversation keep its existing model when resume does not return a model name', () => {
    expect(render('')).toContain('<option value="" selected="">沿用對話模型</option>');
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
