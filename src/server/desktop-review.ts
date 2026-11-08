import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ApprovalsReviewer } from '../../.generated/codex/v2/ApprovalsReviewer.js';
import type { AppConfig } from './config.js';

export type DesktopReviewSelection = { approvalsReviewer?: ApprovalsReviewer };

type JsonObject = Record<string, unknown>;
const object = (value: unknown): JsonObject => value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
const localSelectionKey = 'permission-selection-by-host-id:local';

function reviewer(mode: unknown): DesktopReviewSelection {
  // These are desktop mode identifiers, not native permission-profile names.
  return mode === 'guardian-approvals' ? { approvalsReviewer: 'auto_review' } : {};
}

/** Read only the local desktop review choice, afresh for each native operation. */
export async function readDesktopReviewSelection(config: Pick<AppConfig, 'codexHome'>): Promise<DesktopReviewSelection> {
  if (!config.codexHome) return {};
  try {
    const state = object(JSON.parse(await readFile(path.join(config.codexHome, '.codex-global-state.json'), 'utf8')));
    const preferences = object(state['electron-persisted-atom-state']);
    if (Object.hasOwn(preferences, localSelectionKey)) {
      const selection = object(preferences[localSelectionKey]);
      // A custom, unknown or incomplete modern selection supersedes legacy state.
      return selection.kind === 'agent-mode' ? reviewer(selection.agentMode) : {};
    }
    return reviewer(object(preferences['agent-mode-by-host-id']).local);
  } catch {
    // Missing or partially-written preferences must not invent an authorization mode.
    return {};
  }
}
