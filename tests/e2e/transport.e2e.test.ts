import { afterEach, describe, expect, it } from 'vitest';
import { count, Node, ports, sleep, startNode, tmpRoot, until } from './harness';

let nodes: Node[] = [];
let servers: any[] = [];
afterEach(async () => {
  for (const n of nodes) await n.coord.stop().catch(() => undefined);
  for (const s of servers) s.close();
  nodes = [];
  servers = [];
});

/**
 * Start a node without UDP discovery, so nodes of other test files on this
 * machine do not find it; discovery is simulated through `seen`.
 */
async function node(tag: string, deviceId: string, port: number, peers: number[], extra = {}) {
  const n = await startNode(tmpRoot(tag), deviceId, port, peers, extra);
  (n.coord as any).discovery.udp?.stop();
  nodes.push(n);
  return n;
}

/** Report a device to a node's discovery, as a UDP broadcast would. */
function seen(n: Node, deviceId: string, port: number, vaultId = (n.coord as any).vaultId) {
  (n.coord as any).discovery._handleDeviceSeen({
    deviceId, deviceName: deviceId, ip: '127.0.0.1', port, vaultId,
    lastSeen: Date.now(), acceptsIncomingConnections: true,
  });
}

/** Let a node's discovery time out a device it has not heard from. */
function lose(n: Node, deviceId: string) {
  const discovery = (n.coord as any).discovery;
  discovery.devices.get(deviceId).lastSeen = 0;
  discovery._cleanupStale();
}

/**
 * A listener that takes each connection and closes it at the first message,
 * as a device of another vault (or with an older plugin) does.
 */
function refusingServer(port: number) {
  const WS = (globalThis as any).require('ws');
  const server = new WS.WebSocketServer({ port, host: '127.0.0.1' });
  servers.push(server);
  const stats = { connections: 0 };
  server.on('connection', (sock: any) => {
    stats.connections++;
    sock.on('message', () => sock.close());
  });
  return stats;
}

describe('e2e refused connections', { timeout: 30000 }, () => {
  it('calls a device that refuses the pairing again only after minutes', async () => {
    const pa = ports();
    const refuser = refusingServer(pa);
    await node('b', 'bbbb', pa + 1, [pa]);
    await sleep(4000);
    expect(refuser.connections).toBe(1);
  });

  it('says once that the sync key differs, and still retries at once when asked', async () => {
    const pa = ports();
    const A = await node('a', 'aaaa', pa, [], { syncKey: 'OTHER-KEY' });
    let calls = 0;
    (A.coord as any).connectionManager.server.wss.on('connection', () => calls++);
    const B = await node('b', 'bbbb', pa + 1, [pa]);
    await sleep(3500);
    expect(calls).toBe(1);
    expect(count(B, 'Refused')).toBe(1);
    expect(B.events.find((e) => e.startsWith('Refused'))).toContain('sync key does not match');

    // The app came back to the foreground.
    B.coord.reconnectNow();
    await until(() => calls === 2, 3000);
    expect(calls).toBe(2);
    await sleep(300);
    expect(count(B, 'Refused')).toBe(1);
    expect(B.coord.getConnectedDevices()).toEqual([]);
  });
});

describe('e2e discovered devices', { timeout: 30000 }, () => {
  it('does not call a device of another vault', async () => {
    const pa = ports();
    const other = refusingServer(pa);
    const B = await node('b', 'aaaa', pa + 1, []);
    seen(B, 'zzzz', pa, 'another-vault');
    await sleep(1500);
    expect(other.connections).toBe(0);
    expect(B.coord.getDiscoveredDevices()).toEqual([]);

    // The same device in this vault is called.
    seen(B, 'zzzz', pa);
    await until(() => other.connections === 1, 3000);
    expect(other.connections).toBe(1);
  });

  it('stops calling a discovered device that is lost', async () => {
    const pa = ports();
    const B = await node('b', 'aaaa', pa + 1, []);
    seen(B, 'zzzz', pa); // nothing listens there
    await sleep(1500);
    lose(B, 'zzzz');
    expect(count(B, 'Device lost')).toBe(1);
    const late = refusingServer(pa);
    await sleep(4500);
    expect(late.connections).toBe(0);
  });

  it('keeps calling an address added by hand when its discovered entry is lost', async () => {
    const pa = ports();
    const B = await node('b', 'aaaa', pa + 1, [pa]);
    seen(B, 'zzzz', pa);
    await sleep(1500);
    lose(B, 'zzzz');
    const late = refusingServer(pa);
    await until(() => late.connections > 0, 8000);
    expect(late.connections).toBe(1);
  });

  it('keeps a lost device connected, but does not call it again once it leaves', async () => {
    const pa = ports();
    let A = await node('a', 'zzzz', pa, []);
    const B = await node('b', 'aaaa', pa + 1, []);
    seen(B, 'zzzz', pa);
    await until(() => B.coord.getConnectedDevices().length === 1);
    lose(B, 'zzzz');
    await sleep(500);
    expect(B.coord.getConnectedDevices()).toEqual(['zzzz']);

    await A.coord.stop();
    nodes = nodes.filter((n) => n !== A);
    await until(() => B.coord.getConnectedDevices().length === 0);
    A = await node('a', 'zzzz', pa, []);
    await sleep(3500);
    expect(B.coord.getConnectedDevices()).toEqual([]);

    // Discovery hears it again.
    seen(B, 'zzzz', pa);
    await until(() => B.coord.getConnectedDevices().length === 1);
    expect(B.coord.getConnectedDevices()).toEqual(['zzzz']);
  });
});

describe('e2e unreachable devices', { timeout: 30000 }, () => {
  it('reports an address added by hand that cannot be reached until it connects', async () => {
    const pa = ports();
    const B = await node('b', 'bbbb', pa + 1, [pa]);
    let updates = 0;
    B.coord.onStateChange(() => updates++);
    await until(() => B.coord.getUnreachablePeers().length > 0, 8000);
    expect(B.coord.getUnreachablePeers()).toEqual([`127.0.0.1:${pa}`]);
    expect(updates).toBeGreaterThan(0);

    await node('a', 'aaaa', pa, []);
    await until(() => B.coord.getConnectedDevices().length === 1, 12000);
    expect(B.coord.getUnreachablePeers()).toEqual([]);
    expect(B.coord.getConnectedPeers().map((d) => d.deviceName)).toEqual(['aaaa']);
  });
});
