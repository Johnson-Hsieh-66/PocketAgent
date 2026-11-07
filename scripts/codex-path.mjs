import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function resolveCodex(explicit, { localFirst = false } = {}) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const local = path.join(root, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  const global = process.env.APPDATA && path.join(process.env.APPDATA, 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  const paths = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const chosen = explicit ?? process.env.POCKETAGENT_CODEX_PATH;
  if (chosen && !existsSync(chosen)) throw new Error('CODEX_CONFIGURED_PATH_NOT_FOUND');
  const candidates = [chosen, ...(localFirst ? [local, global] : [global, local]), ...paths.map(p => path.join(p, process.platform === 'win32' ? 'codex.exe' : 'codex'))];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      const full = path.resolve(candidate);
      if (/\.(cmd|ps1|bat)$/i.test(full)) throw new Error('CODEX_PATH_MUST_BE_JS_OR_EXECUTABLE');
      return /\.[cm]?js$/i.test(full) ? { command: process.execPath, args: [full] } : { command: full, args: [] };
    }
  }
  throw new Error('CODEX_NOT_FOUND');
}
