/**
 * Syncing only one folder, on the wire: each side says its folder in the
 * handshake, a device limited to a folder refuses versions that do not, and
 * a connection carries only messages about paths both sides sync.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION } from '../../src/constants';
import {
  decodeJSON,
  decodeMessage,
  encodeFileChunk,
  encodeFileData,
  encodeFileMetaSync,
  encodeFileRename,
  encodeHandshake,
  encodeHandshakeAck,
  encodePing,
  encodeYjsSync,
} from '../../src/transport/protocol';
import { ackMessage, authProof } from '../../src/transport/auth';
import { ConnectionManager, type AuthFailure } from '../../src/transport/connection-manager';
import { WSClient } from '../../src/transport/ws-client';
import * as scope from '../../src/sync/sync-scope';
import { DEFAULT_SETTINGS, MessageType, type DeviceInfo, type HandshakePayload } from '../../src/types';

// The scope functions, watched, to show what a connection looks into.
vi.mock('../../src/sync/sync-scope', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/sync/sync-scope')>();
  return { ...mod, messagePaths: vi.fn(mod.messagePaths), messagePathsOf: vi.fn(mod.messagePathsOf) };
});

const KEY = 'shared-key';

function createManager(syncFolder = ''): any {
  return new ConnectionManager(
    { ...DEFAULT_SETTINGS, deviceId: 'device-b', deviceName: 'Device B', syncKey: KEY, syncFolder },
    'vault-1',
  );
}

function fakeSocket() {
  const listeners = new Map<string, Array<(...args: any[]) => void>>();
  return {
    readyState: 1,
    sent: [] as Uint8Array[],
    closed: false,
    send(data: Uint8Array) { this.sent.push(data); },
    close() { this.closed = true; this.readyState = 3; },
    on(event: string, l: (...args: any[]) => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), l]);
    },
    removeListener() {},
    emit(event: string, ...args: any[]) { for (const l of listeners.get(event) ?? []) l(...args); },
  };
}

// Passes messages through unchanged, so the test can read what is sent.
const plainChannel = { seal: async (d: Uint8Array) => d, open: async (d: Uint8Array) => d };

function device(syncFolder?: string, id = 'device-c'): DeviceInfo {
  const d: DeviceInfo = {
    deviceId: id, deviceName: id, ip: '10.0.0.3', port: 50000,
    vaultId: 'vault-1', lastSeen: 0, acceptsIncomingConnections: true,
  };
  if (syncFolder !== undefined) d.syncFolder = syncFolder;
  return d;
}

const peerHello: HandshakePayload = {
  deviceId: 'device-c',
  deviceName: 'Pixel',
  vaultId: 'vault-1',
  port: 50000,
  nonce: 'n'.repeat(32),
  protocolVersion: PROTOCOL_VERSION,
};

const data = (path: string) => encodeFileData({ path, content: new Uint8Array([1]), mtime: 1 });
const chunk = (path: string) => encodeFileChunk({ path, content: new Uint8Array([1]), mtime: 1, totalSize: 1, offset: 0 });

/** What the manager has handed to a peer's socket so far. */
async function sentTo(manager: any, ws: ReturnType<typeof fakeSocket>, id = 'device-c') {
  await manager.peers.get(id)?.sendChain;
  return ws.sent.map((m) => decodeMessage(m));
}

function pathOf(msg: { type: MessageType; payload: Uint8Array }): string[] | null {
  return scope.messagePathsOf(msg.type, msg.payload);
}

afterEach(() => {
  vi.mocked(scope.messagePaths).mockClear();
  vi.mocked(scope.messagePathsOf).mockClear();
});

describe('handshake: the folder each side syncs', () => {
  it('says this device\'s folder when calling, and the whole vault as an empty one', async () => {
    const connect = vi.spyOn(WSClient.prototype, 'connect').mockImplementation(() => {});
    try {
      for (const folder of ['Work', '']) {
        const manager = createManager(folder);
        manager.connectToPeer({ ...device(), deviceId: 'manual-10.0.0.3:50000' });
        const ws = fakeSocket();
        manager.clients.get('ws://10.0.0.3:50000').onOpenCb(ws);
        const hello = decodeMessage(ws.sent[0]);
        expect(hello.type).toBe(MessageType.HANDSHAKE);
        expect(decodeJSON<HandshakePayload>(hello.payload).syncFolder).toBe(folder);
        manager.stop();
      }
    } finally {
      connect.mockRestore();
    }
  });

  it('says this device\'s folder in its answer', async () => {
    const manager = createManager('Work');
    const ws = fakeSocket();
    manager._handleInbound(ws, '10.0.0.3');
    ws.emit('message', encodeHandshake({ ...peerHello, syncFolder: '' }));
    await vi.waitFor(() => expect(ws.sent).toHaveLength(1));
    const ack = decodeMessage(ws.sent[0]);
    expect(ack.type).toBe(MessageType.HANDSHAKE_ACK);
    const body = decodeJSON<HandshakePayload>(ack.payload);
    expect(body.syncFolder).toBe('Work');
    expect(body.proof).toBeTruthy();
    expect(ws.closed).toBe(false);
    manager.stop();
  });

  it('a device limited to a folder refuses an older version calling it', async () => {
    const manager = createManager('Work');
    const failures: AuthFailure[] = [];
    manager.onAuthFailed((f: AuthFailure) => failures.push(f));
    const ws = fakeSocket();
    manager._handleInbound(ws, '10.0.0.3');
    ws.emit('message', encodeHandshake(peerHello));
    await vi.waitFor(() => expect(ws.closed).toBe(true));
    expect(ws.sent).toEqual([]); // no answer, so nothing of this side's folder either
    expect(failures).toEqual([{ deviceId: 'device-c', deviceName: 'Pixel', address: '10.0.0.3', reason: 'outdated' }]);
    manager.stop();
  });

  it('a device limited to a folder refuses an older version it calls', async () => {
    const connect = vi.spyOn(WSClient.prototype, 'connect').mockImplementation(() => {});
    try {
      const manager = createManager('Work');
      const failures: AuthFailure[] = [];
      manager.onAuthFailed((f: AuthFailure) => failures.push(f));
      manager.connectToPeer({ ...device(), deviceId: 'manual-10.0.0.3:50000' });
      const ws = fakeSocket();
      manager.clients.get('ws://10.0.0.3:50000').onOpenCb(ws);
      ws.emit('message', encodeHandshakeAck({ ...peerHello, proof: 'p' }));
      await vi.waitFor(() => expect(ws.closed).toBe(true));
      expect(failures).toEqual([{ deviceId: 'device-c', deviceName: 'Pixel', address: '10.0.0.3:50000', reason: 'outdated' }]);
      expect(ws.sent).toHaveLength(1); // only its own handshake; no auth
      manager.stop();
    } finally {
      connect.mockRestore();
    }
  });

  it('a device with an invalid folder setting refuses an older version too', async () => {
    const manager = createManager('../Work');
    expect(manager.localScope()).toBeNull();
    const failures: AuthFailure[] = [];
    manager.onAuthFailed((f: AuthFailure) => failures.push(f));
    const ws = fakeSocket();
    manager._handleInbound(ws, '10.0.0.3');
    ws.emit('message', encodeHandshake(peerHello));
    await vi.waitFor(() => expect(ws.closed).toBe(true));
    expect(failures.map((f) => f.reason)).toEqual(['outdated']);
    manager.stop();
  });

  it('a device that syncs the whole vault answers an older version as before', async () => {
    const manager = createManager('');
    const failures: AuthFailure[] = [];
    manager.onAuthFailed((f: AuthFailure) => failures.push(f));
    const ws = fakeSocket();
    manager._handleInbound(ws, '10.0.0.3');
    ws.emit('message', encodeHandshake(peerHello));
    await vi.waitFor(() => expect(ws.sent).toHaveLength(1));
    expect(decodeMessage(ws.sent[0]).type).toBe(MessageType.HANDSHAKE_ACK);
    expect(ws.closed).toBe(false);
    expect(failures).toEqual([]);
    manager.stop();
  });

  it('a device that syncs the whole vault pairs with an older version it calls', async () => {
    const connect = vi.spyOn(WSClient.prototype, 'connect').mockImplementation(() => {});
    try {
      const manager = createManager('');
      const failures: AuthFailure[] = [];
      const connected: DeviceInfo[] = [];
      manager.onAuthFailed((f: AuthFailure) => failures.push(f));
      manager.onPeerConnected((d: DeviceInfo) => connected.push(d));
      manager.connectToPeer({ ...device(), deviceId: 'manual-10.0.0.3:50000' });
      const ws = fakeSocket();
      manager.clients.get('ws://10.0.0.3:50000').onOpenCb(ws);
      const clientNonce = decodeJSON<HandshakePayload>(decodeMessage(ws.sent[0]).payload).nonce!;
      const serverNonce = 's'.repeat(32);
      const proof = await authProof(KEY, ackMessage(clientNonce, serverNonce, 'device-c'));
      ws.emit('message', encodeHandshakeAck({ ...peerHello, nonce: serverNonce, proof }));
      await vi.waitFor(() => expect(connected).toHaveLength(1));
      expect(failures).toEqual([]);
      expect(decodeMessage(ws.sent[1]).type).toBe(MessageType.AUTH);
      expect(connected[0].syncFolder).toBeUndefined();
      expect(manager.peerSyncFolder('device-c')).toBeUndefined();
      expect(manager.connectionScope('device-c')).toBe('');
      manager.stop();
    } finally {
      connect.mockRestore();
    }
  });

  it('pairs a limited device with a new one, keeping the folder it said', async () => {
    const connect = vi.spyOn(WSClient.prototype, 'connect').mockImplementation(() => {});
    try {
      const manager = createManager('Work');
      const connected: DeviceInfo[] = [];
      manager.onPeerConnected((d: DeviceInfo) => connected.push(d));
      manager.connectToPeer({ ...device(), deviceId: 'manual-10.0.0.3:50000' });
      const ws = fakeSocket();
      manager.clients.get('ws://10.0.0.3:50000').onOpenCb(ws);
      const clientNonce = decodeJSON<HandshakePayload>(decodeMessage(ws.sent[0]).payload).nonce!;
      const serverNonce = 's'.repeat(32);
      const proof = await authProof(KEY, ackMessage(clientNonce, serverNonce, 'device-c'));
      ws.emit('message', encodeHandshakeAck({ ...peerHello, nonce: serverNonce, proof, syncFolder: ' Work/Notes ' }));
      await vi.waitFor(() => expect(connected).toHaveLength(1));
      expect(connected[0].syncFolder).toBe('Work/Notes');
      expect(manager.connectionScope('device-c')).toBe('Work/Notes');
      manager.stop();
    } finally {
      connect.mockRestore();
    }
  });
});

describe('what a connection carries', () => {
  it('keeps the folder the peer said and what both sides sync', () => {
    const manager = createManager('');
    const connected: DeviceInfo[] = [];
    manager.onPeerConnected((d: DeviceInfo) => connected.push(d));
    manager._setupWs(fakeSocket(), device('Work'), plainChannel, 'inbound');
    expect(connected[0].syncFolder).toBe('Work');
    expect(manager.peerSyncFolder('device-c')).toBe('Work');
    expect(manager.connectionScope('device-c')).toBe('Work');
    expect(manager.getConnectedPeers()[0].syncFolder).toBe('Work');
    expect(manager.peerAccepts('device-c', 'Work/a.md')).toBe(true);
    expect(manager.peerAccepts('device-c', 'Workshop/a.md')).toBe(false);
    manager.stop();
  });

  it('takes the deeper folder, and nothing when the two do not overlap', () => {
    const manager = createManager('Work');
    manager._setupWs(fakeSocket(), device('Work/Notes', 'device-c'), plainChannel, 'inbound');
    manager._setupWs(fakeSocket(), device('Home', 'device-d'), plainChannel, 'inbound');
    manager._setupWs(fakeSocket(), device('', 'device-e'), plainChannel, 'inbound');
    expect(manager.connectionScope('device-c')).toBe('Work/Notes');
    expect(manager.connectionScope('device-d')).toBeNull();
    expect(manager.connectionScope('device-e')).toBe('Work');
    expect(manager.peerAccepts('device-d', 'Work/a.md')).toBe(false);
    manager.stop();
  });

  it('carries nothing for a folder the peer gave that is not valid', () => {
    const manager = createManager('');
    manager._setupWs(fakeSocket(), device('../etc'), plainChannel, 'inbound');
    expect(manager.peerSyncFolder('device-c')).toBe('../etc');
    expect(manager.connectionScope('device-c')).toBeNull();
    expect(manager.peerAccepts('device-c', 'a.md')).toBe(false);
    manager.stop();
  });

  it('gives this device\'s own folder for a device that is not connected', () => {
    expect(createManager(' /Work/ ').connectionScope('nobody')).toBe('Work');
    expect(createManager('').connectionScope('nobody')).toBe('');
    expect(createManager('').peerSyncFolder('nobody')).toBeUndefined();
  });
});

describe('outgoing messages on a limited connection', () => {
  it('sends only messages about paths in the folder', async () => {
    const manager = createManager('');
    const splits: Array<[string, string[]]> = [];
    manager.onScopeSplit((id: string, paths: string[]) => splits.push([id, paths]));
    const ws = fakeSocket();
    manager._setupWs(ws, device('Work'), plainChannel, 'inbound');

    manager.sendTo('device-c', data('Home/diary.md'));
    manager.sendTo('device-c', data('Work/a.png'));
    manager.sendTo('device-c', encodeYjsSync(MessageType.YJS_UPDATE, 'Workshop/x.md', new Uint8Array([1])));
    manager.sendTo('device-c', encodeFileRename({ oldPath: 'Work/a.md', newPath: 'Home/a.md' }));
    manager.sendTo('device-c', encodeFileMetaSync({ files: [] }));
    manager.sendTo('device-c', encodePing());

    const sent = await sentTo(manager, ws);
    expect(sent.map((m) => m.type)).toEqual([MessageType.FILE_DATA, MessageType.FILE_META_SYNC, MessageType.PING]);
    expect(pathOf(sent[0])).toEqual(['Work/a.png']);
    expect(splits).toEqual([['device-c', ['Work/a.md', 'Home/a.md']]]);
    manager.stop();
  });

  it('keeps to this device\'s own folder with a peer that syncs everything', async () => {
    const manager = createManager('Work');
    const ws = fakeSocket();
    manager._setupWs(ws, device(''), plainChannel, 'inbound');
    manager.sendTo('device-c', data('Home/diary.md'));
    manager.sendTo('device-c', data('Work/a.png'));
    const sent = await sentTo(manager, ws);
    expect(sent.map(pathOf)).toEqual([['Work/a.png']]);
    manager.stop();
  });

  it('decides a broadcast for each peer, reading the message once', async () => {
    const manager = createManager('');
    const whole = fakeSocket();
    const work = fakeSocket();
    manager._setupWs(whole, device(undefined, 'device-c'), plainChannel, 'inbound');
    manager._setupWs(work, device('Work', 'device-d'), plainChannel, 'inbound');
    manager._setupWs(fakeSocket(), device('Work', 'device-e'), plainChannel, 'inbound');

    manager.broadcast(data('Home/diary.md'));
    expect(scope.messagePaths).toHaveBeenCalledTimes(1);
    manager.broadcast(data('Work/a.png'));

    expect((await sentTo(manager, whole, 'device-c')).map(pathOf)).toEqual([['Home/diary.md'], ['Work/a.png']]);
    expect((await sentTo(manager, work, 'device-d')).map(pathOf)).toEqual([['Work/a.png']]);
    manager.stop();
  });

  it('skips paced frames outside the folder and still reports success', async () => {
    const manager = createManager('');
    const ws = fakeSocket();
    manager._setupWs(ws, device('Work'), plainChannel, 'inbound');
    const ok = await manager.sendToPaced('device-c', [chunk('Work/a.bin'), chunk('Home/b.bin'), chunk('Work/c.bin')]);
    expect(ok).toBe(true);
    expect((await sentTo(manager, ws)).map(pathOf)).toEqual([['Work/a.bin'], ['Work/c.bin']]);
    manager.stop();
  });

  it('still reports a disconnect while skipping frames', async () => {
    const manager = createManager('');
    const ws = fakeSocket();
    manager._setupWs(ws, device('Work'), plainChannel, 'inbound');
    let made = 0;
    function* frames() {
      made++;
      yield chunk('Home/a.bin');
      ws.close();
      made++;
      yield chunk('Home/b.bin');
      made++;
      yield chunk('Home/c.bin');
    }
    expect(await manager.sendToPaced('device-c', frames())).toBe(false);
    expect(made).toBe(2);
    manager.stop();
  });
});

describe('incoming messages on a limited connection', () => {
  async function pairedInbound(local: string, peerFolder: string | undefined) {
    const manager = createManager(local);
    const handled: Array<{ type: MessageType; paths: string[] | null }> = [];
    const splits: Array<[string, string[]]> = [];
    manager.onMessage((_id: string, type: MessageType, payload: Uint8Array) => {
      handled.push({ type, paths: scope.messagePathsOf(type, payload) });
    });
    manager.onScopeSplit((id: string, paths: string[]) => splits.push([id, paths]));
    const ws = fakeSocket();
    manager._routeSocket(ws, 'inbound', () => ({ device: device(peerFolder), channel: plainChannel }));
    ws.emit('message', encodePing()); // taken as the handshake
    await vi.waitFor(() => expect(manager.isConnectedTo('device-c')).toBe(true));
    return { manager, ws, handled, splits };
  }

  it('hands on only messages about paths in the folder', async () => {
    const { manager, ws, handled, splits } = await pairedInbound('Work', '');
    ws.emit('message', data('Home/diary.md'));
    ws.emit('message', encodeFileRename({ oldPath: 'Home/a.md', newPath: 'Work/a.md' }));
    ws.emit('message', encodeFileMetaSync({ files: [] }));
    ws.emit('message', data('Work/a.png'));
    await vi.waitFor(() => expect(handled).toHaveLength(2));
    await manager.peers.get('device-c').messageQueue;
    expect(handled).toEqual([
      { type: MessageType.FILE_META_SYNC, paths: null },
      { type: MessageType.FILE_DATA, paths: ['Work/a.png'] },
    ]);
    expect(splits).toEqual([['device-c', ['Home/a.md', 'Work/a.md']]]);
    manager.stop();
  });

  it('keeps to the folder the peer said', async () => {
    const { manager, ws, handled } = await pairedInbound('', 'Work');
    ws.emit('message', chunk('Home/big.bin'));
    ws.emit('message', chunk('Work/big.bin'));
    await vi.waitFor(() => expect(handled).toHaveLength(1));
    await manager.peers.get('device-c').messageQueue;
    expect(handled.map((h) => h.paths)).toEqual([['Work/big.bin']]);
    manager.stop();
  });
});

describe('a connection that carries the whole vault', () => {
  it('does not look into any message', async () => {
    const manager = createManager('');
    const handled: MessageType[] = [];
    manager.onMessage((_id: string, type: MessageType) => { handled.push(type); });
    const ws = fakeSocket();
    manager._routeSocket(ws, 'inbound', () => ({ device: device(''), channel: plainChannel }));
    ws.emit('message', encodePing());
    await vi.waitFor(() => expect(manager.isConnectedTo('device-c')).toBe(true));
    vi.mocked(scope.messagePaths).mockClear();
    vi.mocked(scope.messagePathsOf).mockClear();

    manager.sendTo('device-c', data('Home/diary.md'));
    manager.broadcast(data('Home/diary.md'));
    expect(await manager.sendToPaced('device-c', [chunk('Home/big.bin')])).toBe(true);
    ws.emit('message', data('Home/diary.md'));
    await vi.waitFor(() => expect(handled).toEqual([MessageType.FILE_DATA]));

    expect(scope.messagePaths).not.toHaveBeenCalled();
    expect(scope.messagePathsOf).not.toHaveBeenCalled();
    expect(await sentTo(manager, ws)).toHaveLength(3);
    manager.stop();
  });
});
