import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolveCodex } from './codex-path.mjs';
const out = new URL('../.generated/codex/', import.meta.url);
mkdirSync(out, { recursive: true });
const { fileURLToPath } = await import('node:url');
const executable = resolveCodex();
const result = spawnSync(executable.command, [...executable.args, 'app-server', 'generate-ts', '--experimental', '--out', fileURLToPath(out)], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
if (result.status !== 0) { console.error('Codex protocol generation failed. Check CLI installation.'); process.exit(1); }
console.log('Codex protocol types generated.');
