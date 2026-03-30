import { describe, expect, it } from 'vitest';

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
