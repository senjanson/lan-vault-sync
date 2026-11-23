import { afterEach, describe, expect, it, vi } from 'vitest';

import { UdpBroadcast } from '../../src/discovery/udp-broadcast';
import type { DeviceInfo } from '../../src/types';
import { DISCOVERY_INTERVAL_MS } from '../../src/constants';

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

describe('UdpBroadcast sending', () => {
  const originalRequire = (globalThis as { require?: unknown }).require;

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    if (originalRequire === undefined) {
      delete (globalThis as { require?: unknown }).require;
    } else {
      (globalThis as { require?: unknown }).require = originalRequire;
    }
  });

  function start(failing: (address: string) => boolean) {
    vi.useFakeTimers();
    const sent: string[] = [];
    const socket = {
      bind: (_port: number, callback: () => void) => callback(),
      close: vi.fn(),
      send: (_m: Uint8Array, _o: number, _l: number, _p: number, address: string, cb: (err: Error | null) => void) => {
        sent.push(address);
        cb(failing(address) ? new Error('send EHOSTUNREACH') : null);
      },
      setBroadcast: vi.fn(),
      on: vi.fn(),
    };
    const interfaces = {
      lo0: [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', internal: true }],
      en0: [
        { address: 'fe80::1', netmask: 'ffff:ffff:ffff:ffff::', family: 'IPv6', internal: false },
        { address: '192.168.1.23', netmask: '255.255.255.0', family: 'IPv4', internal: false },
      ],
      bridge100: [{ address: '10.20.0.1', netmask: '255.255.240.0', family: 'IPv4', internal: false }],
      utun4: [{ address: '100.64.0.7', netmask: '255.255.255.255', family: 'IPv4', internal: false }],
    };
    (globalThis as { require?: (name: string) => unknown }).require = (name: string) => {
      if (name === 'dgram') return { createSocket: () => socket };
      if (name === 'os') return { networkInterfaces: () => interfaces };
      throw new Error(`Unexpected module: ${name}`);
    };
    const udp = new UdpBroadcast(localDevice);
    return { udp, sent };
  }

  it('also sends to the broadcast address of each network', async () => {
    const { udp, sent } = start(() => false);
    await udp.start();
    expect(sent).toEqual(['255.255.255.255', '192.168.1.255', '10.20.15.255']);
    udp.stop();
  });

  it('logs a send error once, also when it comes and goes', async () => {
    let down = true;
    const { udp } = start((address) => down && address === '255.255.255.255');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const info = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    await udp.start();
    vi.advanceTimersByTime(DISCOVERY_INTERVAL_MS * 5);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0])).toContain('255.255.255.255');

    down = false;
    vi.advanceTimersByTime(DISCOVERY_INTERVAL_MS * 3);
    expect(info.mock.calls.filter((c) => String(c).includes('255.255.255.255'))).toHaveLength(1);

    // An address that keeps failing and working again is reported once.
    for (let k = 0; k < 4; k++) {
      down = true;
      vi.advanceTimersByTime(DISCOVERY_INTERVAL_MS * 3);
      down = false;
      vi.advanceTimersByTime(DISCOVERY_INTERVAL_MS * 3);
    }
    expect(warn).toHaveBeenCalledTimes(1);
    expect(info.mock.calls.filter((c) => String(c).includes('255.255.255.255'))).toHaveLength(1);
    udp.stop();
  });
});
