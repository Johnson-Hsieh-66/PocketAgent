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
  codexHome?: string;
  staticDir?: string;
  checkoutDir: string;
  releaseId?: string;
}

function ipv4Parts(host: string): number[] | null {
  const octets = host.split('.');
  if (octets.length !== 4 || octets.some(octet => !/^(0|[1-9]\d{0,2})$/.test(octet) || Number(octet) > 255)) return null;
  return octets.map(Number);
}

export function isLanAddress(host: string): boolean {
  const parts = ipv4Parts(host);
  return !!parts && (parts[0] === 10 || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 192 && parts[1] === 168));
}

export function isTailscaleAddress(host: string): boolean {
  const parts = ipv4Parts(host);
  return !!parts && parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
}

export function isLoopbackAddress(host: string): boolean {
  const parts = ipv4Parts(host);
  return !!parts && parts[0] === 127;
}

export function isAllowedHost(host: string): boolean {
  return host === 'private' || host === 'tailscale' || isLanAddress(host) || isTailscaleAddress(host) || isLoopbackAddress(host);
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
  const applicationDir = checkoutDir;
  if (env.POCKETAGENT_CHECKOUT_DIR) {
    const original = realpathSync(path.resolve(env.POCKETAGENT_CHECKOUT_DIR));
    if (JSON.parse(readFileSync(path.join(original, 'package.json'), 'utf8')).name !== 'pocketagent') throw new Error('CHECKOUT_NOT_FOUND');
    checkoutDir = original;
  }
  const localBase = env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share');
  let dataDir = path.resolve(env.POCKETAGENT_DATA_DIR || path.join(localBase, 'PocketAgent'));
  if (isWithin(checkoutDir, dataDir) || isWithin(applicationDir, dataDir)) throw new Error('RUNTIME_DIRECTORY_INSIDE_CHECKOUT');
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  dataDir = realpathSync(dataDir);
  checkoutDir = realpathSync(checkoutDir);
  if (isWithin(checkoutDir, dataDir) || isWithin(realpathSync(applicationDir), dataDir)) throw new Error('RUNTIME_DIRECTORY_INSIDE_CHECKOUT');
  const configPath = path.join(dataDir, 'config.json');
  if (!existsSync(configPath)) {
    writeFileSync(configPath, JSON.stringify({ host: 'private', port: 47831 }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  }
  const saved: Record<string, unknown> = JSON.parse(readFileSync(configPath, 'utf8'));
  const host = env.POCKETAGENT_HOST || (typeof saved.host === 'string' ? saved.host : 'private');
  const port = Number(env.POCKETAGENT_PORT || saved.port || 47831);
  if (!isAllowedHost(host)) throw new Error('HOST_MUST_BE_PRIVATE_OR_LOOPBACK_IPV4');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('INVALID_PORT');
  if (saved.projectRoots !== undefined && (!Array.isArray(saved.projectRoots) || saved.projectRoots.some(root => typeof root !== 'string' || !path.isAbsolute(root)))) throw new Error('INVALID_PROJECT_ROOTS');
  const projectRoots = saved.projectRoots === undefined ? [] : saved.projectRoots as string[];
  const codexPath = env.POCKETAGENT_CODEX_PATH || (typeof saved.codexPath === 'string' ? saved.codexPath : undefined);
  const releaseId = env.POCKETAGENT_RELEASE_ID;
  if (releaseId !== undefined && !/^[a-zA-Z0-9_-]{1,80}$/.test(releaseId)) throw new Error('INVALID_RELEASE_ID');
  return { host, port, dataDir, checkoutDir, projectRoots, codexPath, codexHome: path.resolve(env.CODEX_HOME || path.join(os.homedir(), '.codex')), staticDir: path.join(applicationDir, 'dist', 'client'), ...(releaseId ? { releaseId } : {}) };
}
