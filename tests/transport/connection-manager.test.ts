import { describe, expect, it, vi } from 'vitest';
import { WS_PING_INTERVAL_MS } from '../../src/constants';
import { encodePing, encodePong } from '../../src/transport/protocol';

import { ConnectionManager } from '../../src/transport/connection-manager';
import { DEFAULT_SETTINGS, type DeviceInfo, type HandshakePayload } from '../../src/types';

function createManager(): ConnectionManager {
  return new ConnectionManager(
    {
      ...DEFAULT_SETTINGS,
      deviceId: 'device-b',
      deviceName: 'Device B',
    },
    'vault-1',
  );
}

describe('ConnectionManager mobile compatibility', () => {
  it('forces outbound connections when the local runtime cannot host a server', () => {
    const manager = createManager() as any;
    manager.acceptsIncomingConnections = false;

    const desktopPeer: DeviceInfo = {
      deviceId: 'device-a',
      deviceName: 'Desktop',
      ip: '192.168.1.10',
      port: 53712,
      vaultId: 'vault-1',
      lastSeen: Date.now(),
      acceptsIncomingConnections: true,
    };

    expect(manager._shouldInitiateConnection(desktopPeer)).toBe(true);
  });

  it('refuses to initiate connections to peers that cannot accept incoming traffic', () => {
    const manager = createManager() as any;

    const mobilePeer: DeviceInfo = {
      deviceId: 'device-c',
      deviceName: 'iPhone',
      ip: '192.168.1.20',
      port: 53712,
      vaultId: 'vault-1',
      lastSeen: Date.now(),
      acceptsIncomingConnections: false,
    };

    expect(manager._shouldInitiateConnection(mobilePeer)).toBe(false);
  });

  it('treats older peers without the new capability flag as desktop-compatible', () => {
    const manager = createManager() as any;
    const legacyPeer: HandshakePayload = {
      deviceId: 'legacy-peer',
      deviceName: 'Legacy',
      vaultId: 'vault-1',
      port: 53712,
    };

    expect(manager._peerAcceptsIncomingConnections(legacyPeer)).toBe(true);
  });
});

describe('ConnectionManager liveness', () => {
  function fakeSocket() {
    const listeners = new Map<string, Array<(...args: any[]) => void>>();
    const sock = {
      readyState: 1,
      sent: [] as Uint8Array[],
      closed: false,
      send(data: Uint8Array) { this.sent.push(data); },
      close() { this.closed = true; },
      on(event: string, l: (...args: any[]) => void) {
        listeners.set(event, [...(listeners.get(event) ?? []), l]);
      },
      removeListener() {},
      emit(event: string, ...args: any[]) { for (const l of listeners.get(event) ?? []) l(...args); },
    };
    return sock;
  }
  // Passes messages through unchanged, so the test can read what is sent.
  const plainChannel = { seal: async (d: Uint8Array) => d, open: async (d: Uint8Array) => d };
  const peer: DeviceInfo = {
    deviceId: 'device-c', deviceName: 'C', ip: '10.0.0.3', port: 50000,
    vaultId: 'vault-1', lastSeen: 0, acceptsIncomingConnections: true,
  };

  it('drops a peer that stops answering pings so it can connect again', async () => {
    vi.useFakeTimers();
    try {
      const manager = createManager() as any;
      const disconnected: string[] = [];
      manager.onPeerDisconnected((id: string) => disconnected.push(id));
      const ws = fakeSocket();
      manager._setupWs(ws, peer, plainChannel, 'inbound');
      expect(manager.isConnectedTo('device-c')).toBe(true);

      await vi.advanceTimersByTimeAsync(WS_PING_INTERVAL_MS * 5);

      expect(ws.closed).toBe(true);
      expect(manager.isConnectedTo('device-c')).toBe(false);
      expect(disconnected).toEqual(['device-c']);
      manager.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a peer that answers pings', async () => {
    vi.useFakeTimers();
    try {
      const manager = createManager() as any;
      const ws = fakeSocket();
      manager._routeSocket(ws, 'inbound', () => ({ device: peer, channel: plainChannel }));
      ws.emit('message', encodePing());
      await vi.advanceTimersByTimeAsync(0);
      expect(manager.isConnectedTo('device-c')).toBe(true);
      for (let i = 0; i < 10; i++) {
        await vi.advanceTimersByTimeAsync(WS_PING_INTERVAL_MS);
        ws.emit('message', encodePong());
      }
      expect(ws.closed).toBe(false);
      expect(manager.isConnectedTo('device-c')).toBe(true);
      manager.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
