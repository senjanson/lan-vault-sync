import { afterEach, describe, expect, it, vi } from 'vitest';

import { UdpBroadcast } from '../../src/discovery/udp-broadcast';
import type { DeviceInfo } from '../../src/types';

const localDevice: DeviceInfo = {
  deviceId: 'device-a',
  deviceName: 'Device A',
  ip: '127.0.0.1',
  port: 53712,
  vaultId: 'vault-1',
  lastSeen: Date.now(),
};

describe('UdpBroadcast', () => {
  const originalRequire = (globalThis as { require?: unknown }).require;

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalRequire === undefined) {
      delete (globalThis as { require?: unknown }).require;
    } else {
      (globalThis as { require?: unknown }).require = originalRequire;
    }
  });

  it('resolves startup when UDP bind fails', async () => {
    const listeners = new Map<string, (...args: any[]) => void>();
    const socket = {
      bind: vi.fn((_port: number, _callback: () => void) => {
        listeners.get('error')?.(new Error('EADDRINUSE'));
      }),
      close: vi.fn(),
      send: vi.fn(),
      setBroadcast: vi.fn(),
      on: (event, listener) => {
        listeners.set(event, listener);
      },
    };

    (globalThis as { require?: (moduleName: string) => unknown }).require = vi.fn((moduleName: string) => {
      if (moduleName === 'dgram') {
        return {
          createSocket: () => socket,
        };
      }
      throw new Error(`Unexpected module: ${moduleName}`);
    });

    const udp = new UdpBroadcast(localDevice);

    await expect(udp.start()).resolves.toBeUndefined();
    expect(socket.close).toHaveBeenCalledTimes(1);
  });
});
