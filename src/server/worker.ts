import { readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from './config.js';
import { CodexBridge } from './codex.js';
import { createDiagnosticLogger } from './diagnostics.js';
import { resolveCodex } from './launcher.js';
import { Store } from './store.js';
import { WorkerClient } from './worker-client.js';
import { createWorkerServer } from './worker-server.js';
import { WORKER_PROTOCOL_VERSION } from './worker-protocol.js';

async function probe() {
  let client: WorkerClient | undefined;
  try {
    const config = loadConfig();
    client = new WorkerClient({ dataDir: config.dataDir, connectTimeoutMs: 5000 });
    await client.connect();
    console.log('POCKETAGENT_WORKER_READY');
  } catch {
    console.error('POCKETAGENT_WORKER_UNAVAILABLE');
    process.exitCode = 1;
  } finally { client?.close(); }
}

async function run() {
  const config = loadConfig();
  const diagnostic = createDiagnosticLogger(config.dataDir);
  const store = new Store(config.dataDir);
  const bridge = new CodexBridge(resolveCodex(config.codexPath), store, diagnostic);
  const server = createWorkerServer({ dataDir: config.dataDir, bridge, diagnostic });
  const recordPath = path.join(config.dataDir, 'worker.json');
  const record = { pid: process.pid, startedAt: new Date().toISOString(), execPath: process.execPath,
    entrypoint: path.resolve(process.argv[1]), bootGeneration: server.bootGeneration, version: WORKER_PROTOCOL_VERSION };
  let retry: NodeJS.Timeout | undefined;
  let stopping = false;
  async function shutdown(exitCode = 0) {
    if (stopping) return;
    stopping = true;
    if (retry) clearInterval(retry);
    try { await bridge.stop(); }
    catch {
      // Retain ownership of a child whose exit is unconfirmed. A later explicit
      // worker stop can kill this verified process tree without a second writer.
      diagnostic({ component: 'codex', code: 'CODEX_STOP_FAILED', operation: 'shutdown' });
      stopping = false;
      return;
    }
    await server.close();
    store.close();
    try { if (JSON.parse(await readFile(recordPath, 'utf8')).pid === process.pid) await unlink(recordPath); } catch { /* Stale records are verified by the launcher. */ }
    process.exit(exitCode);
  }
  try {
    await server.start(); // The kernel-owned endpoint is the single-worker guard.
    await writeFile(recordPath, JSON.stringify(record), { mode: 0o600 });
    process.on('SIGINT', () => { void shutdown(); });
    process.on('SIGTERM', () => { void shutdown(); });
    process.on('uncaughtException', () => { diagnostic({ component: 'server', code: 'UNCAUGHT_EXCEPTION', operation: 'startup' }); void shutdown(1); });
    process.on('unhandledRejection', () => { diagnostic({ component: 'server', code: 'UNHANDLED_REJECTION', operation: 'startup' }); void shutdown(1); });
    if (!server.maintenance) await bridge.start().catch(() => diagnostic({ component: 'codex', code: 'CODEX_UNAVAILABLE', operation: 'startup' }));
    retry = setInterval(() => {
      if (!stopping && !server.maintenance && bridge.status.codex === 'offline') void bridge.start().catch(() => diagnostic({ component: 'codex', code: 'CODEX_UNAVAILABLE', operation: 'retry' }));
    }, 30_000);
    retry.unref();
  } catch {
    diagnostic({ component: 'server', code: 'STARTUP_FAILED', operation: 'startup' });
    await server.close().catch(() => {});
    store.close();
    process.exitCode = 1;
  }
}

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--probe') void probe();
else if (!args.length) void run().catch(() => { console.error('POCKETAGENT_WORKER_UNAVAILABLE'); process.exitCode = 1; });
else { console.error('POCKETAGENT_WORKER_UNAVAILABLE'); process.exitCode = 1; }
