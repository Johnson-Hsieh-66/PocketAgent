import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AccessFooter, api, applyThreadEvent, authorizationLabel, errorText, mergeHistory, mergeTurn, ModelOptions, normalizePairingCode, Pairing } from '../src/client/App';
import type { AppEvent, Turn } from '../src/shared/types';

const event = (method: string, params: Record<string, unknown>): AppEvent => ({ seq: 1, method, params: { threadId: 'fixture-thread', turnId: 'fixture-turn', ...params } });
const turn = (text: string, status = 'inProgress'): Turn => ({ id: 'fixture-turn', status, items: [{ id: 'fixture-message', type: 'agentMessage', text }] });

afterEach(() => vi.unstubAllGlobals());

describe('effective Codex authorization summary', () => {
  it('describes actual access and reviewer settings instead of assuming workspace write', () => {
    expect(authorizationLabel({ sandbox: { type: 'readOnly' }, approvalPolicy: 'on-request', approvalsReviewer: 'user' })).toBe('唯讀 · 需要時核准');
    expect(authorizationLabel({ sandbox: { type: 'workspaceWrite' }, approvalPolicy: 'on-request', approvalsReviewer: 'auto_review' })).toBe('工作區寫入 · 自動審核');
    expect(authorizationLabel({ sandboxPolicy: { type: 'workspaceWrite' }, approvalPolicy: 'on-request', approvalsReviewer: 'auto_review' })).toBe('工作區寫入 · 自動審核');
    expect(authorizationLabel({ sandbox: { type: 'dangerFullAccess' }, approvalPolicy: 'never', approvalsReviewer: 'auto_review' })).toBe('完整存取 · 不需核准');
    expect(authorizationLabel({ sandbox: { type: 'workspaceWrite' }, activePermissionProfile: { id: ':workspace' }, approvalPolicy: { granular: {} } })).toBe('工作區寫入 · 依授權規則核准');
  });
  it('uses fixed labels for custom profiles and falls back when effective settings are unavailable', () => {
    expect(authorizationLabel({ sandbox: { type: 'workspaceWrite' }, activePermissionProfile: { id: 'synthetic-private-profile' }, approvalPolicy: 'on-request' })).toBe('自訂授權 · 需要時核准');
    expect(authorizationLabel({ sandbox: { type: 'synthetic-unknown' }, approvalPolicy: 'on-request' })).toBeNull();
    expect(authorizationLabel(null)).toBeNull();
  });
});

describe('recoverable API errors', () => {
  it('bounds read requests and reports timeout without retrying them automatically', async () => {
    const timeout = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(timeout.signal);
    const fetch = vi.fn((_url: string, options: RequestInit) => new Promise<Response>((_resolve, reject) => options.signal!.addEventListener('abort', () => reject(options.signal!.reason), { once: true })));
    vi.stubGlobal('fetch', fetch);
    const request = api('/status').catch((reason: unknown) => reason);
    timeout.abort();
    expect((await request as Error).message).toBe('REQUEST_TIMEOUT');
    expect(fetch).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });

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

describe('optional device pairing', () => {
  const renderAccess = (required: boolean, paired: boolean, busy = false) => renderToStaticMarkup(createElement(AccessFooter, { required, paired, busy, connection: 'connected', onPairingChange: vi.fn(), onLogout: vi.fn(), onReconnect: vi.fn(), onRecover: vi.fn(), recovering: false }));

  it('renders anonymous private-network access with pairing off and no misleading logout', () => {
    const markup = renderAccess(false, false);
    const control = markup.match(/<input\b[^>]*\brole="switch"[^>]*>/)?.[0] || '';
    expect(markup).toContain('免配對');
    expect(markup).toContain('私人連線');
    expect(markup).toContain('設定');
    expect(markup).not.toContain('要求裝置配對');
    expect(control).toBe('');
    expect(markup).not.toContain('移除此裝置配對');
  });

  it('shows the real paired state while keeping access controls behind settings', () => {
    const markup = renderAccess(true, true, true);
    const control = markup.match(/<input\b[^>]*\brole="switch"[^>]*>/)?.[0] || '';
    expect(control).toBe('');
    expect(markup).toContain('裝置已配對');
    expect(markup).toContain('移除此裝置配對');
    expect(markup).toContain('設定');
  });

  it('rechecks access on protected API rejection without treating a bad pairing code as a session logout', async () => {
    const browser = new EventTarget();
    const recheck = vi.fn();
    browser.addEventListener('pocketagent:reauth', recheck);
    vi.stubGlobal('window', browser);
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(JSON.stringify({ error: 'AUTHENTICATION_REQUIRED' }), { status: 401 })));
    await expect(api('/projects')).rejects.toThrow('AUTHENTICATION_REQUIRED');
    expect(recheck).toHaveBeenCalledTimes(1);
    await expect(api('/auth/pair', { method: 'POST', body: '{}' })).rejects.toThrow();
    expect(recheck).toHaveBeenCalledTimes(1);
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

  it('preserves output through a delayed start and trusts the canonical completed item', () => {
    let state = applyThreadEvent([], event('item/agentMessage/delta', { itemId: 'fixture-message', delta: 'Complete streamed output' }));
    state = applyThreadEvent(state, event('item/started', { item: { id: 'fixture-message', type: 'agentMessage', text: '' } }));
    expect(state[0].items[0].text).toBe('Complete streamed output');
    state = applyThreadEvent(state, event('item/completed', { item: { id: 'fixture-message', type: 'agentMessage', text: 'Complete' } }));
    expect(state[0].items[0].text).toBe('Complete');
  });

  it('does not append a delta twice when a leading history snapshot already contains it', () => {
    let state = applyThreadEvent([], event('item/agentMessage/delta', { itemId: 'fixture-message', delta: 'Hel' }));
    state = mergeHistory(state, [turn('Hello')]);
    state = applyThreadEvent(state, event('item/agentMessage/delta', { itemId: 'fixture-message', delta: 'lo' }));
    expect(state[0].items[0].text).toBe('Hello');
    state = applyThreadEvent(state, event('item/agentMessage/delta', { itemId: 'fixture-message', delta: ' world' }));
    expect(state[0].items[0].text).toBe('Hello world');
  });

  it('corrects polluted output with terminal history and ignores late replay deltas', () => {
    let state = mergeHistory([turn('Hellolo')], [turn('Hello', 'completed')]);
    state = applyThreadEvent(state, event('item/agentMessage/delta', { itemId: 'fixture-message', delta: 'lo' }));
    expect(state[0].items[0].text).toBe('Hello');
    expect(state[0].status).toBe('completed');
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
