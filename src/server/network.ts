import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import type { FastifyInstance } from 'fastify';
import { isLanAddress, isTailscaleAddress, type AppConfig } from './config.js';

type Interfaces = Record<string, NetworkInterfaceInfo[] | undefined>;
const virtualInterface = /vEthernet|vmware|virtualbox|vbox|docker|podman|wsl|loopback|npcap|hyper-v/i;

/** Discover only private local listeners. Never publish interface metadata or addresses in logs. */
export function discoverAddresses(mode: string, interfaces: Interfaces = networkInterfaces()): string[] {
  if (mode !== 'private' && mode !== 'tailscale') return [mode];
  const addresses = new Set<string>(mode === 'private' ? ['127.0.0.1'] : []);
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      if (/tailscale/i.test(name)) {
        if (isTailscaleAddress(entry.address)) addresses.add(entry.address);
      } else if (mode === 'private' && !virtualInterface.test(name) && entry.mac !== '00:00:00:00:00:00' && isLanAddress(entry.address)) {
        addresses.add(entry.address);
      }
    }
  }
  return [...addresses].sort();
}

interface ListenerOptions {
  addresses?: () => string[];
  intervalMs?: number;
  diagnostic?: (code: string) => void;
}

/** Each IP has its own HTTP boundary; every listener shares the same Codex bridge and Store. */
export class NetworkListeners {
  private apps = new Map<string, FastifyInstance>();
  private inFlight?: Promise<void>;
  private timer?: NodeJS.Timeout;
  private paused = false;
  private first = true;
  constructor(
    private config: AppConfig,
    private createApp: (host: string) => Promise<FastifyInstance>,
    private options: ListenerOptions = {},
  ) {}

  get listeningHosts(): string[] { return [...this.apps.keys()]; }
  private report(code: string) { this.options.diagnostic?.(code); }
  async start() {
    await this.refresh();
    if (!this.paused) {
      this.timer = setInterval(() => void this.refresh().catch(() => this.report('NETWORK_REFRESH_FAILED')), this.options.intervalMs ?? 5000);
      this.timer.unref();
    }
  }
  refresh(): Promise<void> {
    if (this.paused) return Promise.resolve();
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.reconcile().finally(() => { this.inFlight = undefined; });
    return this.inFlight;
  }
  private async dispose(app: FastifyInstance) {
    for (const client of app.websocketServer.clients) client.terminate();
    app.server.closeAllConnections();
    await app.close();
  }
  private async reconcile() {
    const desired = new Set(this.options.addresses?.() ?? discoverAddresses(this.config.host));
    const previousCount = this.apps.size;
    for (const host of desired) {
      if (this.paused) break;
      if (this.apps.has(host)) continue;
      let app: FastifyInstance | undefined;
      try {
        app = await this.createApp(host);
        if (this.paused) { await this.dispose(app); break; }
        await app.listen({ host, port: this.config.port });
        this.apps.set(host, app);
        this.report('HTTP_READY');
      } catch {
        if (app) await this.dispose(app).catch(() => {});
        this.report('HTTP_LISTENER_UNAVAILABLE');
      }
    }
    for (const [host, app] of this.apps) {
      if (!desired.has(host)) {
        this.apps.delete(host);
        await this.dispose(app).catch(() => this.report('HTTP_LISTENER_CLOSE_FAILED'));
      }
    }
    if (!this.apps.size && (previousCount > 0 || this.first)) this.report('WAITING_FOR_PRIVATE_NETWORK');
    this.first = false;
  }
  pause() { this.paused = true; if (this.timer) clearInterval(this.timer); }
  terminateClients() { for (const app of this.apps.values()) for (const client of app.websocketServer.clients) client.terminate(); }
  async close() {
    this.pause();
    await this.inFlight;
    const closed = await Promise.allSettled([...this.apps.values()].map(app => this.dispose(app)));
    if (closed.some(result => result.status === 'rejected')) this.report('HTTP_LISTENER_CLOSE_FAILED');
    this.apps.clear();
  }
}
