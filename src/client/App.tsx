import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { AppEvent, Attachment, AuthState, FileEntry, Model, PendingRequest, Project, ServiceStatus, Thread, ThreadItem, Turn } from '../shared/types';

type Json = Record<string, unknown>;
type IconName = 'plus' | 'chat' | 'folder' | 'file' | 'arrow' | 'chevron' | 'close' | 'menu' | 'image' | 'stop' | 'check' | 'shield' | 'logout' | 'terminal' | 'edit' | 'refresh' | 'back' | 'code' | 'link' | 'dots';

function Icon({ name, size = 18, className = '' }: { name: IconName; size?: number; className?: string }) {
  const paths: Record<IconName, ReactNode> = {
    plus: <path d="M12 5v14M5 12h14" />,
    chat: <path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-1 1V11.5a8.5 8.5 0 1 1 18 0Z" />,
    folder: <path d="M3 7V5a1 1 0 0 1 1-1h6l2 3h8a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7Z" />,
    file: <><path d="M14 3H5v18h14V8l-5-5Z" /><path d="M14 3v6h5M8 13h8M8 17h6" /></>,
    arrow: <path d="M12 19V5m-6 6 6-6 6 6" />,
    chevron: <path d="m9 5 7 7-7 7" />,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    menu: <path d="M4 6h16M4 12h16M4 18h16" />,
    image: <><rect x="3" y="3" width="18" height="18" rx="3" /><circle cx="8" cy="8" r="1.5" /><path d="m3 17 5-5 4 4 4-6 5 7" /></>,
    stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
    check: <path d="m5 12 4 4L19 6" />,
    shield: <><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z" /><path d="m8 12 3 3 5-6" /></>,
    logout: <><path d="M9 4H4v16h5M9 12h12m-4-4 4 4-4 4" /></>,
    terminal: <><rect x="3" y="4" width="18" height="16" rx="3" /><path d="m7 8 4 4-4 4m6 0h4" /></>,
    edit: <><path d="m15 4 5 5M4 20l5-1L21 7l-5-5L4 14v6Z" /></>,
    refresh: <><path d="M20 8a8 8 0 1 0 0 8M20 3v5h-5" /></>,
    back: <path d="m14 5-7 7 7 7" />,
    code: <path d="m8 5-6 7 6 7m8-14 6 7-6 7m-3-16-2 18" />,
    link: <><path d="m10 14 4-4m-7 6-1 1a3 3 0 0 1-4-4l5-5a3 3 0 0 1 4 0m2 0 1-1a3 3 0 0 1 4 4l-5 5a3 3 0 0 1-4 0" /></>,
    dots: <><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>{paths[name]}</svg>;
}

function Mark({ small = false }: { small?: boolean }) {
  return <span className={`brand-mark ${small ? 'small' : ''}`}><Icon name="code" size={small ? 18 : 24} /></span>;
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body && !(options.body instanceof FormData)) headers.set('Content-Type', 'application/json');
  const response = await fetch(`/api${path}`, { ...options, headers, credentials: 'same-origin' });
  const data = await response.json().catch(() => ({})) as Json;
  if (!response.ok) {
    if (response.status === 401 && path !== '/auth/pair' && typeof window !== 'undefined') window.dispatchEvent(new Event('pocketagent:reauth'));
    throw new Error(typeof data.message === 'string' ? data.message : typeof data.error === 'string' ? data.error : `連線失敗（${response.status}）`);
  }
  return data as T;
}
const body = (value: unknown): string => JSON.stringify(value);
const object = (value: unknown): Json => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
const string = (value: unknown): string => typeof value === 'string' ? value : '';
const errorMessages: Record<string, string> = {
  REQUEST_ALREADY_SUBMITTED: '這則訊息可能已送出。請先查看對話紀錄，確認後再編輯或建立新訊息。',
  THREAD_BUSY: '這個對話仍有工作正在執行。請等待完成，或先停止目前的工作。',
  CODEX_OFFLINE: 'Codex 目前未連線。請在電腦上確認 CLI 狀態，再重新連線。',
  THREAD_RESUME_FAILED: '已載入可讀取的對話紀錄，但目前無法接續。請重新選取這個對話再試一次。',
  THREAD_WRITER_CONFLICT: '這個對話目前由其他 Codex 客戶端開啟，暫時只能檢視；原客戶端釋放後，再重新選取以接續。',
  INVALID_ATTACHMENTS: '每則訊息最多附加 8 張圖片。',
  UNSUPPORTED_REASONING_EFFORT: '目前模型不支援這個思考強度，請重新選擇。',
  THREAD_NOT_IN_PROJECT: '對話的專案歸屬不符，請重新選取專案與對話。',
  REQUEST_ID_CONFLICT: '這則訊息與先前送出的內容不一致。請確認內容並編輯後重新傳送。',
  PAIRING_CODE_INVALID_OR_EXPIRED: '配對碼無效或已過期。請在電腦執行 npm run pair 取得新碼。',
  PAIRING_CODE_FORMAT_INVALID: '配對碼必須是 8 位數字，請確認後再試一次。',
  DEVICE_NAME_INVALID: '請輸入有效的裝置名稱，不能只包含空白。',
  AUTHENTICATION_REQUIRED: '這個裝置需要配對，請輸入配對碼以接續工作。',
  HOST_NOT_ALLOWED: '這個服務位址未獲允許。請使用已設定的區網或 Tailscale IP 開啟網頁。',
  ORIGIN_REQUIRED: '請直接使用 PocketAgent 的服務位址開啟網頁，再重新操作。',
  ORIGIN_NOT_ALLOWED: '這個網頁來源未獲允許。請直接使用 PocketAgent 的服務位址。',
};
export const errorText = (value: unknown): string => value instanceof Error ? errorMessages[value.message] || value.message : '操作未完成，請再試一次。';

// getRandomValues works on HTTP private-network origins; randomUUID may require HTTPS.
function uniqueId() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function dateLabel(seconds: number) {
  if (!Number.isFinite(seconds)) return '';
  const date = new Date(seconds * 1000);
  const now = new Date();
  return date.toDateString() === now.toDateString()
    ? date.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false })
    : date.toLocaleDateString('zh-TW', { month: 'numeric', day: 'numeric' });
}

export function ModelOptions({ models, model }: { models: Model[]; model: string }) {
  return <>
    {model && !models.some(entry => entry.model === model) ? <option value={model}>{model}（目前對話）</option> : null}
    {!model ? <option value="">{models.length ? '沿用對話模型' : '預設模型'}</option> : null}
    {models.map(entry => <option value={entry.model} key={entry.id}>{entry.displayName || entry.model}</option>)}
  </>;
}

const effortLabel = (effort: string) => ({ none: '關閉', minimal: '最少', low: '低', medium: '中', high: '高', xhigh: '非常高', max: '最高', ultra: 'Ultra' }[effort] || effort);
export function ReasoningOptions({ model, inherited }: { model?: Model; inherited: string }) {
  return <><option value="">沿用設定{inherited ? `（${effortLabel(inherited)}）` : ''}</option>{model?.supportedReasoningEfforts?.map(option => <option key={option.reasoningEffort} value={option.reasoningEffort} title={option.description}>{effortLabel(option.reasoningEffort)}</option>)}</>;
}

const terminalStatus = (status: string) => ['completed', 'failed', 'interrupted'].includes(status);

function mergeItem(existing: ThreadItem, incoming: ThreadItem): ThreadItem {
  const merged = { ...existing, ...incoming };
  for (const field of ['text', 'aggregatedOutput']) {
    if (string(existing[field]).length > string(incoming[field]).length) merged[field] = existing[field];
  }
  if (terminalStatus(string(existing.status)) && !terminalStatus(string(incoming.status))) merged.status = existing.status;
  return merged;
}

export function mergeTurn(turns: Turn[], incoming: Turn): Turn[] {
  const existing = turns.find((turn) => turn.id === incoming.id);
  if (!existing) return [...turns, { ...incoming, items: incoming.items ?? [] }];
  const items = [...existing.items];
  for (const item of incoming.items ?? []) {
    const index = items.findIndex((entry) => entry.id === item.id);
    if (index < 0) items.push(item); else items[index] = mergeItem(items[index], item);
  }
  return turns.map((turn) => turn.id === incoming.id ? { ...turn, ...incoming, status: terminalStatus(turn.status) && !terminalStatus(incoming.status) ? turn.status : incoming.status, items } : turn);
}

// History can overlap live events received while the HTTP request was in flight.
export function mergeHistory(snapshot: Turn[], live: Turn[]): Turn[] {
  return live.reduce((merged, turn) => mergeTurn(merged, turn), snapshot);
}

export function applyThreadEvent(turns: Turn[], event: AppEvent): Turn[] {
  const params = event.params;
  if (event.method === 'turn/started' || event.method === 'turn/completed') {
    const turn = object(params.turn);
    if (!string(turn.id)) return turns;
    return mergeTurn(turns, { ...turn, id: string(turn.id), status: string(turn.status) || (event.method === 'turn/started' ? 'inProgress' : 'completed'), items: Array.isArray(turn.items) ? turn.items as ThreadItem[] : [] } as Turn);
  }
  const turnId = string(params.turnId);
  if (!turnId) return turns;
  let next = turns.some((turn) => turn.id === turnId) ? turns : [...turns, { id: turnId, status: 'inProgress', items: [] }];
  if (event.method === 'item/started' || event.method === 'item/completed') {
    const item = object(params.item) as ThreadItem;
    if (!item.id) return next;
    return next.map((turn) => turn.id !== turnId ? turn : { ...turn, items: turn.items.some((entry) => entry.id === item.id) ? turn.items.map((entry) => entry.id === item.id ? { ...entry, ...item } : entry) : [...turn.items, item] });
  }
  const itemId = string(params.itemId);
  const delta = string(params.delta);
  if (!itemId || !delta) return next;
  if (event.method === 'item/agentMessage/delta' || event.method === 'item/commandExecution/outputDelta' || event.method === 'item/plan/delta') {
    const field = event.method.includes('commandExecution') ? 'aggregatedOutput' : 'text';
    const type = event.method.includes('commandExecution') ? 'commandExecution' : event.method.includes('/plan/') ? 'plan' : 'agentMessage';
    next = next.map((turn) => {
      if (turn.id !== turnId) return turn;
      const existing = turn.items.find((item) => item.id === itemId);
      return { ...turn, items: existing ? turn.items.map((item) => item.id === itemId ? { ...item, [field]: string(item[field]) + delta } : item) : [...turn.items, { id: itemId, type, [field]: delta }] };
    });
  }
  return next;
}

function Markdown({ text }: { text: string }) {
  return <div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{
    a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
    img: ({ alt }) => <span className="blocked-image"><Icon name="image" size={14} />{alt || '外部圖片'}（未自動載入）</span>,
  }}>{text}</ReactMarkdown></div>;
}

function MessageItem({ item }: { item: ThreadItem }) {
  if (item.type === 'userMessage') {
    const content = Array.isArray(item.content) ? item.content : [];
    return <div className="message user-message"><div className="message-heading"><span className="avatar user-avatar">你</span><span>你</span></div><div className="user-bubble">{content.map((part, index) => {
      const entry = object(part);
      return entry.type === 'text' ? <p key={index}>{string(entry.text)}</p> : ['image', 'localImage'].includes(string(entry.type)) ? <span key={index} className="attached-label"><Icon name="image" size={15} />附加圖片</span> : null;
    })}</div></div>;
  }
  if (item.type === 'agentMessage' || item.type === 'plan') {
    if (!string(item.text)) return null;
    return <div className="message agent-message"><div className="message-heading"><Mark small /><span>{item.type === 'plan' ? '執行計畫' : 'Codex'}</span><span className="message-role">{item.type === 'plan' ? 'PLAN' : 'AGENT'}</span></div><div className="agent-content"><Markdown text={string(item.text)} /></div></div>;
  }
  if (item.type === 'commandExecution') return <details className="activity-card"><summary><Icon name="terminal" size={16} /><span className="activity-title">{string(item.command) || '執行指令'}</span><span className={`activity-status ${item.status === 'completed' ? 'done' : ''}`}>{item.status === 'completed' ? '完成' : item.status === 'failed' ? '失敗' : item.status === 'declined' ? '已拒絕' : '執行中'}</span><Icon name="chevron" size={14} /></summary>{item.aggregatedOutput ? <pre>{string(item.aggregatedOutput)}</pre> : <div className="activity-empty">尚無輸出</div>}</details>;
  if (item.type === 'fileChange') {
    const changes = Array.isArray(item.changes) ? item.changes : [];
    return <details className="activity-card file-changes"><summary><Icon name="edit" size={16} /><span className="activity-title">修改了 {changes.length} 個檔案</span><Icon name="chevron" size={14} /></summary>{changes.map((change, index) => {
      const entry = object(change);
      return <div className="change-entry" key={index}><div>{string(entry.path)}</div>{entry.diff ? <pre className="diff">{string(entry.diff).split('\n').map((line, lineIndex) => <span className={line.startsWith('+') ? 'added' : line.startsWith('-') ? 'removed' : ''} key={lineIndex}>{line}{'\n'}</span>)}</pre> : null}</div>;
    })}</details>;
  }
  if (item.type === 'mcpToolCall' || item.type === 'webSearch') return <details className="activity-card"><summary><Icon name="link" size={16} /><span className="activity-title">{string(item.tool) || (item.type === 'webSearch' ? '網頁搜尋' : '使用工具')}</span><Icon name="chevron" size={14} /></summary><div className="activity-empty">{string(item.server) || 'Codex 工具操作'}</div></details>;
  return null;
}

function PendingCard({ request, onRespond }: { request: PendingRequest; onRespond: (id: string | number, result: unknown) => Promise<void> }) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const params = request.params;
  const questions = Array.isArray(params.questions) ? params.questions.map(object) : [];
  const isInput = request.method.includes('requestUserInput');
  const isPermission = request.method.includes('permissions/requestApproval');
  const isElicitation = request.method.includes('elicitation');
  const act = async (result: unknown) => {
    setBusy(true); setError('');
    try { await onRespond(request.id, result); } catch (reason) { setError(errorText(reason)); } finally { setBusy(false); }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (isInput) void act({ answers: Object.fromEntries(questions.map((question) => [string(question.id), { answers: [answers[string(question.id)] || ''] }])) });
  };
  if (isElicitation) return <section className="approval-card"><div className="approval-title"><span className="approval-icon"><Icon name="shield" /></span><div><strong>工具需要本機互動</strong><p>{string(params.message) || '這個工具提出額外驗證或表單要求。'}</p><p>目前請在電腦端處理此工具的互動要求，或拒絕後讓 Codex 改用其他方式。</p></div><span className="waiting-badge">等待中</span></div><div className="approval-actions"><button type="button" disabled={busy} className="button subtle" onClick={() => void act({ action: 'cancel', content: null })}>取消要求</button><button type="button" disabled={busy} className="button subtle" onClick={() => void act({ action: 'decline', content: null })}>拒絕此操作</button></div>{error ? <p className="inline-error" role="alert">{error}</p> : null}</section>;
  return <section className="approval-card"><div className="approval-title"><span className="approval-icon"><Icon name={isInput ? 'chat' : 'shield'} /></span><div><strong>{isInput ? 'Codex 需要你的回答' : isElicitation ? '工具需要補充資訊' : isPermission ? '需要額外權限' : '等待你的核准'}</strong><p>{string(params.reason) || string(params.message) || '確認後，這項工作就會繼續。'}</p></div><span className="waiting-badge">等待中</span></div>
    {params.command ? <pre className="approval-command">{string(params.command)}</pre> : null}
    {isPermission ? <pre className="approval-command">{JSON.stringify(params.permissions ?? params.requestedPermissions ?? {}, null, 2)}</pre> : null}
    {isInput ? <form onSubmit={submit} className="question-form">
      {questions.map((question) => <fieldset key={string(question.id)}><legend>{string(question.question)}</legend>{Array.isArray(question.options) && question.options.length ? <div className="question-options">{question.options.map((option, index) => {
        const choice = object(option); const label = string(choice.label);
        return <label className={`choice ${answers[string(question.id)] === label ? 'selected' : ''}`} key={index}><input type="radio" name={`${request.id}-${string(question.id)}`} checked={answers[string(question.id)] === label} onChange={() => setAnswers((prev) => ({ ...prev, [string(question.id)]: label }))} /><span><strong>{label}</strong>{choice.description ? <small>{string(choice.description)}</small> : null}</span></label>;
      })}</div> : null}<input aria-label={string(question.question)} type={question.isSecret ? 'password' : 'text'} placeholder="輸入你的回答…" value={answers[string(question.id)] || ''} onChange={(event) => setAnswers((prev) => ({ ...prev, [string(question.id)]: event.target.value }))} required /></fieldset>)}
      <div className="approval-actions"><button disabled={busy || (isInput && questions.some((question) => !answers[string(question.id)]?.trim()))} className="button accent">{busy ? '傳送中…' : '確認回答'}<Icon name="check" size={16} /></button></div>
    </form> : <div className="approval-actions"><button className="button subtle" disabled={busy} onClick={() => void act(isPermission ? { permissions: {}, scope: 'turn' } : { decision: 'decline' })}>拒絕</button><button className="button accent" disabled={busy} onClick={() => void act(isPermission ? { permissions: params.permissions ?? params.requestedPermissions ?? {}, scope: 'turn' } : { decision: 'accept' })}>允許這次操作<Icon name="check" size={16} /></button></div>}
    {error ? <p className="inline-error" role="alert">{error}</p> : null}
  </section>;
}

export const normalizePairingCode = (value: string) => value.normalize('NFKC').replace(/\D/g, '').slice(0, 8);

export function Pairing({ onPaired }: { onPaired: () => void | Promise<void> }) {
  const [code, setCode] = useState('');
  const [deviceName, setDeviceName] = useState('我的裝置');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (!/^[0-9]{8}$/.test(code)) { setError(errorText(new Error('PAIRING_CODE_FORMAT_INVALID'))); return; }
    if (!deviceName.trim()) { setError(errorText(new Error('DEVICE_NAME_INVALID'))); return; }
    setBusy(true); setError('');
    try { await api('/auth/pair', { method: 'POST', body: body({ code, deviceName: deviceName.trim() }) }); await onPaired(); } catch (reason) { setError(errorText(reason)); } finally { setBusy(false); }
  };
  return <div className="pairing-screen"><div className="pairing-decoration" /><header className="pairing-brand"><Mark /><strong>PocketAgent<span>你的工作，隨身接續。</span></strong></header><main className="pairing-card"><div className="eyebrow"><span className="status-dot online" /> PRIVATE WORKSPACE</div><h1>連上你的<br /><em>工作空間。</em></h1><p className="pairing-description">與這台電腦配對，從手機接續 Codex 的每一項工作。</p><form onSubmit={(event) => void submit(event)}><label htmlFor="pair-code">一次性配對碼</label><input id="pair-code" className="code-input" autoComplete="one-time-code" inputMode="numeric" placeholder="輸入配對碼" value={code} onChange={(event) => setCode(normalizePairingCode(event.target.value))} onPaste={(event) => { event.preventDefault(); setCode(normalizePairingCode(event.clipboardData.getData('text'))); }} required autoFocus maxLength={8} minLength={8} pattern="[0-9]{8}" /><label htmlFor="device-name">裝置名稱</label><input id="device-name" value={deviceName} onChange={(event) => setDeviceName(event.target.value)} maxLength={64} required />{error ? <p className="inline-error" role="alert">{error}</p> : null}<button className="button accent pair-button" disabled={busy || !/^[0-9]{8}$/.test(code) || !deviceName.trim()}>{busy ? '正在配對…' : '配對這個裝置'}<Icon name="arrow" size={18} /></button></form><div className="pair-help"><Icon name="terminal" size={16} /><p>在電腦的 PocketAgent 目錄執行 <code>npm run pair</code> 取得配對碼。</p></div><footer><Icon name="shield" size={14} />配對碼 10 分鐘內有效 · 裝置驗證保留 30 天</footer></main><div className="pairing-bottom">LOCAL COMPUTE. ANYWHERE YOU ARE.</div></div>;
}

export function AccessFooter({ required, paired, connection, busy, onPairingChange, onLogout }: {
  required: boolean; paired: boolean; connection: 'connecting' | 'connected' | 'disconnected'; busy: boolean;
  onPairingChange: (required: boolean) => void; onLogout: () => void;
}) {
  const mode = required ? paired ? '裝置已配對' : '等待裝置配對' : '免配對';
  return <footer className="sidebar-footer">
    <div className="private-connection"><span className="connection-glyph"><Icon name="shield" size={17} /></span><div><strong>私人工作空間</strong><span>{mode} · {connection === 'connected' ? '私人連線' : '恢復連線中'}</span></div><span className={`status-dot ${connection === 'connected' ? 'online' : ''}`} /></div>
    <div className="pairing-setting">
      <label className="pairing-setting-control"><span>要求裝置配對</span><span className="pairing-setting-value">{busy ? '儲存中…' : required ? '開啟' : '關閉'}</span><input className="visually-hidden" type="checkbox" role="switch" aria-label="要求裝置配對" checked={required} disabled={busy} onChange={event => onPairingChange(event.target.checked)} /><span className={`pairing-switch ${required ? 'enabled' : ''}`} aria-hidden="true"><span /></span></label>
      <p>關閉時，能連到服務的裝置可直接使用。</p>
    </div>
    {paired ? <button className="logout-button" onClick={onLogout}><Icon name="logout" size={15} />移除此裝置配對</button> : null}
  </footer>;
}

function FileBrowser({ project, onClose }: { project: Project; onClose: () => void }) {
  const [path, setPath] = useState('');
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [selected, setSelected] = useState<{ path: string; content: string; truncated?: boolean } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { setPath(''); setSelected(null); }, [project.id]);
  useEffect(() => {
    let live = true; setLoading(true); setError('');
    void api<{ entries: FileEntry[] }>(`/projects/${encodeURIComponent(project.id)}/tree?path=${encodeURIComponent(path)}`).then((data) => { if (live) setEntries(data.entries); }).catch((reason) => { if (live) setError(errorText(reason)); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [project.id, path]);
  const open = async (entry: FileEntry) => {
    if (entry.type === 'directory') { setSelected(null); setPath(entry.path); return; }
    setLoading(true); setError('');
    try { setSelected(await api(`/projects/${encodeURIComponent(project.id)}/file?path=${encodeURIComponent(entry.path)}`)); } catch (reason) { setError(errorText(reason)); } finally { setLoading(false); }
  };
  const up = () => { setSelected(null); setPath(path.replace(/\\/g, '/').split('/').slice(0, -1).join('/')); };
  return <aside className="file-browser"><header><div><Icon name="folder" /><strong>專案檔案</strong><span className="readonly-tag">唯讀</span></div><button className="icon-button" onClick={onClose} aria-label="關閉檔案預覽"><Icon name="close" /></button></header><div className="file-breadcrumb"><button className="text-button" onClick={() => { setPath(''); setSelected(null); }}>{project.name}</button>{path ? <><Icon name="chevron" size={12} /><span>{path}</span></> : null}</div>{error ? <div className="file-error" role="alert">{error}</div> : null}{selected ? <div className="file-preview"><div className="file-preview-title"><button className="icon-button" onClick={() => setSelected(null)} aria-label="返回檔案清單"><Icon name="back" size={16} /></button><span>{selected.path}</span></div>{selected.truncated ? <p className="file-notice">檔案較大，僅顯示部分內容。</p> : null}<pre>{selected.content}</pre></div> : <div className="file-list">{path ? <button className="file-row parent-folder" onClick={up}><Icon name="back" size={15} />上一層</button> : null}{loading ? <p className="empty-note">讀取中…</p> : entries.length ? entries.map((entry) => <button key={entry.path} className="file-row" onClick={() => void open(entry)}><Icon name={entry.type === 'directory' ? 'folder' : 'file'} size={17} /><span>{entry.name}</span>{entry.type === 'directory' ? <Icon name="chevron" size={13} /> : null}</button>) : <p className="empty-note">這個資料夾沒有可預覽的檔案。</p>}</div>}<footer><Icon name="shield" size={14} />檔案修改由 Codex 執行</footer></aside>;
}

export function App() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [pairingRequired, setPairingRequired] = useState(true);
  const [paired, setPaired] = useState(false);
  const [pairingBusy, setPairingBusy] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [projectsLoaded, setProjectsLoaded] = useState(false);
  const [projectId, setProjectId] = useState('');
  const [threads, setThreads] = useState<Thread[]>([]);
  const [threadCursor, setThreadCursor] = useState<string | null>(null);
  const [threadId, setThreadId] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [models, setModels] = useState<Model[]>([]);
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('');
  const [inheritedEffort, setInheritedEffort] = useState('');
  const [status, setStatus] = useState<ServiceStatus>({ codex: 'starting' });
  const [requests, setRequests] = useState<PendingRequest[]>([]);
  const [connection, setConnection] = useState<'connecting' | 'connected' | 'disconnected'>('connecting');
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(false);
  const [continuationReady, setContinuationReady] = useState(true);
  const [error, setError] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const threadRef = useRef(threadId);
  const projectRef = useRef(projectId);
  const sequenceRef = useRef(0);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const uploadRef = useRef<HTMLInputElement>(null);
  const uploadInFlightRef = useRef(false);
  const endRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  const submissionRef = useRef<{ fingerprint: string; requestId: string } | null>(null);
  const viewEpochRef = useRef(0);
  const projectsRequestRef = useRef(0);
  const projectViewRef = useRef<string | null>(null);
  const accessRequestRef = useRef(0);
  const accessMutationRef = useRef(false);
  const accessStateRef = useRef<AuthState>({ authenticated: false, pairingRequired: true, paired: false });
  const project = projects.find((entry) => entry.id === projectId);
  const selectedThread = threads.find((entry) => entry.id === threadId);
  const selectedModel = models.find(entry => entry.model === model);
  const isWorking = turns.some((turn) => ['inProgress', 'running', 'active'].includes(turn.status)) || selectedThread?.status?.type === 'active';
  const currentRequests = requests.filter((request) => string(request.params.threadId) === threadId || (!request.params.threadId && !!threadId));
  const itemCount = turns.reduce((count, turn) => count + turn.items.length, 0);
  const waitingForProjects = !project && (projectsLoading || !projectsLoaded);
  const catalogLoadingText = status.codex !== 'ready' ? '正在等待 Codex 就緒…' : projectsLoading ? '正在讀取 Codex 專案…' : '暫時無法讀取 Codex 專案，請重新整理網頁。';

  useEffect(() => { threadRef.current = threadId; }, [threadId]);
  useEffect(() => { projectRef.current = projectId; }, [projectId]);
  useEffect(() => { if (followRef.current) endRef.current?.scrollIntoView({ behavior: sending ? 'smooth' : 'instant', block: 'end' }); }, [turns, requests, sending]);
  useEffect(() => { const element = composerRef.current; if (element) { element.style.height = 'auto'; element.style.height = `${Math.min(element.scrollHeight, 180)}px`; } }, [text]);

  const applyAccess = useCallback((access: AuthState) => {
    accessStateRef.current = access;
    setPairingRequired(access.pairingRequired);
    setPaired(access.paired);
    setAuthenticated(access.authenticated);
  }, []);
  const refreshAccess = useCallback(async () => {
    if (accessMutationRef.current) return accessStateRef.current;
    const request = ++accessRequestRef.current;
    const access = await api<AuthState>('/auth');
    if (request === accessRequestRef.current) applyAccess(access);
    return access;
  }, [applyAccess]);

  const refreshRequests = useCallback(async () => { try { setRequests((await api<{ requests: PendingRequest[] }>('/requests')).requests); } catch { /* Reconnection performs the next refresh. */ } }, []);
  const refreshProjects = useCallback(async () => {
    const request = ++projectsRequestRef.current;
    setProjectsLoading(true);
    try {
      const data = await api<{ projects: Project[] }>('/projects');
      if (request !== projectsRequestRef.current) return;
      setProjects(data.projects);
      setProjectsLoaded(true);
      setError(previous => previous === errorText(new Error('CODEX_OFFLINE')) ? '' : previous);
      const next = data.projects.some(entry => entry.id === projectRef.current) ? projectRef.current : data.projects[0]?.id || '';
      if (next !== projectRef.current) { projectRef.current = next; setProjectId(next); }
    } catch (reason) { if (request === projectsRequestRef.current) throw reason; }
    finally { if (request === projectsRequestRef.current) setProjectsLoading(false); }
  }, []);
  const refreshHistory = useCallback(async (id: string, pid: string) => {
    const data = await api<{ data: Turn[]; nextCursor?: string | null }>(`/threads/${encodeURIComponent(id)}/turns?projectId=${encodeURIComponent(pid)}`);
    if (threadRef.current === id && projectRef.current === pid) { setTurns((live) => mergeHistory([...data.data].reverse(), live)); setHistoryCursor(data.nextCursor || null); }
  }, []);

  const loadThreads = useCallback(async (pid: string, cursor?: string) => {
    const data = await api<{ data: Thread[]; nextCursor?: string | null }>(`/threads?projectId=${encodeURIComponent(pid)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    if (projectRef.current !== pid) return;
    setThreads((previous) => cursor ? [...previous, ...data.data.filter((entry) => !previous.some((old) => old.id === entry.id))] : data.data);
    setThreadCursor(data.nextCursor || null);
  }, []);

  useEffect(() => {
    let live = true;
    void refreshAccess().catch((reason) => { if (live) { setAuthenticated(false); setError(errorText(reason)); } });
    return () => { live = false; };
  }, [refreshAccess]);

  useEffect(() => {
    let live = true;
    let inFlight = false;
    const recheck = () => {
      if (inFlight || document.visibilityState === 'hidden') return;
      inFlight = true;
      void refreshAccess().catch(() => { /* Preserve the current view through transient network failures. */ }).finally(() => { if (live) inFlight = false; });
    };
    const onVisibility = () => { if (document.visibilityState === 'visible') recheck(); };
    window.addEventListener('focus', recheck);
    window.addEventListener('pocketagent:reauth', recheck);
    document.addEventListener('visibilitychange', onVisibility);
    const timer = setInterval(recheck, 30_000);
    return () => { live = false; clearInterval(timer); window.removeEventListener('focus', recheck); window.removeEventListener('pocketagent:reauth', recheck); document.removeEventListener('visibilitychange', onVisibility); };
  }, [refreshAccess]);

  useEffect(() => {
    if (!authenticated) return;
    let live = true;
    void Promise.allSettled([
      refreshProjects(),
      api<ServiceStatus>('/status').then((data) => { if (live) setStatus(data); }),
      api<{ data: Model[] }>('/models').then((data) => { if (live) { setModels(data.data); setModel((previous) => previous || (data.data.find((entry) => entry.isDefault) || data.data[0])?.model || ''); } }),
      refreshRequests(),
    ]).then((results) => { if (live) { const failure = results.find((result) => result.status === 'rejected'); if (failure?.status === 'rejected') setError(errorText(failure.reason)); } });
    return () => { live = false; };
  }, [authenticated, refreshRequests, refreshProjects]);

  useEffect(() => {
    if (!authenticated) return;
    if (projectViewRef.current !== projectId) {
      projectViewRef.current = projectId;
      viewEpochRef.current += 1;
      setThreads([]); setThreadId(''); threadRef.current = ''; setTurns([]); setAttachments([]); setHistoryCursor(null); setFilesOpen(false); setContinuationReady(true); setInheritedEffort('');
    }
    setLoading(true);
    if (!projectId) { setLoading(false); return; }
    let live = true;
    void loadThreads(projectId).catch((reason) => { if (live) setError(errorText(reason)); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [projectId, authenticated, loadThreads]);

  useEffect(() => {
    if (!authenticated || status.codex !== 'ready') return;
    let live = true;
    void refreshProjects().catch(reason => { if (live) setError(errorText(reason)); });
    void api<{ data: Model[] }>('/models').then((data) => { if (live) { setModels(data.data); setModel((previous) => previous || (data.data.find((entry) => entry.isDefault) || data.data[0])?.model || ''); } }).catch(() => undefined);
    if (projectRef.current) void loadThreads(projectRef.current).catch(() => undefined);
    return () => { live = false; };
  }, [authenticated, status.codex, loadThreads, refreshProjects]);

  useEffect(() => {
    if (!authenticated) return;
    let closed = false; let socket: WebSocket | undefined; let timer: ReturnType<typeof setTimeout>; let attempts = 0;
    const resync = () => {
      void refreshAccess().then(access => {
        if (closed || !access.authenticated) return;
        void refreshProjects().catch(reason => { if (!closed) setError(errorText(reason)); });
        void refreshRequests();
        const id = threadRef.current; const pid = projectRef.current;
        if (id && pid) void refreshHistory(id, pid).catch(() => undefined);
        if (pid) void loadThreads(pid).catch(() => undefined);
        void api<ServiceStatus>('/status').then(setStatus).catch(() => undefined);
      }).catch(() => { /* The next reconnect retries access without clearing the current work. */ });
    };
    const connect = () => {
      setConnection('connecting');
      socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/events?after=${sequenceRef.current}`);
      socket.onopen = () => { if (closed) return; attempts = 0; setConnection('connected'); resync(); };
      socket.onmessage = (message) => {
        if (closed) return;
        let event: AppEvent; try { event = JSON.parse(string(message.data)) as AppEvent; } catch { return; }
        if (!event || typeof event.method !== 'string') return;
        if (event.method !== 'pocketagent/reset' && event.seq > 0 && event.seq <= sequenceRef.current) return;
        sequenceRef.current = Math.max(sequenceRef.current, event.seq || 0);
        const params = object(event.params); event.params = params;
        if (event.method === 'pocketagent/reset') { sequenceRef.current = event.seq || 0; resync(); return; }
        if (event.method === 'pocketagent/status') { setStatus((params.status || params) as unknown as ServiceStatus); return; }
        if (event.method === 'pocketagent/requests') { if (Array.isArray(params.requests)) setRequests(params.requests as PendingRequest[]); return; }
        if (event.method === 'project/changed') {
          void refreshProjects().then(() => { const pid = projectRef.current; if (pid && !closed) void loadThreads(pid).catch(reason => setError(errorText(reason))); }).catch(reason => { if (!closed) setError(errorText(reason)); });
          return;
        }
        if (event.method.includes('requestApproval') || event.method.includes('requestUserInput') || event.method.includes('elicitation') || event.method === 'serverRequest/resolved') void refreshRequests();
        if (event.method === 'thread/name/updated') setThreads((previous) => previous.map((entry) => entry.id === string(params.threadId) ? { ...entry, name: string(params.threadName) || string(params.name) } : entry));
        if (event.method === 'thread/status/changed') setThreads((previous) => previous.map((entry) => entry.id === string(params.threadId) ? { ...entry, status: object(params.status) as { type: string } } : entry));
        if (string(params.threadId) !== threadRef.current) return;
        if (event.method === 'pocketagent/interrupted') {
          setTurns((previous) => previous.map((turn) => (!params.turnId || turn.id === params.turnId) && !terminalStatus(turn.status) ? { ...turn, status: 'interrupted' } : turn));
          setThreads((previous) => previous.map((entry) => entry.id === threadRef.current ? { ...entry, status: { type: 'systemError' } } : entry));
          setError('Codex 程序已中斷。原有變更會保留，請確認狀態後再接續工作。');
          resync(); return;
        }
        setTurns((previous) => applyThreadEvent(previous, event));
        if (event.method === 'turn/completed') { const pid = projectRef.current; if (pid) void loadThreads(pid).catch(() => undefined); }
      };
      socket.onclose = () => {
        if (closed) return;
        setConnection('disconnected');
        const retry = () => { if (!closed) timer = setTimeout(connect, Math.min(1000 * 2 ** attempts++, 15000)); };
        void refreshAccess().then(access => { if (access.authenticated) retry(); }).catch(retry);
      };
      socket.onerror = () => socket?.close();
    };
    connect();
    return () => { closed = true; clearTimeout(timer); socket?.close(); };
  }, [authenticated, loadThreads, refreshHistory, refreshRequests, refreshProjects, refreshAccess]);

  useEffect(() => {
    if (!authenticated || status.codex !== 'ready') return;
    let live = true;
    let inFlight = false;
    const refreshVisibleCatalog = async (includeHistory: boolean) => {
      if (!live || inFlight || document.visibilityState === 'hidden') return;
      inFlight = true;
      const previousProject = projectRef.current;
      const previousThread = threadRef.current;
      try {
        const access = await refreshAccess();
        if (!live || !access.authenticated) return;
        await refreshProjects();
        if (!live) return;
        const pid = projectRef.current;
        if (pid) await loadThreads(pid);
        if (live && includeHistory && pid && pid === previousProject && previousThread && previousThread === threadRef.current) await refreshHistory(previousThread, pid);
      } catch { /* A later focus, poll or stream event retries these read-only requests. */ }
      finally { inFlight = false; }
    };
    const onFocus = () => { void refreshVisibleCatalog(true); };
    const onVisibility = () => { if (document.visibilityState === 'visible') onFocus(); };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    const timer = setInterval(() => { void refreshVisibleCatalog(false); }, 30_000);
    return () => {
      live = false;
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [authenticated, status.codex, refreshProjects, loadThreads, refreshHistory, refreshAccess]);

  const chooseThread = async (entry: Thread) => {
    const epoch = ++viewEpochRef.current;
    const selectedProject = projectId;
    const isCurrentView = () => epoch === viewEpochRef.current && threadRef.current === entry.id && projectRef.current === selectedProject;
    setSidebarOpen(false); setThreadId(entry.id); threadRef.current = entry.id; setTurns([]); setHistoryCursor(null); setLoading(true); setContinuationReady(false); setModel(entry.model || ''); setEffort(''); setInheritedEffort(entry.reasoningEffort || ''); setError(''); setAttachments([]); followRef.current = true;
    const history = refreshHistory(entry.id, selectedProject);
    const resume = api<{ thread: Thread; model?: string; reasoningEffort?: string | null }>(`/threads/${encodeURIComponent(entry.id)}/resume`, { method: 'POST', body: body({ projectId: selectedProject }) }).then(resumed => {
      if (!isCurrentView()) return;
      setModel(typeof resumed.model === 'string' ? resumed.model : '');
      setInheritedEffort(resumed.reasoningEffort || entry.reasoningEffort || '');
      setContinuationReady(true);
    });
    const [historyResult, resumeResult] = await Promise.allSettled([history, resume]);
    if (!isCurrentView()) return;
    if (resumeResult.status === 'rejected') {
      const writerConflict = resumeResult.reason instanceof Error && resumeResult.reason.message === 'THREAD_WRITER_CONFLICT';
      setError(writerConflict ? `${historyResult.status === 'fulfilled' ? '對話紀錄已載入。' : ''}${errorText(resumeResult.reason)}` : historyResult.status === 'fulfilled' ? errorText(new Error('THREAD_RESUME_FAILED')) : errorText(resumeResult.reason));
    }
    else if (historyResult.status === 'rejected') setError(errorText(historyResult.reason));
    setLoading(false);
    await refreshRequests();
  };
  const newThread = () => { viewEpochRef.current += 1; const previous = effort || inheritedEffort; setEffort(selectedModel?.supportedReasoningEfforts?.some(option => option.reasoningEffort === previous) ? previous : selectedModel?.defaultReasoningEffort || ''); setInheritedEffort(''); setLoading(false); setContinuationReady(true); setThreadId(''); threadRef.current = ''; setTurns([]); setHistoryCursor(null); setAttachments([]); setText(''); setError(''); setSidebarOpen(false); submissionRef.current = null; setTimeout(() => composerRef.current?.focus(), 0); };
  const send = async () => {
    if ((!text.trim() && !attachments.length) || sending || loading || !continuationReady || isWorking || !projectId || status.codex !== 'ready' || status.authenticated === false) return;
    const epoch = viewEpochRef.current;
    const sendProject = projectId;
    const sentText = text;
    const sentAttachments = attachments.map((entry) => entry.id);
    const isCurrentView = () => viewEpochRef.current === epoch && projectRef.current === sendProject;
    setSending(true); setError(''); followRef.current = true;
    let id = threadId;
    try {
      if (!id) {
        const data = await api<{ thread: Thread }>('/threads', { method: 'POST', body: body({ projectId: sendProject, model: model || undefined, effort: effort || undefined }) });
        if (!isCurrentView()) return;
        id = data.thread.id; threadRef.current = id; setThreadId(id); setThreads((previous) => [data.thread, ...previous.filter((entry) => entry.id !== id)]);
      }
      const fingerprint = JSON.stringify({ id, text: sentText, attachmentIds: sentAttachments, model, effort });
      if (submissionRef.current?.fingerprint !== fingerprint) submissionRef.current = { fingerprint, requestId: uniqueId() };
      const data = await api<{ turn: Turn }>(`/threads/${encodeURIComponent(id)}/messages`, { method: 'POST', body: body({ projectId: sendProject, text: sentText, attachmentIds: sentAttachments, model: model || undefined, effort: effort || undefined, requestId: submissionRef.current.requestId }) });
      if (isCurrentView() && threadRef.current === id) {
        if (data.turn) setTurns((previous) => mergeTurn(previous, data.turn));
        setText((current) => current === sentText ? '' : current);
        setAttachments((current) => current.filter((entry) => !sentAttachments.includes(entry.id)));
        submissionRef.current = null;
      }
    } catch (reason) { if (isCurrentView()) setError(errorText(reason)); } finally { setSending(false); if (isCurrentView()) composerRef.current?.focus(); }
  };
  const interrupt = async () => { try { await api(`/threads/${encodeURIComponent(threadId)}/interrupt`, { method: 'POST', body: body({ projectId }) }); } catch (reason) { setError(errorText(reason)); } };
  const upload = async (files: FileList | File[]) => {
    if (!projectId) return;
    if (uploadInFlightRef.current) { setError('圖片仍在上傳，請稍後再加入圖片。'); return; }
    const batch = Array.from(files);
    if (attachments.length + batch.length > 8) { setError(errorText(new Error('INVALID_ATTACHMENTS'))); return; }
    const uploadProject = projectId;
    const epoch = viewEpochRef.current;
    const isCurrentView = () => projectRef.current === uploadProject && viewEpochRef.current === epoch;
    uploadInFlightRef.current = true;
    setUploading(true); setError('');
    try {
      for (const file of batch) {
        if (!isCurrentView()) break;
        if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw new Error('請選擇 JPEG、PNG 或 WebP 圖片。');
        if (file.size > 10 * 1024 * 1024) throw new Error('每張圖片最多 10 MiB。');
        const form = new FormData(); form.append('file', file);
        const attachment = await api<Attachment>(`/uploads?projectId=${encodeURIComponent(uploadProject)}`, { method: 'POST', body: form });
        if (isCurrentView()) setAttachments((previous) => [...previous, attachment]);
      }
    } catch (reason) { if (isCurrentView()) setError(errorText(reason)); } finally { uploadInFlightRef.current = false; setUploading(false); if (uploadRef.current) uploadRef.current.value = ''; }
  };
  const respond = async (id: string | number, result: unknown) => { await api(`/requests/${encodeURIComponent(String(id))}`, { method: 'POST', body: body({ result }) }); await refreshRequests(); };
  const rename = async (event: FormEvent) => { event.preventDefault(); try { await api(`/threads/${encodeURIComponent(threadId)}`, { method: 'PATCH', body: body({ projectId, name: renameValue.trim() }) }); setThreads((previous) => previous.map((entry) => entry.id === threadId ? { ...entry, name: renameValue.trim() } : entry)); setRenaming(false); } catch (reason) { setError(errorText(reason)); } };
  const olderHistory = async () => {
    if (!historyCursor) return;
    const epoch = viewEpochRef.current;
    const isCurrentView = () => viewEpochRef.current === epoch && projectRef.current === projectId && threadRef.current === threadId;
    try {
      const data = await api<{ data: Turn[]; nextCursor?: string | null }>(`/threads/${encodeURIComponent(threadId)}/turns?projectId=${encodeURIComponent(projectId)}&cursor=${encodeURIComponent(historyCursor)}`);
      if (!isCurrentView()) return;
      followRef.current = false;
      setTurns((previous) => [...data.data.reverse().filter((entry) => !previous.some((old) => old.id === entry.id)), ...previous]);
      setHistoryCursor(data.nextCursor || null);
    } catch (reason) { if (isCurrentView()) setError(errorText(reason)); }
  };
  const changePairing = async (required: boolean) => {
    if (pairingBusy) return;
    setPairingBusy(true);
    accessMutationRef.current = true;
    accessRequestRef.current += 1;
    try {
      const access = await api<AuthState>('/settings/pairing', { method: 'POST', body: body({ required }) });
      accessRequestRef.current += 1;
      applyAccess(access);
    } catch (reason) { setError(errorText(reason)); }
    finally {
      accessMutationRef.current = false;
      setPairingBusy(false);
      void refreshAccess().catch(() => { /* Recheck on the next focus or reconnect if the network failed. */ });
    }
  };
  const logout = async () => { try { await api('/auth/logout', { method: 'POST' }); await refreshAccess(); } catch (reason) { setError(errorText(reason)); } };

  if (authenticated === null) return <div className="boot-screen"><Mark /><span>正在連接工作空間<span className="loading-dots">…</span></span></div>;
  if (!authenticated) return <Pairing onPaired={async () => { await refreshAccess(); setError(''); }} />;
  return <div className="app-shell">
    {sidebarOpen ? <button className="sidebar-backdrop" aria-label="收起選單" onClick={() => setSidebarOpen(false)} /> : null}
    <aside className={`sidebar ${sidebarOpen ? 'open' : ''}`}><header className="brand"><Mark /><div><strong>PocketAgent</strong><span>你的工作，隨身接續。</span></div><button className="icon-button sidebar-close" aria-label="關閉選單" onClick={() => setSidebarOpen(false)}><Icon name="close" /></button></header>
      <div className="project-label">Codex 專案 <span>PROJECTS</span></div><div className="project-picker"><Icon name="folder" size={19} /><select aria-label="切換 Codex 專案" aria-busy={projectsLoading} disabled={waitingForProjects} value={projectId} onChange={(event) => { projectRef.current = event.target.value; setProjectId(event.target.value); }}>{projects.length ? projects.map((entry) => <option value={entry.id} key={entry.id}>{entry.name}</option>) : <option value="">{waitingForProjects ? catalogLoadingText : '尚無 Codex 專案'}</option>}</select><Icon name="chevron" size={13} /></div>
      <button className="new-thread-button" onClick={newThread} disabled={!projectId}><Icon name="plus" size={18} />新增對話<span>＋</span></button>
      <div className="session-label">最近的對話<button className="icon-button" aria-label="重新整理對話" onClick={() => void loadThreads(projectId).catch((reason) => setError(errorText(reason)))} disabled={!projectId}><Icon name="refresh" size={14} /></button></div>
      <nav className="session-list" aria-label="對話紀錄">{threads.map((entry) => <button className={`session-row ${entry.id === threadId ? 'active' : ''}`} key={entry.id} onClick={() => void chooseThread(entry)}><Icon name="chat" size={16} /><span><strong>{entry.name || entry.preview || '新的對話'}</strong><small>{entry.status?.type === 'active' ? <><span className="status-dot online" />執行中</> : entry.id === threadId ? '目前的對話' : '點選以接續工作'}</small></span><time>{dateLabel(entry.updatedAt)}</time>{requests.some((request) => request.params.threadId === entry.id) ? <span className="request-dot" title="等待回覆" /> : null}</button>)}{!threads.length ? <div className="no-sessions"><Icon name="chat" size={25} /><p>{waitingForProjects ? catalogLoadingText : loading ? '正在讀取對話…' : '從一個新對話開始。'}<br /><span>{loading || waitingForProjects ? '稍候就能接續工作' : '這個 Codex 專案的對話會出現在這裡。'}</span></p></div> : null}{threadCursor ? <button className="load-more" onClick={() => void loadThreads(projectId, threadCursor).catch((reason) => setError(errorText(reason)))}>載入更早的對話</button> : null}</nav>
      <AccessFooter required={pairingRequired} paired={paired} connection={connection} busy={pairingBusy} onPairingChange={required => void changePairing(required)} onLogout={() => void logout()} />
    </aside>
    <main className="workspace"><header className="workspace-header"><div className="workspace-breadcrumb"><button className="icon-button mobile-menu" aria-label="開啟專案與對話" onClick={() => setSidebarOpen(true)}><Icon name="menu" size={20} /></button><span className="breadcrumb-project">{project?.name || 'Codex 專案'}</span><span className="breadcrumb-divider">/</span><span className="breadcrumb-thread">{selectedThread?.name || selectedThread?.preview || '新的對話'}</span></div><div className="workspace-actions"><span className={`service-pill ${status.codex === 'ready' ? 'ready' : ''}`}><span className={`status-dot ${status.codex === 'ready' ? 'online' : ''}`} /><span>{status.codex === 'ready' ? 'Codex 已就緒' : status.codex === 'starting' ? 'Codex 啟動中' : 'Codex 未連線'}</span></span>{threadId ? <button className="icon-button rename-button" aria-label="重新命名對話" title="重新命名對話" onClick={() => { setRenameValue(selectedThread?.name || ''); setRenaming(true); }}><Icon name="edit" size={17} /></button> : null}<button className={`icon-button file-toggle ${filesOpen ? 'selected' : ''}`} aria-label="瀏覽專案檔案" title="瀏覽專案檔案" disabled={!project} onClick={() => setFilesOpen(!filesOpen)}><Icon name="folder" size={19} /></button></div></header>
      {connection === 'disconnected' ? <div className="connection-banner"><Icon name="refresh" size={14} />連線暫時中斷，電腦上的工作仍會繼續。正在重新連線…</div> : null}
      {status.codex === 'ready' && status.authenticated === false ? <div className="connection-banner warning"><Icon name="shield" size={14} />Codex 尚未登入。請在電腦執行 codex login，完成後重新啟動服務。</div> : null}
      {status.codex === 'offline' ? <div className="connection-banner warning"><Icon name="terminal" size={14} />Codex 尚未就緒。請在電腦上確認 CLI 安裝與登入狀態。</div> : null}
      <div className="workspace-body"><div className="conversation-column"><div className="conversation-scroll" ref={scrollRef} onScroll={() => { const element = scrollRef.current; if (element) followRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 160; }}>
        {waitingForProjects ? <div className="welcome"><span className="spinner" /><p>{catalogLoadingText}</p></div> : !itemCount && !loading ? <div className="welcome"><div className="welcome-eyebrow"><span className="tiny-line" />YOUR DESK, IN YOUR POCKET</div><div className="welcome-symbol"><Icon name="code" size={36} /></div><h1>靈感在哪，<br /><span>工作就從哪開始。</span></h1><p>{project ? <>已連上 <strong>{project.name}</strong>。<br />交代下一步，讓電腦上的 Codex 接手。</> : <>請先在 Codex 桌面版加入專案，<br />再重新整理網頁以接續對話。</>}</p><div className="welcome-tools"><span><Icon name="folder" size={15} />本機專案</span><span><Icon name="chat" size={15} />接續紀錄</span><span><Icon name="image" size={15} />圖片輸入</span></div><div className="welcome-hint"><Icon name="shield" size={15} /><span>工作在你的電腦執行，離開網頁也會繼續。</span></div></div> : <div className="messages">{historyCursor ? <button className="history-button" onClick={() => void olderHistory()}><Icon name="refresh" size={14} />載入更早的訊息</button> : null}{turns.map((turn) => <div className="turn" key={turn.id}>{turn.items.map((item) => <MessageItem item={item} key={item.id} />)}{turn.error ? <div className="turn-error"><Icon name="close" size={15} />{turn.error.message || '這項工作未完成。'}</div> : null}{turn.status === 'interrupted' ? <div className="turn-note">工作已中斷，可傳送新訊息接續。</div> : null}</div>)}{isWorking ? <div className="working-indicator"><span /><span /><span /><p>{currentRequests.length ? '等待你的回覆' : 'Codex 正在處理工作'}</p></div> : null}</div>}
        {loading ? <div className="history-loading"><span className="spinner" />正在讀取對話…</div> : null}
        {currentRequests.length ? <div className="pending-requests">{currentRequests.map((request) => <PendingCard key={request.id} request={request} onRespond={respond} />)}</div> : null}<div ref={endRef} className="scroll-anchor" /></div>
        <div className="composer-area">{error ? <div className="error-banner" role="alert"><span>{error}</span><button className="icon-button" aria-label="關閉錯誤訊息" onClick={() => setError('')}><Icon name="close" size={15} /></button></div> : null}<form className={`composer ${sending ? 'busy' : ''}`} onSubmit={(event) => { event.preventDefault(); void send(); }}>
          {attachments.length ? <div className="attachment-list">{attachments.map((attachment) => <div className="attachment-chip" key={attachment.id}><img src={`/api/uploads/${encodeURIComponent(attachment.id)}`} alt={attachment.name} /><span>{attachment.name}</span><button type="button" className="icon-button" aria-label={`移除 ${attachment.name}`} onClick={() => setAttachments((previous) => previous.filter((entry) => entry.id !== attachment.id))}><Icon name="close" size={13} /></button></div>)}</div> : null}
          <textarea ref={composerRef} value={text} onChange={(event) => setText(event.target.value)} onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && !window.matchMedia('(pointer: coarse)').matches) { event.preventDefault(); void send(); } }} onPaste={(event) => { const imageFiles = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith('image/')); if (imageFiles.length) { event.preventDefault(); void upload(imageFiles); } }} placeholder={isWorking ? '工作進行中，完成後可傳送下一則訊息…' : '交代下一步，或附上一張圖片…'} aria-label="傳送給 Codex 的訊息" rows={2} disabled={!projectId} />
          <div className="composer-toolbar"><div className="composer-options"><input className="visually-hidden" ref={uploadRef} type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={(event) => { if (event.target.files) void upload(event.target.files); }} /><button type="button" className="icon-button attach-button" aria-label="上傳圖片" title="上傳圖片（每張最多 10 MiB）" disabled={uploading || !projectId || isWorking} onClick={() => uploadRef.current?.click()}>{uploading ? <span className="spinner small-spinner" /> : <Icon name="plus" size={20} />}</button><span className="toolbar-divider" /><div className="model-picker"><Icon name="code" size={14} /><select aria-label="選擇模型" value={model} onChange={(event) => { const next = models.find(entry => entry.model === event.target.value); setModel(event.target.value); setEffort(next?.defaultReasoningEffort || ""); setInheritedEffort(""); }} disabled={isWorking || sending || loading}><ModelOptions models={models} model={model} /></select><Icon name="chevron" size={11} /></div><div className="reasoning-picker"><span>思考</span><select aria-label="思考強度" value={effort} onChange={event => setEffort(event.target.value)} disabled={isWorking || sending || loading || !selectedModel?.supportedReasoningEfforts?.length}><ReasoningOptions model={selectedModel} inherited={inheritedEffort} /></select></div></div>{isWorking ? <button type="button" className="send-button stop-button" aria-label="停止工作" title="停止工作" onClick={() => void interrupt()}><Icon name="stop" size={18} /></button> : <button type="submit" className="send-button" aria-label="傳送訊息" title="傳送訊息" disabled={sending || uploading || loading || !continuationReady || (!text.trim() && !attachments.length) || !projectId || status.codex !== 'ready' || status.authenticated === false}>{sending ? <span className="spinner dark-spinner" /> : <Icon name="arrow" size={21} />}</button>}</div></form><div className="composer-caption"><span><Icon name="shield" size={11} />工作區寫入 · 需要時核准</span><span className="keyboard-hint">Enter 傳送 · Shift + Enter 換行</span></div></div>
      </div>{filesOpen && project ? <FileBrowser key={project.id} project={project} onClose={() => setFilesOpen(false)} /> : null}</div>
    </main>
    {renaming ? <div className="modal-backdrop" onClick={() => setRenaming(false)}><form className="rename-modal" onClick={(event) => event.stopPropagation()} onSubmit={(event) => void rename(event)}><h2>重新命名對話</h2><label htmlFor="thread-name">對話名稱</label><input id="thread-name" value={renameValue} onChange={(event) => setRenameValue(event.target.value)} maxLength={100} autoFocus required /><div><button type="button" className="button subtle" onClick={() => setRenaming(false)}>取消</button><button className="button accent" disabled={!renameValue.trim()}>儲存名稱</button></div></form></div> : null}
  </div>;
}
