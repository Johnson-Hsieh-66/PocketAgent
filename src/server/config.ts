import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface AppConfig {
  host: string;
  port: number;
  dataDir: string;
  projectRoots: string[];
  codexPath?: string;
  staticDir?: string;
  checkoutDir: string;
}

export function isAllowedHost(host: string): boolean {
  if (host === 'tailscale') return true;
  const parts = host.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part, i) => !/^\d+$/.test(host.split('.')[i]) || part < 0 || part > 255)) return false;
  return parts[0] === 127 || (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127);
}

export function isWithin(parent: string, candidate: string): boolean {
  const normalize = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
  const relative = path.relative(normalize(parent), normalize(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  let checkoutDir = path.dirname(fileURLToPath(import.meta.url));
  while (true) {
    const manifest = path.join(checkoutDir, 'package.json');
    if (existsSync(manifest) && JSON.parse(readFileSync(manifest, 'utf8')).name === 'pocketagent') break;
    const parent = path.dirname(checkoutDir);
    if (parent === checkoutDir) throw new Error('CHECKOUT_NOT_FOUND');
    checkoutDir = parent;
  }
  const localBase = env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share');
  let dataDir = path.resolve(env.POCKETAGENT_DATA_DIR || path.join(localBase, 'PocketAgent'));
  if (isWithin(checkoutDir, dataDir)) throw new Error('RUNTIME_DIRECTORY_INSIDE_CHECKOUT');
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  dataDir = realpathSync(dataDir);
  checkoutDir = realpathSync(checkoutDir);
  if (isWithin(checkoutDir, dataDir)) throw new Error('RUNTIME_DIRECTORY_INSIDE_CHECKOUT');
  const configPath = path.join(dataDir, 'config.json');
  if (!existsSync(configPath)) {
    writeFileSync(configPath, JSON.stringify({ host: 'tailscale', port: 3000, projectRoots: [path.dirname(checkoutDir)] }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  }
  const saved: Record<string, unknown> = JSON.parse(readFileSync(configPath, 'utf8'));
  const host = env.POCKETAGENT_HOST || (typeof saved.host === 'string' ? saved.host : 'tailscale');
  const port = Number(env.POCKETAGENT_PORT || saved.port || 3000);
  if (!isAllowedHost(host)) throw new Error('HOST_MUST_BE_TAILSCALE_OR_LOOPBACK_IPV4');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('INVALID_PORT');
  if (!Array.isArray(saved.projectRoots) || !saved.projectRoots.length || saved.projectRoots.some(root => typeof root !== 'string' || !path.isAbsolute(root))) throw new Error('INVALID_PROJECT_ROOTS');
  const codexPath = env.POCKETAGENT_CODEX_PATH || (typeof saved.codexPath === 'string' ? saved.codexPath : undefined);
  return { host, port, dataDir, checkoutDir, projectRoots: saved.projectRoots as string[], codexPath, staticDir: path.join(checkoutDir, 'dist', 'client') };
}
