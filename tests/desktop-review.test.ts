import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readDesktopReviewSelection } from '../src/server/desktop-review.js';

describe('local desktop review preferences', () => {
  let temporary: string;
  let statePath: string;
  const selectionKey = 'permission-selection-by-host-id:local';
  const legacy = { 'agent-mode-by-host-id': { local: 'guardian-approvals' } };
  const writePreferences = async (preferences: unknown) => writeFile(statePath, JSON.stringify({ 'electron-persisted-atom-state': preferences }));
  const read = () => readDesktopReviewSelection({ codexHome: temporary });

  beforeEach(async () => {
    temporary = await mkdtemp(path.join(os.tmpdir(), 'pocketagent-desktop-review-test-'));
    statePath = path.join(temporary, '.codex-global-state.json');
  });
  afterEach(async () => {
    const target = path.resolve(temporary);
    if (!target.startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(target).startsWith('pocketagent-desktop-review-test-')) throw new Error('UNEXPECTED_TEST_DIRECTORY');
    await rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it('maps the explicitly selected local automatic review mode to the native reviewer only', async () => {
    await writePreferences({ [selectionKey]: { kind: 'agent-mode', agentMode: 'guardian-approvals' } });
    expect(await read()).toEqual({ approvalsReviewer: 'auto_review' });
  });

  it('supports the older local mode map when no modern selection exists', async () => {
    await writePreferences(legacy);
    expect(await read()).toEqual({ approvalsReviewer: 'auto_review' });
  });

  it('gives the modern local choice precedence over a conflicting legacy mode', async () => {
    await writePreferences({ 'agent-mode-by-host-id': { local: 'synthetic-unknown-mode' }, [selectionKey]: { kind: 'agent-mode', agentMode: 'guardian-approvals' } });
    expect(await read()).toEqual({ approvalsReviewer: 'auto_review' });
  });

  it.each([
    { kind: 'permission-profile', profileId: 'synthetic-profile' },
    { kind: 'custom' },
    { kind: 'agent-mode', agentMode: 'synthetic-future-mode' },
    { kind: 'agent-mode' },
    { agentMode: 'guardian-approvals' },
    null,
    [],
    'guardian-approvals',
  ])('does not reuse a stale legacy choice for modern selection %j', async selection => {
    await writePreferences({ ...legacy, [selectionKey]: selection });
    expect(await read()).toEqual({});
  });

  it('never takes another host selection or a preferred mode as the local choice', async () => {
    await writePreferences({
      'permission-selection-by-host-id:synthetic-remote': { kind: 'agent-mode', agentMode: 'guardian-approvals' },
      'agent-mode-by-host-id': { 'synthetic-remote': 'guardian-approvals' },
      'preferred-non-full-access-agent-mode-by-host-id': { local: 'guardian-approvals' },
    });
    expect(await read()).toEqual({});
  });

  it('ignores unknown legacy modes instead of substituting a reviewer', async () => {
    await writePreferences({ 'agent-mode-by-host-id': { local: 'synthetic-future-mode' } });
    expect(await read()).toEqual({});
  });

  it('rereads rewritten and temporarily partial preferences without retaining a previous choice', async () => {
    await writePreferences({ [selectionKey]: { kind: 'agent-mode', agentMode: 'guardian-approvals' } });
    expect(await read()).toEqual({ approvalsReviewer: 'auto_review' });
    await writeFile(statePath, '{');
    expect(await read()).toEqual({});
    await writePreferences({ [selectionKey]: { kind: 'permission-profile', profileId: 'synthetic-profile' } });
    expect(await read()).toEqual({});
    await writePreferences(legacy);
    expect(await read()).toEqual({ approvalsReviewer: 'auto_review' });
  });

  it('leaves desktop preferences byte-for-byte unchanged', async () => {
    await writePreferences({ [selectionKey]: { kind: 'agent-mode', agentMode: 'guardian-approvals' }, unrelated: { synthetic: true } });
    const before = await readFile(statePath, 'utf8');
    await read();
    expect(await readFile(statePath, 'utf8')).toBe(before);
  });

  it('returns no override when home or the preference file is absent', async () => {
    expect(await readDesktopReviewSelection({})).toEqual({});
    expect(await read()).toEqual({});
  });

  it.each([null, [], 'synthetic', { 'electron-persisted-atom-state': null }])('ignores malformed desktop state %j', async state => {
    await writeFile(statePath, JSON.stringify(state));
    expect(await read()).toEqual({});
  });
});
