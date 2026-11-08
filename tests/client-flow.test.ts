// @vitest-environment happy-dom

import { act, createElement, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/client/App';
import type { ThreadTurnsListResponse } from '../.generated/codex/v2/ThreadTurnsListResponse';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(complete => { resolve = complete; });
  return { promise, resolve };
}
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const project = { id: 'synthetic-project', name: 'Synthetic project', path: '/synthetic/project' };
const thread = { id: 'synthetic-thread', name: 'Synthetic earlier conversation', preview: 'Synthetic preview', cwd: project.path, updatedAt: 1, status: { type: 'idle' } };
const history: ThreadTurnsListResponse = {
  data: [{
    id: 'synthetic-turn', rootTurnId: null, itemsView: 'full', status: 'completed', error: null, startedAt: 1, completedAt: 2, durationMs: 1000,
    items: [{ id: 'synthetic-message', type: 'agentMessage', text: 'Synthetic readable conversation history.', phase: 'final_answer', memoryCitation: null, delivery: null, questions: null }],
  }],
  nextCursor: null,
  backwardsCursor: null,
};

class QuietSocket {
  static instances: QuietSocket[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  constructor(readonly url: string) { QuietSocket.instances.push(this); queueMicrotask(() => this.onopen?.()); }
  close() { /* Test sockets never connect to the network. */ }
  emit(method: string, params: Record<string, unknown>, seq: number) { this.onmessage?.({ data: JSON.stringify({ seq, method, params }) } as MessageEvent); }
}

describe('conversation UI recovery with synthetic Codex responses', () => {
  let container: HTMLDivElement;
  let root: Root;
  let fetchMock: ReturnType<typeof vi.fn>;
  let resumeHandler: () => Response | Promise<Response>;
  let historyHandler: (url: string) => Response | Promise<Response>;
  let uploadHandler: () => Response | Promise<Response>;
  let messageHandler: (data: Record<string, unknown>, options?: RequestInit) => Response | Promise<Response>;
  let readHandler: () => Response | Promise<Response>;
  let statusHandler: () => Response | Promise<Response>;
  let recoveryHandler: () => Response | Promise<Response>;

  const settle = async () => { for (let index = 0; index < 5; index++) await act(async () => { await Promise.resolve(); }); };
  const button = (label: string) => {
    const element = Array.from(container.querySelectorAll('button')).find(entry => entry.textContent?.includes(label));
    if (!element) throw new Error('SYNTHETIC_BUTTON_NOT_FOUND');
    return element;
  };
  const settingsButton = (label: string) => {
    const element = Array.from(document.querySelectorAll<HTMLButtonElement>('.access-settings-dialog button')).find(entry => entry.textContent?.includes(label));
    if (!element) throw new Error('SYNTHETIC_SETTINGS_BUTTON_NOT_FOUND');
    return element;
  };
  const click = async (element: Element) => { await act(async () => { element.dispatchEvent(new MouseEvent('click', { bubbles: true })); }); await settle(); };
  const draft = async (text: string) => {
    const element = container.querySelector('textarea')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(element, text);
      element.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await settle();
  };
  const sendButton = () => container.querySelector<HTMLButtonElement>('button[aria-label="傳送訊息"]')!;
  const select = async (label: string, value: string) => {
    await act(async () => { const element = container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!; element.value = value; element.dispatchEvent(new Event('change', { bubbles: true })); });
    await settle();
  };
  const submit = async () => { await act(async () => { container.querySelector('form.composer')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); }); await settle(); };
  const chooseFiles = async (count: number) => {
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, 'files', { configurable: true, value: Array.from({ length: count }, (_, index) => new File(['synthetic image'], `synthetic-${index}.png`, { type: 'image/png' })) });
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
    await settle();
  };

  beforeEach(async () => {
    window.history.replaceState(null, '', '/');
    QuietSocket.instances = [];
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('WebSocket', QuietSocket);
    HTMLElement.prototype.scrollIntoView = vi.fn();
    resumeHandler = () => json({ thread, model: 'synthetic-resumed-model', reasoningEffort: 'high' });
    historyHandler = () => json(history);
    readHandler = () => json({ thread });
    statusHandler = () => json({ codex: 'ready', authenticated: true });
    recoveryHandler = () => json({ accepted: true }, 202);
    messageHandler = data => json({ turn: { id: 'synthetic-sent-turn', status: 'completed', items: [{ id: 'synthetic-user-message', type: 'userMessage', content: [{ type: 'text', text: data.text }] }] } });
    let uploadSequence = 0;
    uploadHandler = () => json({ id: `synthetic-attachment-${++uploadSequence}`, name: 'synthetic.png', mime: 'image/png', size: 20 });
    let created: typeof thread | undefined;
    let access = { authenticated: true, pairingRequired: false, paired: false };
    fetchMock = vi.fn(async (input: string, options?: RequestInit) => {
      if (input === '/api/auth') return json(access);
      if (input === '/api/status') return statusHandler();
      if (input === '/api/recovery') return recoveryHandler();
      if (input === '/api/settings/pairing') { access = { authenticated: true, paired: true, pairingRequired: !!JSON.parse(String(options?.body)).required }; return json(access); }
      if (input === '/api/projects') return json({ projects: [project] });
      if (input === '/api/models') return json({ data: [{ id: 'synthetic-default-model', model: 'synthetic-default-model', displayName: 'Synthetic default', isDefault: true, defaultReasoningEffort: 'medium', supportedReasoningEfforts: ['low', 'medium', 'high'].map(reasoningEffort => ({ reasoningEffort, description: 'Synthetic effort' })) }, { id: 'synthetic-fast-model', model: 'synthetic-fast-model', displayName: 'Synthetic fast', defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Synthetic fast effort' }] }] });
      if (input === '/api/requests') return json({ requests: [] });
      if (input.startsWith('/api/threads?')) return json({ data: [...(created ? [created] : []), thread], nextCursor: null });
      if (input === '/api/threads' && options?.method === 'POST') { created = { ...thread, id: 'synthetic-created-thread', name: '', preview: '' }; return json({ thread: created, sandbox: { type: 'readOnly' }, approvalPolicy: 'on-request', approvalsReviewer: 'user' }); }
      if (input.endsWith('/messages')) return messageHandler(JSON.parse(String(options?.body)), options);
      if (input.startsWith('/api/threads/synthetic-thread/turns?')) return historyHandler(input);
      if (input.startsWith('/api/threads/synthetic-thread?')) return readHandler();
      if (input === '/api/threads/synthetic-thread/resume') return resumeHandler();
      if (input.startsWith('/api/uploads?')) return uploadHandler();
      throw new Error('UNEXPECTED_SYNTHETIC_API_CALL');
    });
    vi.stubGlobal('fetch', fetchMock);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => { root.render(createElement(StrictMode, null, createElement(App))); });
    await settle();
    expect(container.textContent).toContain(thread.name);
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); });
    container.remove();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('lets a new conversation escape an unfinished history/resume request without stale updates locking the composer', async () => {
    const pendingHistory = deferred<Response>();
    const pendingResume = deferred<Response>();
    historyHandler = () => pendingHistory.promise;
    resumeHandler = () => pendingResume.promise;
    await click(button(thread.name));
    expect(container.textContent).toContain('正在讀取對話');
    await click(button('新增對話'));
    await draft('Synthetic new conversation draft');
    expect(sendButton().disabled).toBe(false);
    await act(async () => { pendingHistory.resolve(json(history)); pendingResume.resolve(json({ thread, model: 'synthetic-old-model' })); });
    await settle();
    expect(container.textContent).not.toContain('Synthetic readable conversation history.');
    expect(sendButton().disabled).toBe(false);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/messages'))).toBe(false);
  });

  it('shows readable history when resume fails and recovers only after an explicit retry', async () => {
    resumeHandler = () => json({ error: 'CODEX_RPC_ERROR' }, 500);
    await click(button(thread.name));
    expect(container.textContent).toContain('Synthetic readable conversation history.');
    expect(container.textContent).toContain('目前無法接續');
    await draft('Synthetic continuation draft');
    expect(sendButton().disabled).toBe(true);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/messages'))).toBe(false);
    resumeHandler = () => json({ thread, model: 'synthetic-resumed-model' });
    await click(button(thread.name));
    expect(container.textContent).not.toContain('目前無法接續');
    expect(container.querySelector<HTMLSelectElement>('select[aria-label="選擇模型"]')!.value).toBe('synthetic-resumed-model');
    expect(container.querySelector('textarea')!.value).toBe('Synthetic continuation draft');
    expect(sendButton().disabled).toBe(false);
  });

  it('rejects a nine-image batch before uploading any files', async () => {
    await chooseFiles(9);
    expect(container.textContent).toContain('每則訊息最多附加 8 張圖片');
    expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith('/api/uploads?'))).toBe(false);
  });
  it('creates a new conversation and sends its first message with the chosen reasoning effort', async () => {
    await click(button('新增對話'));
    expect(container.querySelector('.composer-caption')?.textContent).toContain('沿用 Codex 專案授權');
    await select('思考強度', 'high');
    await draft('Synthetic first message');
    await submit();
    const start = fetchMock.mock.calls.find(([url]) => url === '/api/threads')!;
    const sent = fetchMock.mock.calls.find(([url]) => url === '/api/threads/synthetic-created-thread/messages')!;
    expect(JSON.parse(String(start[1]?.body))).toMatchObject({ projectId: project.id, effort: 'high' });
    expect(JSON.parse(String(sent[1]?.body))).toMatchObject({ projectId: project.id, text: 'Synthetic first message', effort: 'high' });
    expect(container.querySelector('.user-message .user-bubble')?.textContent).toBe('Synthetic first message');
    expect(container.querySelector('textarea')!.value).toBe('');
    expect(container.querySelector('.composer-caption')?.textContent).toContain('唯讀 · 需要時核准');
  });
  it('shows effective resumed authorization and clears it when starting a different conversation', async () => {
    resumeHandler = () => json({ thread, sandbox: { type: 'workspaceWrite' }, approvalPolicy: 'on-request', approvalsReviewer: 'auto_review' });
    await click(button(thread.name));
    expect(container.querySelector('.composer-caption')?.textContent).toContain('工作區寫入 · 自動審核');
    await click(button('新增對話'));
    expect(container.querySelector('.composer-caption')?.textContent).toContain('沿用 Codex 專案授權');
    expect(container.querySelector('.composer-caption')?.textContent).not.toContain('自動審核');
  });
  it('shows native reviewer changes for the selected conversation without changing its draft or sending work', async () => {
    resumeHandler = () => json({ thread, sandbox: { type: 'workspaceWrite' }, approvalPolicy: 'on-request', approvalsReviewer: 'user' });
    await click(button(thread.name));
    await draft('Synthetic preserved reviewer draft');
    const socket = QuietSocket.instances.at(-1)!;
    await act(async () => { socket.emit('thread/settings/updated', { threadId: 'synthetic-other-thread', threadSettings: { sandboxPolicy: { type: 'workspaceWrite' }, approvalPolicy: 'on-request', approvalsReviewer: 'auto_review' } }, 1); });
    expect(container.querySelector('.composer-caption')?.textContent).toContain('需要時核准');
    await act(async () => { socket.emit('thread/settings/updated', { threadId: thread.id, threadSettings: { sandboxPolicy: { type: 'workspaceWrite' }, approvalPolicy: 'on-request', approvalsReviewer: 'auto_review' } }, 2); });
    expect(container.querySelector('.composer-caption')?.textContent).toContain('工作區寫入 · 自動審核');
    expect(container.querySelector('textarea')!.value).toBe('Synthetic preserved reviewer draft');
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/messages'))).toBe(false);
  });
  it('uses each model\'s supported efforts and preserves inherited effort when resuming', async () => {
    await select('思考強度', 'high');
    await select('選擇模型', 'synthetic-fast-model');
    const picker = container.querySelector<HTMLSelectElement>('select[aria-label="思考強度"]')!;
    expect(picker.value).toBe('low');
    expect([...picker.options].some(option => option.value === 'high')).toBe(false);
    await click(button(thread.name));
    expect(picker.value).toBe('');
    expect(picker.selectedOptions[0].textContent).toContain('高');
    await draft('Synthetic resumed message');
    await submit();
    const sent = fetchMock.mock.calls.find(([url]) => url === '/api/threads/synthetic-thread/messages')!;
    expect(JSON.parse(String(sent[1]?.body))).not.toHaveProperty('effort');
  });

  it('keeps writer-conflicted conversations readable and explains the owning-client restriction without sending work', async () => {
    resumeHandler = () => json({ error: 'THREAD_WRITER_CONFLICT' }, 409);
    await click(button(thread.name));
    expect(container.textContent).toContain('Synthetic readable conversation history.');
    expect(container.textContent).toContain('對話紀錄已載入。');
    expect(container.textContent).toContain('其他 Codex 客戶端開啟');
    expect(container.textContent).toContain('原客戶端釋放後');
    expect(container.textContent).not.toContain('目前無法接續');
    await draft('Synthetic draft retained while another client owns the writer');
    expect(sendButton().disabled).toBe(true);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/messages'))).toBe(false);
  });

  it('guards overlapping uploads synchronously while preserving the already accepted batch', async () => {
    const firstUpload = deferred<Response>();
    let calls = 0;
    uploadHandler = () => ++calls === 1 ? firstUpload.promise : json({ id: 'synthetic-attachment-second', name: 'second.png', mime: 'image/png', size: 20 });
    await chooseFiles(2);
    await chooseFiles(7);
    expect(container.textContent).toContain('圖片仍在上傳');
    expect(calls).toBe(1);
    await act(async () => { firstUpload.resolve(json({ id: 'synthetic-attachment-first', name: 'first.png', mime: 'image/png', size: 20 })); });
    await settle();
    expect(calls).toBe(2);
    expect(container.querySelectorAll('.attachment-chip')).toHaveLength(2);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/messages'))).toBe(false);
  });

  it('restores the selected conversation after a refresh using only navigation identifiers', async () => {
    await click(button(thread.name));
    expect(new URLSearchParams(location.hash.slice(1)).get('thread')).toBe(thread.id);
    expect(location.hash).not.toContain('Synthetic readable');
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    await act(async () => { root.render(createElement(App)); });
    await settle();
    expect(container.textContent).toContain('Synthetic readable conversation history.');
    expect(container.querySelector('.session-row.active')?.textContent).toContain(thread.name);
    expect(container.querySelector('.breadcrumb-thread')?.textContent).toBe(thread.name);
    await click(button('新增對話'));
    expect(new URLSearchParams(location.hash.slice(1)).has('thread')).toBe(false);
  });

  it('restores a saved conversation even when it is outside the first page of the thread list', async () => {
    await click(button(thread.name));
    const original = fetchMock.getMockImplementation() as (input: string, options?: RequestInit) => Promise<Response>;
    fetchMock.mockImplementation((input: string, options?: RequestInit) => input.startsWith('/api/threads?') ? Promise.resolve(json({ data: [], nextCursor: 'synthetic-next-page' })) : original(input, options));
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    await act(async () => { root.render(createElement(App)); });
    await settle();
    expect(container.textContent).toContain('Synthetic readable conversation history.');
    expect(container.querySelector('.session-row.active')?.textContent).toContain(thread.name);
    expect(container.querySelector('.breadcrumb-thread')?.textContent).toBe(thread.name);
    await draft('Synthetic continuation');
    expect(sendButton().disabled).toBe(false);
  });

  it('loads six recent turns and loads one older page on reaching the top while preserving the viewport', async () => {
    const oldPage = deferred<Response>();
    const makeTurns = (from: number) => Array.from({ length: 6 }, (_, index) => ({ id: `synthetic-turn-${from - index}`, status: 'completed', items: [{ id: `synthetic-message-${from - index}`, type: 'agentMessage', text: `Synthetic message ${from - index}` }] }));
    historyHandler = url => new URL(url, 'http://synthetic.test').searchParams.has('cursor') ? oldPage.promise : json({ data: makeTurns(12), nextCursor: 'synthetic-older-page' });
    await click(button(thread.name));
    expect(container.querySelectorAll('.turn')).toHaveLength(6);
    expect(fetchMock.mock.calls.find(([url]) => String(url).includes('/turns?'))?.[0]).toContain('limit=6');
    const scroll = container.querySelector<HTMLDivElement>('.conversation-scroll')!;
    Object.defineProperty(scroll, 'clientHeight', { configurable: true, value: 500 });
    Object.defineProperty(scroll, 'scrollHeight', { configurable: true, get: () => container.querySelectorAll('.turn').length * 300 });
    scroll.scrollTop = 20;
    await act(async () => { scroll.dispatchEvent(new Event('scroll')); scroll.dispatchEvent(new Event('scroll')); });
    await settle();
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('cursor=synthetic-older-page'))).toHaveLength(1);
    await act(async () => { oldPage.resolve(json({ data: makeTurns(6), nextCursor: null })); });
    await settle();
    expect(container.querySelectorAll('.turn')).toHaveLength(12);
    expect(scroll.scrollTop).toBe(1820);
    expect([...container.querySelectorAll('.turn .markdown')].map(entry => entry.textContent)).toEqual(Array.from({ length: 12 }, (_, index) => `Synthetic message ${index + 1}`));
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await settle();
    expect(container.querySelectorAll('.turn')).toHaveLength(12);
    expect(container.querySelector('.history-button')).toBeNull();
    expect(container.querySelector('.turn .markdown')?.textContent).toBe('Synthetic message 1');
  });

  it('renders stream output and completion on the same conversation without changing pages', async () => {
    await click(button(thread.name));
    const socket = QuietSocket.instances.at(-1)!;
    await act(async () => {
      socket.emit('turn/started', { threadId: thread.id, turn: { id: 'synthetic-live-turn', status: 'inProgress', items: [] } }, 1);
      socket.emit('item/agentMessage/delta', { threadId: thread.id, turnId: 'synthetic-live-turn', itemId: 'synthetic-live-message', delta: 'Synthetic live ' }, 2);
      socket.emit('item/agentMessage/delta', { threadId: thread.id, turnId: 'synthetic-live-turn', itemId: 'synthetic-live-message', delta: 'response' }, 3);
    });
    await settle();
    expect(container.textContent).toContain('Synthetic live response');
    expect(container.querySelector('button[aria-label="停止工作"]')).not.toBeNull();
    await act(async () => { socket.emit('turn/completed', { threadId: thread.id, turn: { id: 'synthetic-live-turn', status: 'completed', items: [] } }, 4); });
    await settle();
    await draft('Synthetic next message');
    expect(sendButton().disabled).toBe(false);
    expect(container.textContent).toContain('Synthetic live response');
  });

  it('repairs a missed completion with a read-only poll and never resends the prompt', async () => {
    vi.useFakeTimers();
    await click(button(thread.name));
    messageHandler = () => json({ turn: { id: 'synthetic-sent-turn', status: 'inProgress', items: [] } });
    await draft('Synthetic accepted prompt');
    await submit();
    expect(container.querySelector('button[aria-label="停止工作"]')).not.toBeNull();
    historyHandler = () => json({ data: [{ id: 'synthetic-sent-turn', status: 'completed', items: [{ id: 'synthetic-polled-message', type: 'agentMessage', text: 'Synthetic recovered response' }] }], nextCursor: null });
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    await settle();
    expect(container.textContent).toContain('Synthetic recovered response');
    await draft('Synthetic next prompt');
    expect(sendButton().disabled).toBe(false);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/messages'))).toHaveLength(1);
  });

  it('replaces a half-open event socket when the browser returns to the foreground', async () => {
    await click(button(thread.name));
    const previous = QuietSocket.instances.at(-1)!;
    const count = QuietSocket.instances.length;
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await settle();
    expect(QuietSocket.instances).toHaveLength(count + 1);
    expect(previous.onmessage).toBeNull();
    expect(container.textContent).toContain('Synthetic readable conversation history.');
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/messages'))).toBe(false);
  });

  it('reconciles an active turn outside the recent page only after canonical idle is confirmed', async () => {
    vi.useFakeTimers();
    await click(button(thread.name));
    await act(async () => { QuietSocket.instances.at(-1)!.emit('turn/started', { threadId: thread.id, turn: { id: 'synthetic-old-active', status: 'inProgress', items: [] } }, 1); });
    historyHandler = () => json({ data: Array.from({ length: 6 }, (_, index) => ({ id: `synthetic-later-${index}`, status: 'completed', items: [] })), nextCursor: 'synthetic-older' });
    readHandler = () => json({ thread: { ...thread, status: { type: 'active' } } });
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    await settle();
    expect(container.querySelector('button[aria-label="停止工作"]')).not.toBeNull();
    readHandler = () => json({ thread });
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    await settle();
    await draft('Synthetic continuation after canonical reconciliation');
    expect(sendButton().disabled).toBe(false);
    expect(container.textContent).not.toContain('工作已中斷');
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/messages'))).toBe(false);
  });

  it('does not remain busy when persisted recent history says active but canonical state is idle', async () => {
    historyHandler = () => json({ data: [{ id: 'synthetic-stale-active', status: 'inProgress', items: [{ id: 'synthetic-partial-output', type: 'agentMessage', text: 'Synthetic persisted partial output' }] }], nextCursor: null });
    readHandler = () => json({ thread });
    await click(button(thread.name));
    await draft('Synthetic draft after reconnect');
    expect(sendButton().disabled).toBe(false);
    expect(container.textContent).toContain('Synthetic persisted partial output');
    expect(container.textContent).not.toContain('工作已中斷');
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/messages'))).toBe(false);
  });

  it('keeps loaded sidebar pages and their cursor through background refresh and rejects stale list responses', async () => {
    const original = fetchMock.getMockImplementation() as (input: string, options?: RequestInit) => Promise<Response>;
    const older = { ...thread, id: 'synthetic-older-thread', name: 'Synthetic older sidebar entry' };
    let pending: Promise<Response> | undefined;
    let latest = { ...thread };
    fetchMock.mockImplementation((input: string, options?: RequestInit) => {
      if (!input.startsWith('/api/threads?')) return original(input, options);
      const cursor = new URL(input, 'http://synthetic.test').searchParams.get('cursor');
      if (cursor) return Promise.resolve(json({ data: [older], nextCursor: cursor === 'synthetic-page-one' ? 'synthetic-page-two' : null }));
      const response = pending;
      pending = undefined;
      return response || Promise.resolve(json({ data: [latest], nextCursor: 'synthetic-page-one' }));
    });
    const refresh = () => container.querySelector('button[aria-label="重新整理對話"]')!;
    await click(refresh());
    await click(button('載入更早的對話'));
    expect(container.textContent).toContain(older.name);
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await settle();
    expect(container.textContent).toContain(older.name);
    await click(button('載入更早的對話'));
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('cursor=synthetic-page-two'))).toBe(true);
    const stale = deferred<Response>();
    pending = stale.promise;
    await click(refresh());
    latest = { ...thread, name: 'Synthetic latest sidebar name' };
    await click(refresh());
    await act(async () => { stale.resolve(json({ data: [thread], nextCursor: 'synthetic-stale-cursor' })); });
    await settle();
    expect(container.textContent).toContain(latest.name);
    expect(container.textContent).not.toContain(thread.name);
    expect(container.textContent).toContain(older.name);
    expect(container.querySelector('button.load-more')).toBeNull();
  });

  it('keeps pairing changes behind settings, a category and confirmation in both directions', async () => {
    expect(document.querySelector('input[role="switch"]')).toBeNull();
    await click(container.querySelector('.access-settings-trigger')!);
    expect(document.querySelector('input[role="switch"]')).toBeNull();
    await click(settingsButton('裝置存取'));
    await act(async () => { document.querySelector<HTMLInputElement>('input[role="switch"]')!.click(); });
    expect(fetchMock.mock.calls.some(([url]) => url === '/api/settings/pairing')).toBe(false);
    await click(settingsButton('確認開啟配對'));
    expect(JSON.parse(String(fetchMock.mock.calls.find(([url]) => url === '/api/settings/pairing')![1]?.body))).toEqual({ required: true });
    await act(async () => { document.querySelector<HTMLInputElement>('input[role="switch"]')!.click(); });
    expect(fetchMock.mock.calls.filter(([url]) => url === '/api/settings/pairing')).toHaveLength(1);
    await click(settingsButton('確認關閉配對'));
    expect(JSON.parse(String(fetchMock.mock.calls.filter(([url]) => url === '/api/settings/pairing').at(-1)![1]?.body))).toEqual({ required: false });
  });

  it('reconnects the webpage without reloading, losing its draft or invoking emergency recovery', async () => {
    await click(button(thread.name));
    await draft('Synthetic draft kept through reconnect');
    const count = QuietSocket.instances.length;
    await click(container.querySelector('.access-settings-trigger')!);
    await click(settingsButton('連線修復'));
    await click(settingsButton('重新連接網頁'));
    expect(QuietSocket.instances).toHaveLength(count + 1);
    expect(container.querySelector('textarea')!.value).toBe('Synthetic draft kept through reconnect');
    expect(fetchMock.mock.calls.some(([url]) => url === '/api/recovery' || String(url).endsWith('/messages'))).toBe(false);
  });

  it('confirms emergency recovery, waits for its status cycle and resumes without replaying a prompt', async () => {
    resumeHandler = () => json({ error: 'THREAD_WRITER_CONFLICT' }, 409);
    await click(button(thread.name));
    await draft('Synthetic draft retained after recovery');
    expect(sendButton().disabled).toBe(true);
    await click(container.querySelector('.access-settings-trigger')!);
    await click(settingsButton('連線修復'));
    await click(settingsButton('中斷所有工作並重建連線'));
    expect(fetchMock.mock.calls.some(([url]) => url === '/api/recovery')).toBe(false);
    await click(settingsButton('中斷所有工作並重建連線'));
    expect(JSON.parse(String(fetchMock.mock.calls.find(([url]) => url === '/api/recovery')![1]?.body))).toEqual({ confirm: true });
    expect(document.body.textContent).toContain('正在重建服務連線');
    await act(async () => { QuietSocket.instances.at(-1)!.emit('pocketagent/status', { status: { codex: 'ready', authenticated: true } }, 0); });
    await settle();
    expect(document.body.textContent).toContain('正在重建服務連線');
    resumeHandler = () => json({ thread, model: 'synthetic-resumed-model', reasoningEffort: 'high' });
    await act(async () => {
      QuietSocket.instances.at(-1)!.emit('pocketagent/status', { status: { codex: 'starting' } }, 0);
      QuietSocket.instances.at(-1)!.emit('pocketagent/status', { status: { codex: 'ready', authenticated: true } }, 0);
    });
    await settle();
    expect(document.body.textContent).not.toContain('正在重建服務連線');
    expect(container.querySelector('textarea')!.value).toBe('Synthetic draft retained after recovery');
    expect(sendButton().disabled).toBe(false);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/resume'))).toHaveLength(2);
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/messages'))).toBe(false);
  });

  it('permits a manually confirmed retry after recovery times out without a service status transition', async () => {
    vi.useFakeTimers();
    await click(container.querySelector('.access-settings-trigger')!);
    await click(settingsButton('連線修復'));
    await click(settingsButton('中斷所有工作並重建連線'));
    await click(settingsButton('中斷所有工作並重建連線'));
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    await settle();
    expect(document.body.textContent).not.toContain('正在重建服務連線');
    expect(container.textContent).toContain('恢復尚未確認完成');
    expect(settingsButton('中斷所有工作並重建連線').disabled).toBe(false);
    await click(settingsButton('中斷所有工作並重建連線'));
    expect(fetchMock.mock.calls.filter(([url]) => url === '/api/recovery')).toHaveLength(1);
    await click(settingsButton('中斷所有工作並重建連線'));
    expect(fetchMock.mock.calls.filter(([url]) => url === '/api/recovery')).toHaveLength(2);
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/messages'))).toBe(false);
  });

  it('keeps a recovered conversation read-only when another client still owns its writer', async () => {
    resumeHandler = () => json({ error: 'THREAD_WRITER_CONFLICT' }, 409);
    await click(button(thread.name));
    await draft('Synthetic writer-conflicted draft');
    await click(container.querySelector('.access-settings-trigger')!);
    await click(settingsButton('連線修復'));
    await click(settingsButton('中斷所有工作並重建連線'));
    await click(settingsButton('中斷所有工作並重建連線'));
    await act(async () => {
      QuietSocket.instances.at(-1)!.emit('pocketagent/status', { status: { codex: 'starting' } }, 0);
      QuietSocket.instances.at(-1)!.emit('pocketagent/status', { status: { codex: 'ready', authenticated: true } }, 0);
    });
    await settle();
    expect(document.body.textContent).not.toContain('正在重建服務連線');
    expect(container.querySelector('textarea')!.value).toBe('Synthetic writer-conflicted draft');
    expect(container.textContent).toContain('其他 Codex 客戶端開啟');
    expect(sendButton().disabled).toBe(true);
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/messages'))).toBe(false);
  });

  it('retries a transient resume failure after ready and a webpage reconnect without replaying the draft', async () => {
    resumeHandler = () => json({ error: 'CODEX_OFFLINE' }, 503);
    await click(button(thread.name));
    await draft('Synthetic draft across proxy restart');
    expect(sendButton().disabled).toBe(true);
    resumeHandler = () => json({ thread, model: 'synthetic-resumed-model' });
    await act(async () => {
      const socket = QuietSocket.instances.at(-1)!;
      socket.emit('pocketagent/status', { status: { codex: 'offline' } }, 1);
      socket.emit('pocketagent/reset', {}, 0);
      socket.emit('pocketagent/status', { status: { codex: 'ready', authenticated: true } }, 2);
      window.dispatchEvent(new Event('pocketagent:reconnect'));
    });
    await settle();
    expect(sendButton().disabled).toBe(false);
    expect(container.querySelector('textarea')!.value).toBe('Synthetic draft across proxy restart');
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/resume'))).toHaveLength(2);
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/messages'))).toBe(false);
  });

  it('resumes once for a new worker generation even when its sequence is lower than the old cursor', async () => {
    statusHandler = () => json({ codex: 'ready', authenticated: true, generation: 'synthetic-worker-before' });
    await act(async () => { QuietSocket.instances.at(-1)!.emit('pocketagent/status', { status: { codex: 'ready', authenticated: true, generation: 'synthetic-worker-before' } }, 900); });
    await click(button(thread.name));
    await draft('Synthetic draft across worker restart');
    const resumed = deferred<Response>();
    resumeHandler = () => resumed.promise;
    statusHandler = () => json({ codex: 'ready', authenticated: true, generation: 'synthetic-worker-after' });
    await act(async () => {
      QuietSocket.instances.at(-1)!.emit('pocketagent/status', { status: { codex: 'ready', authenticated: true, generation: 'synthetic-worker-after' } }, 1);
      window.dispatchEvent(new Event('pocketagent:reconnect'));
    });
    await settle();
    expect(sendButton().disabled).toBe(true);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/resume'))).toHaveLength(2);
    expect(QuietSocket.instances.at(-1)!.url).toContain('generation=synthetic-worker-after');
    expect(QuietSocket.instances.at(-1)!.url).not.toContain('after=900');
    await act(async () => { resumed.resolve(json({ thread, model: 'synthetic-resumed-model' })); });
    await settle();
    expect(sendButton().disabled).toBe(false);
    await act(async () => {
      const socket = QuietSocket.instances.at(-1)!;
      socket.emit('item/agentMessage/delta', { threadId: thread.id, turnId: 'synthetic-new-worker-turn', itemId: 'synthetic-new-worker-output', delta: 'Synthetic new generation output' }, 2);
      socket.emit('turn/completed', { threadId: thread.id, turn: { id: 'synthetic-new-worker-turn', status: 'completed', items: [] } }, 3);
    });
    await settle();
    expect(container.textContent).toContain('Synthetic new generation output');
    expect(container.querySelector('textarea')!.value).toBe('Synthetic draft across worker restart');
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/messages'))).toBe(false);
  });

  it('keeps an already attached thread across an HTTP reconnect to the same worker', async () => {
    statusHandler = () => json({ codex: 'ready', authenticated: true, generation: 'synthetic-stable-worker' });
    await act(async () => { QuietSocket.instances.at(-1)!.emit('pocketagent/status', { status: { codex: 'ready', authenticated: true, generation: 'synthetic-stable-worker' } }, 100); });
    await click(button(thread.name));
    await draft('Synthetic draft with durable worker');
    await act(async () => { window.dispatchEvent(new Event('pocketagent:reconnect')); });
    await settle();
    expect(QuietSocket.instances.at(-1)!.url).toContain('after=100');
    expect(QuietSocket.instances.at(-1)!.url).toContain('generation=synthetic-stable-worker');
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/resume'))).toHaveLength(1);
    expect(container.querySelector('textarea')!.value).toBe('Synthetic draft with durable worker');
    expect(sendButton().disabled).toBe(false);
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/messages'))).toBe(false);
  });

  it('does not repeatedly retry a writer conflict when reconnecting to the same worker', async () => {
    resumeHandler = () => json({ error: 'THREAD_WRITER_CONFLICT' }, 409);
    await click(button(thread.name));
    await draft('Synthetic writer-owned draft');
    for (let index = 0; index < 2; index++) {
      await act(async () => { window.dispatchEvent(new Event('pocketagent:reconnect')); });
      await settle();
    }
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/resume'))).toHaveLength(1);
    expect(sendButton().disabled).toBe(true);
    expect(container.textContent).toContain('其他 Codex 客戶端開啟');
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/messages'))).toBe(false);
  });

  it('finishes confirmed recovery when generation changes even if the intermediate status was missed', async () => {
    await act(async () => { QuietSocket.instances.at(-1)!.emit('pocketagent/status', { status: { codex: 'ready', authenticated: true, generation: 'synthetic-before-recovery' } }, 1); });
    await click(button(thread.name));
    await draft('Synthetic draft during fast recovery');
    await click(container.querySelector('.access-settings-trigger')!);
    await click(settingsButton('連線修復'));
    await click(settingsButton('中斷所有工作並重建連線'));
    await click(settingsButton('中斷所有工作並重建連線'));
    await act(async () => { QuietSocket.instances.at(-1)!.emit('pocketagent/status', { status: { codex: 'ready', authenticated: true, generation: 'synthetic-after-recovery' } }, 1); });
    await settle();
    expect(document.body.textContent).not.toContain('正在重建服務連線');
    expect(sendButton().disabled).toBe(false);
    expect(container.querySelector('textarea')!.value).toBe('Synthetic draft during fast recovery');
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/resume'))).toHaveLength(2);
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/messages'))).toBe(false);
  });

  it('preserves the submission identity and draft on an ambiguous send timeout without automatic replay', async () => {
    await click(button(thread.name));
    await draft('Synthetic prompt with an ambiguous response');
    const timeout = new AbortController();
    const signal = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal);
    messageHandler = (_data, options) => new Promise<Response>((_resolve, reject) => options!.signal!.addEventListener('abort', () => reject(options!.signal!.reason), { once: true }));
    await submit();
    await act(async () => { timeout.abort(); });
    await settle();
    expect(container.querySelector('textarea')!.value).toBe('Synthetic prompt with an ambiguous response');
    expect(container.textContent).toContain('訊息可能已送達');
    const first = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/messages'))!;
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/messages'))).toHaveLength(1);
    signal.mockRestore();
    messageHandler = () => json({ turn: { id: 'synthetic-confirmed-turn', status: 'completed', items: [] } });
    await submit();
    const second = fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/messages')).at(-1)!;
    expect(JSON.parse(String(first[1]?.body)).requestId).toBe(JSON.parse(String(second[1]?.body)).requestId);
  });
});
