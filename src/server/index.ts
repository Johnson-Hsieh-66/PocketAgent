import { mkdir, open, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:net';
import { loadConfig } from './config.js';
import { Store } from './store.js';
import { Files } from './files.js';
import { WorkerClient } from './worker-client.js';
import { buildApp } from './http.js';
import { NetworkListeners } from './network.js';
import { ProjectCatalog } from './projects.js';
import type { DiagnosticSink } from './diagnostics.js';

let writeDiagnostic: DiagnosticSink = () => {};

async function main() {
const config = await loadConfig();
const worker = new WorkerClient({ dataDir: config.dataDir });
// The worker is the single diagnostic writer and survives HTTP deployments.
writeDiagnostic = entry => worker.diagnostic(entry);
writeDiagnostic({ component: 'server', code: 'SERVICE_STARTING', operation: 'startup' });
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
let bridge: WorkerClient | undefined;
let store: Store | undefined;
let listeners: NetworkListeners | undefined;
function diagnostic(code: string) { writeDiagnostic({ component: 'server', code, operation: 'startup' }); }
async function clean() {
  if (stopping) return;
  stopping = true;
  writeDiagnostic({ component: 'server', code: 'SERVICE_STOPPING', operation: 'shutdown' });
  listeners?.pause();
  listeners?.terminateClients();
  await worker.close();
  await listeners?.close().catch(() => {});
  store?.close();
  for (const file of [servicePath, lockPath]) {
    try { if (JSON.parse(await readFile(file, 'utf8')).pid === process.pid) await unlink(file); } catch { /* already removed */ }
  }
  if (instanceGuard?.listening) await new Promise<void>(resolve => instanceGuard!.close(() => resolve()));
  writeDiagnostic({ component: 'server', code: 'SERVICE_STOPPED', operation: 'shutdown' });
}
process.on('SIGINT', () => void clean().then(() => process.exit(0)));
process.on('SIGTERM', () => void clean().then(() => process.exit(0)));
process.on('uncaughtException', () => { diagnostic('UNCAUGHT_EXCEPTION'); void clean().then(() => process.exit(1)); });
process.on('unhandledRejection', () => { diagnostic('UNHANDLED_REJECTION'); void clean().then(() => process.exit(1)); });
try {
  if (!stopping) {
    store = new Store(config.dataDir);
    bridge = worker;
    const catalog = new ProjectCatalog(config, bridge);
    const files = new Files(config, store, catalog);
    const shared = { store, bridge, files, diagnostic: writeDiagnostic, disconnectClients: () => listeners?.terminateClients() };
    listeners = new NetworkListeners(config, host => buildApp({ config: { ...config, host }, ...shared }), {
      diagnostic: code => writeDiagnostic({ component: 'network', code, operation: 'listeners' }),
    });
    await listeners.start();
    await bridge.connect().catch(() => diagnostic('WORKER_UNAVAILABLE'));
    const retry = setInterval(() => { if (!stopping) void worker.connect().catch(() => diagnostic('WORKER_UNAVAILABLE')); }, 5000);
    retry.unref();
  }
} catch { diagnostic('STARTUP_FAILED'); await clean(); process.exitCode = 1; }
}
void main().catch(() => {
  writeDiagnostic({ component: 'server', code: 'BOOTSTRAP_FAILED', operation: 'startup' });
  process.exit(1);
});
