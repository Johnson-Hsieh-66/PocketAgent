import { mkdir, open, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { networkInterfaces } from 'node:os';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig } from './config.js';
import { Store } from './store.js';
import { Files } from './files.js';
import { CodexBridge } from './codex.js';
import { buildApp } from './http.js';
import { resolveCodex } from './launcher.js';

async function main() {
const config = await loadConfig();
await mkdir(config.dataDir, { recursive: true });
const servicePath = path.join(config.dataDir, 'service.json');
const lockPath = path.join(config.dataDir, 'service.lock');
const entrypoint = path.resolve(process.argv[1]);
const service = { pid: process.pid, startedAt: new Date().toISOString(), execPath: process.execPath, entrypoint };
let instanceGuard: Server | undefined;
async function lock() {
  if (process.platform === 'win32') {
    // A kernel-owned pipe lock vanishes on exit, so recycled PIDs cannot block login startup.
    const key = createHash('sha256').update(config.dataDir.toLowerCase()).digest('hex').slice(0, 24);
    instanceGuard = createServer(socket => socket.destroy());
    await new Promise<void>((resolve, reject) => {
      instanceGuard!.once('error', () => reject(new Error('SERVICE_ALREADY_RUNNING')));
      instanceGuard!.listen(`\\\\.\\pipe\\pocketagent-${key}`, () => resolve());
    });
    await writeFile(lockPath, JSON.stringify(service), { mode: 0o600 });
    return;
  }
  try {
    const handle = await open(lockPath, 'wx');
    await handle.writeFile(JSON.stringify(service)); await handle.close();
  } catch (error: any) {
    if (error.code !== 'EEXIST') throw error;
    let old: { pid?: number };
    try { old = JSON.parse(await readFile(lockPath, 'utf8')); } catch { throw new Error('INVALID_SERVICE_LOCK'); }
    if (!Number.isSafeInteger(old.pid) || old.pid! <= 0) throw new Error('INVALID_SERVICE_LOCK');
    try { process.kill(old.pid!, 0); throw new Error('SERVICE_ALREADY_RUNNING'); } catch (check: any) { if (check.code !== 'ESRCH') throw check; }
    await unlink(lockPath);
    const handle = await open(lockPath, 'wx');
    await handle.writeFile(JSON.stringify(service)); await handle.close();
  }
}
await lock();
await writeFile(servicePath, JSON.stringify(service), { mode: 0o600 });
let stopping = false;
let bridge: CodexBridge | undefined;
let store: Store | undefined;
let app: Awaited<ReturnType<typeof buildApp>> | undefined;
function diagnostic(code: string) { process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), code })}\n`); }
async function clean() {
  if (stopping) return;
  stopping = true;
  if (app) for (const client of app.websocketServer.clients) client.terminate();
  await bridge?.stop().catch(() => {});
  await app?.close().catch(() => {});
  store?.close();
  for (const file of [servicePath, lockPath]) {
    try { if (JSON.parse(await readFile(file, 'utf8')).pid === process.pid) await unlink(file); } catch { /* already removed */ }
  }
  if (instanceGuard?.listening) await new Promise<void>(resolve => instanceGuard!.close(() => resolve()));
}
process.on('SIGINT', () => void clean().then(() => process.exit(0)));
process.on('SIGTERM', () => void clean().then(() => process.exit(0)));
process.on('uncaughtException', () => { diagnostic('UNCAUGHT_EXCEPTION'); void clean().then(() => process.exit(1)); });
process.on('unhandledRejection', () => { diagnostic('UNHANDLED_REJECTION'); void clean().then(() => process.exit(1)); });
function tailscaleAddress() {
  for (const [name, values] of Object.entries(networkInterfaces())) for (const ip of values ?? []) {
    const [a, b] = ip.address.split('.').map(Number);
    if (/tailscale/i.test(name) && ip.family === 'IPv4' && a === 100 && b >= 64 && b <= 127 && !ip.internal) return ip.address;
  }
  return undefined;
}
try {
  if (config.host === 'tailscale') {
    diagnostic('WAITING_FOR_TAILSCALE');
    while (!stopping) { const host = tailscaleAddress(); if (host) { config.host = host; break; } await delay(5000); }
  }
  if (!stopping) {
    store = new Store(config.dataDir);
    bridge = new CodexBridge(resolveCodex(config.codexPath), store);
    const files = new Files(config, store);
    app = await buildApp({ config, store, bridge, files });
    await app.listen({ host: config.host, port: config.port });
    diagnostic('HTTP_READY');
    await bridge.start().catch(() => diagnostic('CODEX_UNAVAILABLE'));
    const retry = setInterval(() => { if (!stopping && bridge?.status.codex === 'offline') void bridge.start().catch(() => diagnostic('CODEX_UNAVAILABLE')); }, 30_000);
    retry.unref();
  }
} catch { diagnostic('STARTUP_FAILED'); await clean(); process.exitCode = 1; }
}
void main().catch(() => {
  process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), code: 'BOOTSTRAP_FAILED' })}\n`);
  process.exit(1);
});
