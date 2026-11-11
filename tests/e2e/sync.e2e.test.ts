/**
 * End-to-end sync scenarios: real WebSocket connections on localhost between
 * several disk-backed test vaults (see harness.ts for the Vault stand-in).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

// UDP broadcast is process-global; scenarios connect through manual peers.
vi.mock('../../src/discovery/udp-broadcast', () => ({
  UdpBroadcast: class {
    onDeviceSeen() {}
    async start() {}
    stop() {}
  },
}));

import { count, Node, ports, seed, sleep, startNode, tmpRoot } from './harness';

let nodes: Node[] = [];
const track = (n: Node) => (nodes.push(n), n);
afterEach(async () => {
  for (const n of nodes) await n.coord.stop().catch(() => undefined);
  nodes = [];
});

describe('e2e sync', { timeout: 30000 }, () => {
  it('connects once and syncs a small vault (handshake ack race)', async () => {
    const ra = tmpRoot('a'), rb = tmpRoot('b');
    // The listening side has an empty vault, so its file tree goes out right
    // behind the handshake ack (both tend to arrive in one TCP chunk).
    seed(rb, { '日记/第一 篇.md': '你好', 'a b/c.md': 'hello', 'img/图.png': Buffer.from([1, 2, 0, 255]) });
    const pa = ports();
    const A = track(await startNode(ra, 'aaaa', pa, []));
    const B = track(await startNode(rb, 'bbbb', pa + 1, [pa]));
    await sleep(2500);
    expect(A.vault.text('日记/第一 篇.md')).toBe('你好');
    expect(A.vault.text('a b/c.md')).toBe('hello');
    expect(A.vault.bin('img/图.png')?.toString('hex')).toBe('010200ff');
    expect(count(B, 'Connected to')).toBe(1);
    expect(count(A, 'Disconnected')).toBe(0);
  });
});

describe('e2e connections', { timeout: 30000 }, () => {
  it('keeps one working connection when a manual peer is also auto-discovered', async () => {
    const ra = tmpRoot('a'), rb = tmpRoot('b');
    const pa = ports(), pb = pa + 1;
    const B = track(await startNode(rb, 'bbbb', pb, []));
    const A = track(await startNode(ra, 'aaaa', pa, [pb]));
    // Discovery reports the same device while the manual connection is still opening.
    (A.coord as any).discovery._handleDeviceSeen({
      deviceId: 'bbbb', deviceName: 'bbbb', ip: '127.0.0.1', port: pb,
      vaultId: (A.coord as any).vaultId, lastSeen: Date.now(), acceptsIncomingConnections: true,
    });
    await sleep(2000);
    expect(A.coord.getConnectedDevices()).toEqual(['bbbb']);
    await A.vault.write('after.md', 'hello from A');
    await sleep(800);
    expect(B.vault.text('after.md')).toBe('hello from A');
    expect(count(A, 'Disconnected')).toBe(0);
  });

  it('stops reconnecting after the sync service is stopped', async () => {
    const ra = tmpRoot('a'), rb = tmpRoot('b');
    seed(ra, { 'after-stop.md': 'must not sync after stop' });
    const pa = ports(), pb = pa + 1;
    const A = await startNode(ra, 'aaaa', pa, [pb]); // B is offline, A keeps retrying
    await sleep(300);
    await A.coord.stop();
    const B = track(await startNode(rb, 'bbbb', pb, []));
    await sleep(4000);
    expect(B.coord.getConnectedDevices()).toEqual([]);
    expect(B.vault.text('after-stop.md')).toBeNull();
  });
});
