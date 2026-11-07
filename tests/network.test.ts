import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import os, { type NetworkInterfaceInfo } from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { discoverAddresses, NetworkListeners } from '../src/server/network.js';
import type { AppConfig } from '../src/server/config.js';
import type { AppEvent, PendingRequest, ServiceStatus } from '../src/shared/types.js';
import { buildApp } from '../src/server/http.js';
import { Store } from '../src/server/store.js';
import { Files } from '../src/server/files.js';

// Every address and adapter below is a constructed fixture, never machine metadata.
const ip = (octets: number[]) => octets.join('.');
const loopback = ip([127, 0, 0, 1]);
const alias = ip([127, 0, 0, 2]);
function interfaceEntry(address: string, overrides: Partial<NetworkInterfaceInfo> = {}): NetworkInterfaceInfo {
  return {
    address,
    family: 'IPv4',
    internal: false,
    netmask: ip([255, 255, 255, 0]),
    mac: [2, 0, 0, 0, 0, 1].map(value => value.toString(16).padStart(2, '0')).join(':'),
    cidr: null,
    ...overrides,
  } as NetworkInterfaceInfo;
}

describe('private address discovery', () => {
  const lanAddresses = [ip([10, 44, 0, 8]), ip([172, 22, 8, 6]), ip([192, 168, 77, 4])];
  const tailAddress = ip([100, 90, 80, 70]);
  const fixtures = {
    'Synthetic physical ethernet': lanAddresses.map(address => interfaceEntry(address)),
    'Synthetic Tailscale adapter': [interfaceEntry(tailAddress), interfaceEntry(ip([10, 20, 30, 40]))],
    'Synthetic public adapter': [interfaceEntry(ip([203, 0, 113, 24]))],
    'Synthetic unassigned adapter': [interfaceEntry(ip([169, 254, 12, 3]))],
    'Synthetic carrier adapter': [interfaceEntry(ip([100, 80, 70, 60]))],
    'Synthetic local adapter': [interfaceEntry(ip([127, 0, 0, 4]), { internal: true })],
    'Synthetic ipv6 adapter': [interfaceEntry(['2001', 'db8', '', '1'].join(':'), { family: 'IPv6' })],
    'Synthetic no hardware identity': [interfaceEntry(ip([10, 9, 8, 7]), { mac: Array(6).fill('00').join(':') })],
    'vEthernet (Synthetic fixture)': [interfaceEntry(ip([10, 1, 1, 1]))],
    'Synthetic VMware fixture': [interfaceEntry(ip([172, 18, 1, 1]))],
    'Synthetic VirtualBox fixture': [interfaceEntry(ip([192, 168, 55, 1]))],
    'Synthetic Docker fixture': [interfaceEntry(ip([172, 19, 1, 1]))],
    'Synthetic WSL fixture': [interfaceEntry(ip([172, 20, 1, 1]))],
    'Synthetic unavailable adapter': undefined,
  };

  it('includes loopback, physical RFC1918 and Tailscale while rejecting unsafe or virtual adapters', () => {
    expect(discoverAddresses('private', fixtures)).toEqual([loopback, ...lanAddresses, tailAddress].sort());
  });

  it('never adds LAN or loopback to Tailscale-only mode', () => {
    expect(discoverAddresses('tailscale', fixtures)).toEqual([tailAddress]);
    expect(discoverAddresses('tailscale', { 'Synthetic physical ethernet': fixtures['Synthetic physical ethernet'] })).toEqual([]);
  });

  it('keeps an explicitly selected address isolated from discovery', () => {
    const explicit = ip([192, 168, 9, 9]);
    expect(discoverAddresses(explicit, fixtures)).toEqual([explicit]);
  });
});

class SyntheticBridge extends EventEmitter {
  status: ServiceStatus = { codex: 'ready', authenticated: true };
  pendingRequests: PendingRequest[] = [];
  history: AppEvent[] = [];
  interrupt = vi.fn(async () => ({}));
  startTurn = vi.fn(async () => ({}));
  respond = vi.fn();
  request = vi.fn(async () => ({}));
  eventsSince(after: number) { return { events: this.history.filter(event => event.seq > after), reset: false }; }
  publish(event: AppEvent) { this.history.push(event); this.emit('event', event); }
}

async function unusedPort(): Promise<number> {
  const server = createServer();
  server.listen(0, loopback);
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('SYNTHETIC_PORT_UNAVAILABLE');
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

function waitForEvent(socket: WebSocket, method: string): Promise<AppEvent> {
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); socket.off('message', receive); socket.off('close', closed); };
    const receive = (data: WebSocket.RawData) => {
      const event = JSON.parse(data.toString()) as AppEvent;
      if (event.method === method) { cleanup(); resolve(event); }
    };
    const closed = () => { cleanup(); reject(new Error('SOCKET_CLOSED_BEFORE_EVENT')); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('SYNTHETIC_EVENT_TIMEOUT')); }, 3000);
    socket.on('message', receive);
    socket.on('close', closed);
  });
}

describe('shared private network listeners', () => {
  let temp: string | undefined;
  let listeners: NetworkListeners | undefined;
  let store: Store | undefined;
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.terminate();
    await listeners?.close();
    store?.close();
    if (temp) await rm(temp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    temp = undefined; listeners = undefined; store = undefined;
  });

  it('shares authentication and events while isolating origins and reconciling addresses without interrupting Codex', async () => {
    temp = await mkdtemp(path.join(os.tmpdir(), 'pocketagent-network-test-'));
    const projectRoot = path.join(temp, 'projects');
    const desktopProject = { id: 'synthetic-desktop-project', name: 'Synthetic project', path: path.join(projectRoot, 'Synthetic project') };
    await mkdir(desktopProject.path, { recursive: true });
    const port = await unusedPort();
    const config: AppConfig = { host: 'private', port, dataDir: path.join(temp, 'runtime'), checkoutDir: path.join(temp, 'checkout'), projectRoots: [projectRoot] };
    store = new Store(config.dataDir);
    const sharedStore = store;
    const files = new Files(config, sharedStore, { projects: async () => [desktopProject] });
    const bridge = new SyntheticBridge();
    let addresses = [loopback];
    listeners = new NetworkListeners(config, host => buildApp({ config: { ...config, host }, store: sharedStore, files, bridge }), { addresses: () => addresses, intervalMs: 60_000 });
    await listeners.start();
    expect(listeners.listeningHosts).toEqual([loopback]);

    const origin = (host: string) => `http://${host}:${port}`;
    const request = (host: string, pathname: string, cookie?: string, options: RequestInit = {}) => fetch(`${origin(host)}${pathname}`, { ...options, headers: { origin: origin(host), ...(cookie ? { cookie } : {}), ...options.headers }, signal: AbortSignal.timeout(3000) });
    const pair = async (host: string, name: string) => {
      const { code } = sharedStore.issuePairCode();
      const response = await request(host, '/api/auth/pair', undefined, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, deviceName: name }) });
      expect(response.status).toBe(200);
      const setCookie = response.headers.get('set-cookie')!;
      expect(setCookie).toContain('HttpOnly');
      expect(setCookie).not.toMatch(/(?:^|;)\s*domain=/i);
      await response.arrayBuffer();
      return setCookie.split(';')[0];
    };
    const firstCookie = await pair(loopback, 'Synthetic loopback browser');
    expect((await request(loopback, '/api/status', firstCookie)).status).toBe(200);
    addresses = [loopback, alias];
    await listeners.refresh();
    expect(listeners.listeningHosts.sort()).toEqual([loopback, alias].sort());
    // A browser's host-only cookie is not automatically available on another host.
    expect((await request(alias, '/api/status')).status).toBe(401);
    // The service shares the Store, so an explicitly supplied valid token is recognized.
    expect((await request(alias, '/api/status', firstCookie)).status).toBe(200);
    const secondCookie = await pair(alias, 'Synthetic alias browser');
    expect(secondCookie).not.toBe(firstCookie);
    expect(sharedStore.devices()).toHaveLength(2);
    const rejectedOrigin = await request(alias, '/api/status', secondCookie, { headers: { origin: origin(loopback) } });
    expect(rejectedOrigin.status).toBe(403);

    const connect = async (host: string, cookie: string, browserOrigin = origin(host)) => {
      const socket = new WebSocket(`ws://${host}:${port}/api/events?after=0`, { headers: { origin: browserOrigin, cookie } });
      sockets.push(socket);
      await once(socket, 'open');
      return socket;
    };
    const firstSocket = await connect(loopback, firstCookie);
    const secondSocket = await connect(alias, secondCookie);
    const firstEvent = waitForEvent(firstSocket, 'synthetic/shared-event');
    const secondEvent = waitForEvent(secondSocket, 'synthetic/shared-event');
    bridge.publish({ seq: 1, method: 'synthetic/shared-event', params: { synthetic: true } });
    expect((await firstEvent).seq).toBe(1);
    expect((await secondEvent).seq).toBe(1);
    await expect(connect(alias, secondCookie, origin(loopback))).rejects.toThrow();

    const removedSocketClosed = once(secondSocket, 'close');
    addresses = [loopback];
    await listeners.refresh();
    await removedSocketClosed;
    expect(listeners.listeningHosts).toEqual([loopback]);
    expect((await request(loopback, '/api/status', firstCookie)).status).toBe(200);
    expect(firstSocket.readyState).toBe(WebSocket.OPEN);
    await vi.waitFor(() => expect(bridge.listenerCount('event')).toBe(1), { timeout: 1000, interval: 10 });
    expect(bridge.interrupt).not.toHaveBeenCalled();

    addresses = [loopback, alias];
    await listeners.refresh();
    expect(listeners.listeningHosts.sort()).toEqual([loopback, alias].sort());
    expect((await request(alias, '/api/status', secondCookie)).status).toBe(200);
    const replacementSocket = await connect(alias, secondCookie);
    const survivingEvent = waitForEvent(firstSocket, 'synthetic/after-refresh');
    const replacementEvent = waitForEvent(replacementSocket, 'synthetic/after-refresh');
    bridge.publish({ seq: 2, method: 'synthetic/after-refresh', params: { synthetic: true } });
    await Promise.all([survivingEvent, replacementEvent]);
    expect(bridge.interrupt).not.toHaveBeenCalled();

    listeners.pause();
    addresses = [loopback];
    await listeners.refresh();
    expect(listeners.listeningHosts.sort()).toEqual([loopback, alias].sort());

    const closed = [firstSocket, replacementSocket].map(socket => once(socket, 'close'));
    await listeners.close();
    await Promise.all(closed);
    expect(listeners.listeningHosts).toEqual([]);
    await vi.waitFor(() => expect(bridge.listenerCount('event')).toBe(0), { timeout: 1000, interval: 10 });
    await expect(request(loopback, '/api/auth')).rejects.toThrow();
    await expect(request(alias, '/api/auth')).rejects.toThrow();
    expect(bridge.interrupt).not.toHaveBeenCalled();
  }, 20_000);
});
