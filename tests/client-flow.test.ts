// @vitest-environment happy-dom

import { act, createElement } from 'react';
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
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  constructor() { queueMicrotask(() => this.onopen?.()); }
  close() { /* Test sockets never connect to the network. */ }
}

describe('conversation UI recovery with synthetic Codex responses', () => {
  let container: HTMLDivElement;
  let root: Root;
  let fetchMock: ReturnType<typeof vi.fn>;
  let resumeHandler: () => Response | Promise<Response>;
  let historyHandler: () => Response | Promise<Response>;
  let uploadHandler: () => Response | Promise<Response>;

  const settle = async () => { for (let index = 0; index < 5; index++) await act(async () => { await Promise.resolve(); }); };
  const button = (label: string) => {
    const element = Array.from(container.querySelectorAll('button')).find(entry => entry.textContent?.includes(label));
    if (!element) throw new Error('SYNTHETIC_BUTTON_NOT_FOUND');
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
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('WebSocket', QuietSocket);
    HTMLElement.prototype.scrollIntoView = vi.fn();
    resumeHandler = () => json({ thread, model: 'synthetic-resumed-model', reasoningEffort: 'high' });
    historyHandler = () => json(history);
    let uploadSequence = 0;
    uploadHandler = () => json({ id: `synthetic-attachment-${++uploadSequence}`, name: 'synthetic.png', mime: 'image/png', size: 20 });
    let created: typeof thread | undefined;
    fetchMock = vi.fn(async (input: string, options?: RequestInit) => {
      if (input === '/api/auth') return json({ authenticated: true, pairingRequired: false, paired: false });
      if (input === '/api/status') return json({ codex: 'ready', authenticated: true });
      if (input === '/api/projects') return json({ projects: [project] });
      if (input === '/api/models') return json({ data: [{ id: 'synthetic-default-model', model: 'synthetic-default-model', displayName: 'Synthetic default', isDefault: true, defaultReasoningEffort: 'medium', supportedReasoningEfforts: ['low', 'medium', 'high'].map(reasoningEffort => ({ reasoningEffort, description: 'Synthetic effort' })) }, { id: 'synthetic-fast-model', model: 'synthetic-fast-model', displayName: 'Synthetic fast', defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Synthetic fast effort' }] }] });
      if (input === '/api/requests') return json({ requests: [] });
      if (input.startsWith('/api/threads?')) return json({ data: [...(created ? [created] : []), thread], nextCursor: null });
      if (input === '/api/threads' && options?.method === 'POST') { created = { ...thread, id: 'synthetic-created-thread', name: '', preview: '' }; return json({ thread: created }); }
      if (input.endsWith('/messages')) { const data = JSON.parse(String(options?.body)); return json({ turn: { id: 'synthetic-sent-turn', status: 'completed', items: [{ id: 'synthetic-user-message', type: 'userMessage', content: [{ type: 'text', text: data.text }] }] } }); }
      if (input.startsWith('/api/threads/synthetic-thread/turns?')) return historyHandler();
      if (input === '/api/threads/synthetic-thread/resume') return resumeHandler();
      if (input.startsWith('/api/uploads?')) return uploadHandler();
      throw new Error('UNEXPECTED_SYNTHETIC_API_CALL');
    });
    vi.stubGlobal('fetch', fetchMock);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => { root.render(createElement(App)); });
    await settle();
    expect(container.textContent).toContain(thread.name);
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); });
    container.remove();
    vi.unstubAllGlobals();
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
    await select('思考強度', 'high');
    await draft('Synthetic first message');
    await submit();
    const start = fetchMock.mock.calls.find(([url]) => url === '/api/threads')!;
    const sent = fetchMock.mock.calls.find(([url]) => url === '/api/threads/synthetic-created-thread/messages')!;
    expect(JSON.parse(String(start[1]?.body))).toMatchObject({ projectId: project.id, effort: 'high' });
    expect(JSON.parse(String(sent[1]?.body))).toMatchObject({ projectId: project.id, text: 'Synthetic first message', effort: 'high' });
    expect(container.querySelector('.user-message .user-bubble')?.textContent).toBe('Synthetic first message');
    expect(container.querySelector('textarea')!.value).toBe('');
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
});
