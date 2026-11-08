// @vitest-environment happy-dom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { AccessSettings, type AccessSettingsProps } from '../src/client/AccessSettings';

describe('device access settings', () => {
  let container: HTMLDivElement;
  let root: Root;
  let change: Mock<AccessSettingsProps['onChange']>;
  let reconnect: Mock<AccessSettingsProps['onReconnect']>;
  let recover: Mock<AccessSettingsProps['onRecover']>;
  const render = async (props: Partial<AccessSettingsProps> = {}) => {
    await act(async () => { root.render(createElement(AccessSettings, { required: true, busy: false, onChange: change, onReconnect: reconnect, onRecover: recover, recovering: false, ...props })); });
  };
  const button = (text: string) => {
    const result = Array.from(document.querySelectorAll('button')).find(entry => entry.textContent?.trim() === text);
    if (!result) throw new Error('SYNTHETIC_SETTINGS_BUTTON_NOT_FOUND');
    return result;
  };
  const click = async (element: HTMLElement) => { await act(async () => { element.click(); }); };
  const toggle = () => document.querySelector<HTMLInputElement>('input[role="switch"]')!;
  const expand = async () => { await click(button('設定')); await click(button('裝置存取＋')); };

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div'); document.body.append(container);
    root = createRoot(container);
    change = vi.fn();
    reconnect = vi.fn(); recover = vi.fn();
  });
  afterEach(async () => {
    await act(async () => { root.unmount(); });
    container.remove();
    vi.unstubAllGlobals();
  });

  it('keeps the pairing control behind settings and the device access category', async () => {
    await render();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(toggle()).toBeNull();
    await click(button('設定'));
    expect(document.querySelector('[role="dialog"]')?.getAttribute('aria-modal')).toBe('true');
    expect(toggle()).toBeNull();
    await click(button('裝置存取＋'));
    expect(toggle().checked).toBe(true);
    expect(toggle().getAttribute('aria-label')).toBe('要求裝置配對');
    expect(change).not.toHaveBeenCalled();
  });

  it('requires an explicit confirmation before disabling pairing', async () => {
    await render(); await expand();
    await click(toggle());
    expect(change).not.toHaveBeenCalled();
    expect(toggle().checked).toBe(true);
    expect(document.body.textContent).toContain('裝置都可操作你的對話與工作，無須配對碼');
    expect(document.activeElement).toBe(button('取消'));
    await click(button('確認關閉配對'));
    expect(change).toHaveBeenCalledExactlyOnceWith(false);
  });

  it('cancels a pending disable without changing access', async () => {
    await render(); await expand();
    await click(toggle()); await click(button('取消'));
    expect(change).not.toHaveBeenCalled();
    expect(toggle().checked).toBe(true);
    expect(document.body.textContent).not.toContain('確認關閉配對');
    expect(document.activeElement).toBe(toggle());
  });

  it('explains the lockout consequence and confirms before enabling pairing', async () => {
    await render({ required: false }); await expand();
    await click(toggle());
    expect(change).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('包含目前尚未配對的裝置');
    await click(button('確認開啟配對'));
    expect(change).toHaveBeenCalledExactlyOnceWith(true);
    expect(document.body.textContent).not.toContain('確認關閉配對');
  });

  it('disables changes while a save is running and prevents duplicate submissions', async () => {
    let complete!: () => void;
    change.mockReturnValue(new Promise<void>(resolve => { complete = resolve; }));
    await render(); await expand(); await click(toggle());
    await click(button('確認關閉配對'));
    expect(toggle().disabled).toBe(true);
    expect(button('確認關閉配對').disabled).toBe(true);
    await click(button('確認關閉配對'));
    expect(change).toHaveBeenCalledTimes(1);
    await act(async () => { complete(); });
    await render({ busy: true });
    expect(toggle().disabled).toBe(true);
    await click(toggle());
    expect(change).toHaveBeenCalledTimes(1);
  });

  it('keeps keyboard focus inside the dialog and restores the settings button after Escape', async () => {
    await render();
    const trigger = button('設定');
    await expand();
    const close = document.querySelector<HTMLButtonElement>('button[aria-label="關閉設定"]')!;
    expect(document.activeElement).toBe(close);
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true })); });
    expect(document.activeElement).toBe(button('連線修復＋'));
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })); });
    expect(document.activeElement).toBe(close);
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(change).not.toHaveBeenCalled();
  });

  it('keeps reconnect and disruptive recovery separate and confirms recovery before calling it', async () => {
    await render(); await click(button('設定'));
    expect(document.body.textContent).not.toContain('中斷所有工作並重建連線');
    await click(button('連線修復＋'));
    await click(button('重新連接網頁'));
    expect(reconnect).toHaveBeenCalledTimes(1);
    expect(recover).not.toHaveBeenCalled();
    await click(button('中斷所有工作並重建連線'));
    expect(recover).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('目前所有工作與待核准會中斷；保留對話紀錄，不自動重送訊息');
    await click(button('取消'));
    expect(recover).not.toHaveBeenCalled();
    await click(button('中斷所有工作並重建連線'));
    await click(button('中斷所有工作並重建連線'));
    expect(recover).toHaveBeenCalledTimes(1);
    expect(change).not.toHaveBeenCalled();
  });

  it('blocks duplicate recovery and permits another attempt when the parent releases its timeout state', async () => {
    let finish!: () => void;
    recover.mockReturnValue(new Promise<void>(resolve => { finish = resolve; }));
    await render(); await click(button('設定')); await click(button('連線修復＋'));
    await click(button('中斷所有工作並重建連線'));
    await click(button('中斷所有工作並重建連線'));
    await click(button('中斷所有工作並重建連線'));
    expect(recover).toHaveBeenCalledTimes(1);
    await render({ recovering: true });
    expect(button('中斷所有工作並重建連線').disabled).toBe(true);
    expect(button('重新連接網頁').disabled).toBe(true);
    await click(button('中斷所有工作並重建連線'));
    expect(recover).toHaveBeenCalledTimes(1);
    await render({ recovering: false });
    recover.mockResolvedValue(undefined);
    await click(button('中斷所有工作並重建連線'));
    expect(recover).toHaveBeenCalledTimes(2);
    await act(async () => { finish(); });
  });
});
