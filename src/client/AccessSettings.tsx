import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import './AccessSettings.css';

export interface AccessSettingsProps {
  required: boolean;
  busy: boolean;
  onChange: (required: boolean) => void | Promise<void>;
  onReconnect: () => void;
  onRecover: () => void | Promise<void>;
  recovering: boolean;
}

export function AccessSettings({ required, busy, onChange, onReconnect, onRecover, recovering }: AccessSettingsProps) {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [confirmPairing, setConfirmPairing] = useState<boolean | null>(null);
  const [repairExpanded, setRepairExpanded] = useState(false);
  const [confirmRecovery, setConfirmRecovery] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const recoveryCancelRef = useRef<HTMLButtonElement>(null);
  const switchRef = useRef<HTMLInputElement>(null);
  const changingRef = useRef(false);
  const recoveryAttemptRef = useRef<object | null>(null);
  const id = useId();
  const disabled = busy || saving;
  const close = useCallback(() => {
    setOpen(false);
    setExpanded(false);
    setConfirmPairing(null);
    setRepairExpanded(false);
    setConfirmRecovery(false);
    setError('');
  }, []);

  useEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialogRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); close(); return; }
      if (event.key !== 'Tab') return;
      const controls = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), [tabindex="0"]') ?? []);
      const first = controls[0]; const last = controls.at(-1);
      if (!first || !last) { event.preventDefault(); dialogRef.current?.focus(); return; }
      if (!dialogRef.current?.contains(document.activeElement) || (!event.shiftKey && document.activeElement === last)) {
        event.preventDefault(); (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault(); last.focus();
      }
    };
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('keydown', handleKey);
      document.body.style.overflow = overflow;
      if (trigger?.isConnected) trigger.focus();
    };
  }, [open, close]);

  useEffect(() => { if (confirmPairing !== null) cancelRef.current?.focus(); }, [confirmPairing]);
  useEffect(() => { if (confirmRecovery) recoveryCancelRef.current?.focus(); }, [confirmRecovery]);
  useEffect(() => { setConfirmPairing(null); }, [required]);
  // The parent bounds recovery and can release this guard after a timeout.
  useEffect(() => { if (!recovering) recoveryAttemptRef.current = null; }, [recovering]);

  const change = async (next: boolean) => {
    if (disabled || changingRef.current) return;
    changingRef.current = true;
    setSaving(true); setError('');
    try { await onChange(next); setConfirmPairing(null); }
    catch { setError('設定未儲存，請稍後再試。'); }
    finally { changingRef.current = false; setSaving(false); }
  };
  const recover = async () => {
    if (recovering || recoveryAttemptRef.current) return;
    const attempt = {};
    recoveryAttemptRef.current = attempt;
    try { await onRecover(); if (recoveryAttemptRef.current === attempt) setConfirmRecovery(false); }
    catch { /* The parent reports recovery failures and controls retry availability. */ }
    finally { if (recoveryAttemptRef.current === attempt) recoveryAttemptRef.current = null; }
  };

  return <>
    <button type="button" className="access-settings-trigger" ref={triggerRef} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16M8 4v4m8 2v4M10 16v4" /></svg>
      設定
    </button>
    {open ? createPortal(<div className="access-settings-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) close(); }}>
      <section className="access-settings-dialog" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} tabIndex={-1} ref={dialogRef}>
        <header className="access-settings-header"><h2 id={`${id}-title`}>設定</h2><button type="button" className="access-settings-close" aria-label="關閉設定" onClick={close}>×</button></header>
        <button type="button" className="access-settings-category" aria-expanded={expanded} aria-controls={`${id}-access`} onClick={() => { setExpanded(value => !value); setConfirmPairing(null); setRepairExpanded(false); setConfirmRecovery(false); }}>
          <span>裝置存取</span><span aria-hidden="true">{expanded ? '−' : '＋'}</span>
        </button>
        {expanded ? <div id={`${id}-access`} className="access-settings-content" aria-busy={disabled}>
          <label className="access-settings-control">
            <span>要求裝置配對</span><span className="access-settings-value">{disabled ? '儲存中…' : required ? '開啟' : '關閉'}</span>
            <input ref={switchRef} className="access-settings-switch-input" type="checkbox" role="switch" aria-label="要求裝置配對" aria-describedby={`${id}-help`} checked={required} disabled={disabled} onChange={event => {
              if (disabled) return;
              setError(''); setConfirmPairing(event.target.checked);
            }} />
            <span className={`access-settings-switch${required ? ' enabled' : ''}`} aria-hidden="true"><span /></span>
          </label>
          <p className="access-settings-help" id={`${id}-help`}>{required ? '新裝置需輸入配對碼，才能接續工作。' : '可連線的裝置目前無須配對。'}</p>
          {confirmPairing !== null ? <div className="access-settings-confirm" role="group" aria-labelledby={`${id}-confirm`}>
            <h3 id={`${id}-confirm`}>{confirmPairing ? '開啟' : '關閉'}裝置配對？</h3>
            <p>{confirmPairing ? '開啟後，未配對的裝置需要配對碼才能使用，包含目前尚未配對的裝置。' : '關閉後，能連上 PocketAgent 的裝置都可操作你的對話與工作，無須配對碼。'}</p>
            <div className="access-settings-actions"><button type="button" ref={cancelRef} disabled={disabled} onClick={() => { setConfirmPairing(null); switchRef.current?.focus(); }}>取消</button><button type="button" className="access-settings-confirm-button" disabled={disabled} onClick={() => { if (confirmPairing !== null) void change(confirmPairing); }}>確認{confirmPairing ? '開啟' : '關閉'}配對</button></div>
          </div> : null}
          {error ? <p className="access-settings-error" role="alert">{error}</p> : null}
        </div> : null}
        <button type="button" className="access-settings-category access-settings-repair-category" aria-expanded={repairExpanded} aria-controls={`${id}-repair`} onClick={() => { setRepairExpanded(value => !value); setConfirmRecovery(false); setExpanded(false); setConfirmPairing(null); }}>
          <span>連線修復</span><span aria-hidden="true">{repairExpanded ? '−' : '＋'}</span>
        </button>
        {repairExpanded ? <div id={`${id}-repair`} className="access-settings-content" aria-busy={recovering}>
          <button type="button" className="access-settings-reconnect" disabled={recovering} onClick={onReconnect}>重新連接網頁</button>
          <p className="access-settings-help">重新取得目前的對話狀態，工作會繼續執行。</p>
          {recovering ? <p className="access-settings-help" role="status">正在重建服務連線…</p> : null}
          {confirmRecovery ? <div className="access-settings-confirm" role="group" aria-labelledby={`${id}-recovery-confirm`}>
            <h3 id={`${id}-recovery-confirm`}>要中斷所有工作嗎？</h3>
            <p>目前所有工作與待核准會中斷；保留對話紀錄，不自動重送訊息。</p>
            <div className="access-settings-actions"><button type="button" ref={recoveryCancelRef} onClick={() => setConfirmRecovery(false)}>取消</button><button type="button" className="access-settings-confirm-button" disabled={recovering} onClick={() => void recover()}>中斷所有工作並重建連線</button></div>
          </div> : <button type="button" className="access-settings-recovery-trigger" disabled={recovering} onClick={() => setConfirmRecovery(true)}>中斷所有工作並重建連線</button>}
        </div> : null}
      </section>
    </div>, document.body) : null}
  </>;
}
