import { afterEach, describe, expect, it } from 'vitest';
import { encodeYjsSync } from '../../src/transport/protocol';
import { MessageType } from '../../src/types';
import { connectRaw, Node, ports, sleep, startNode, tmpRoot } from './harness';
import * as Y from 'yjs';

let nodes: Node[] = [];
const track = (n: Node) => (nodes.push(n), n);
afterEach(async () => {
  for (const n of nodes) await n.coord.stop().catch(() => undefined);
  nodes = [];
});

describe('e2e protocol', { timeout: 30000 }, () => {
  it('sends notes encrypted', async () => {
    const pa = ports();
    const A = track(await startNode(tmpRoot('a'), 'aaaa', pa, []));
    const B = track(await startNode(tmpRoot('b'), 'bbbb', pa + 1, [pa]));
    await sleep(1200);
    const sent: Buffer[] = [];
    const ws = (A.coord as any).connectionManager.peers.get('bbbb').ws;
    const send = ws.send.bind(ws);
    ws.send = (data: Uint8Array) => { sent.push(Buffer.from(data)); send(data); };
    await A.vault.write('secret.md', 'my secret plan');
    await sleep(1000);
    expect(B.vault.text('secret.md')).toBe('my secret plan');
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.some((b) => b.includes(Buffer.from('secret')))).toBe(false);
  });

  it('closes a paired connection that sends an unencrypted message', async () => {
    const pa = ports();
    const A = track(await startNode(tmpRoot('a'), 'aaaa', pa, []));
    const rogue = await connectRaw(pa, { deviceId: 'rogue', vaultId: (A.coord as any).vaultId }, 'TEST-KEY');
    expect(A.coord.getConnectedDevices()).toContain('rogue');
    const doc = new Y.Doc();
    doc.getText('content').insert(0, 'injected');
    rogue.sendPlain(encodeYjsSync(MessageType.YJS_UPDATE, 'x.md', Y.encodeStateAsUpdate(doc)));
    await sleep(500);
    expect(rogue.isClosed()).toBe(true);
    expect(A.vault.text('x.md')).toBeNull();
  });

  it('tells which device to update when protocol versions differ', async () => {
    const pa = ports();
    const A = track(await startNode(tmpRoot('a'), 'aaaa', pa, []));
    const failures: string[] = [];
    A.coord.onAuthFailed((f) => failures.push(`${f.deviceName}:${f.reason}`));
    const vaultId = (A.coord as any).vaultId;
    const old = await connectRaw(pa, { deviceId: 'old', deviceName: 'old', vaultId, protocolVersion: undefined }, 'TEST-KEY');
    const future = await connectRaw(pa, { deviceId: 'new', deviceName: 'new', vaultId, protocolVersion: 99 }, 'TEST-KEY');
    await sleep(300);
    expect(old.isClosed()).toBe(true);
    expect(future.isClosed()).toBe(true);
    expect(failures).toEqual(['old:outdated', 'new:newer']);
    expect(A.coord.getConnectedDevices()).toEqual([]);
  });

  it('tells the dialing side when the listening device is older', async () => {
    const pa = ports();
    // An old listener: answers the handshake without a protocol version.
    const WS = (globalThis as any).require('ws');
    const { decodeMessage, decodeJSON, encodeHandshakeAck } = await import('../../src/transport/protocol');
    const { authProof, ackMessage, randomNonce } = await import('../../src/transport/auth');
    const server = new WS.WebSocketServer({ port: pa, host: '127.0.0.1' });
    server.on('connection', (sock: any) => sock.on('message', async (raw: Buffer) => {
      const hs = decodeJSON<any>(decodeMessage(new Uint8Array(raw)).payload);
      const nonce = randomNonce();
      sock.send(encodeHandshakeAck({
        deviceId: 'zz-old', deviceName: 'Old laptop', vaultId: hs.vaultId, port: pa, nonce,
        proof: await authProof('TEST-KEY', ackMessage(hs.nonce, nonce, 'zz-old')),
      }));
    }));
    try {
      const failures: string[] = [];
      const B = track(await startNode(tmpRoot('b'), 'bbbb', pa + 1, []));
      B.coord.onAuthFailed((f) => failures.push(`${f.deviceName}:${f.reason}`));
      B.coord.addManualPeer(`127.0.0.1:${pa}`);
      await sleep(1000);
      expect(failures[0]).toBe('Old laptop:outdated');
      expect(B.coord.getConnectedDevices()).toEqual([]);
    } finally {
      server.close();
    }
  });
});
