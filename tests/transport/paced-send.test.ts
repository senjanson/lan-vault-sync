/**
 * Paced sending (plan 6.4): a large file's chunks are handed to the socket
 * one at a time, only while little is waiting to go out, so a 1 GB file does
 * not sit in memory as encrypted frames queued for a slow phone.
 */
import { describe, expect, it } from 'vitest';
import { ConnectionManager } from '../../src/transport/connection-manager';
import { DEFAULT_SETTINGS, type DeviceInfo } from '../../src/types';

const MB = 1024 * 1024;

/** A socket that drains `rate` bytes every 5 ms, like a slow network. */
function slowSocket(rate: number) {
  const sock = {
    readyState: 1,
    bufferedAmount: 0,
    sent: 0,
    maxBuffered: 0,
    send(data: Uint8Array) {
      this.bufferedAmount += data.byteLength;
      this.sent += data.byteLength;
      this.maxBuffered = Math.max(this.maxBuffered, this.bufferedAmount);
    },
    close() { this.readyState = 3; },
    on() {},
    removeListener() {},
  };
  const timer = setInterval(() => { sock.bufferedAmount = Math.max(0, sock.bufferedAmount - rate); }, 5);
  return { sock, stop: () => clearInterval(timer) };
}

const plainChannel = { seal: async (d: Uint8Array) => d, open: async (d: Uint8Array) => d };
const peer: DeviceInfo = {
  deviceId: 'device-c', deviceName: 'C', ip: '10.0.0.3', port: 50000,
  vaultId: 'vault-1', lastSeen: 0, acceptsIncomingConnections: true,
};

function createManager(): any {
  return new ConnectionManager({ ...DEFAULT_SETTINGS, deviceId: 'device-b', deviceName: 'B' }, 'vault-1');
}

function* frames(n: number, size: number, made: { count: number }) {
  for (let i = 0; i < n; i++) {
    made.count++;
    yield new Uint8Array(size).fill(i);
  }
}

describe('ConnectionManager.sendToPaced', () => {
  it('keeps what waits to be sent near the limit', async () => {
    const manager = createManager();
    const { sock, stop } = slowSocket(2 * MB);
    try {
      manager._setupWs(sock, peer, plainChannel, 'inbound');
      const made = { count: 0 };
      let maxSeen = 0;
      const sample = setInterval(() => { maxSeen = Math.max(maxSeen, manager.bufferedAmount('device-c')); }, 1);
      const ok = await manager.sendToPaced('device-c', frames(20, MB, made), 4 * MB);
      clearInterval(sample);
      expect(ok).toBe(true);
      expect(made.count).toBe(20);
      expect(sock.sent).toBe(20 * MB);
      expect(sock.maxBuffered).toBeLessThanOrEqual(4 * MB);
      expect(maxSeen).toBeLessThanOrEqual(4 * MB);
    } finally {
      stop();
      manager.stop();
    }
  });

  it('stops, and builds no more frames, when the peer disconnects', async () => {
    const manager = createManager();
    const { sock, stop } = slowSocket(0); // never drains
    try {
      manager._setupWs(sock, peer, plainChannel, 'inbound');
      const made = { count: 0 };
      const sending = manager.sendToPaced('device-c', frames(20, MB, made), 4 * MB);
      await new Promise((r) => setTimeout(r, 100));
      sock.close();
      expect(await sending).toBe(false);
      expect(made.count).toBeLessThanOrEqual(5);
    } finally {
      stop();
      manager.stop();
    }
  });

  it('returns false for a peer that is not connected', async () => {
    const manager = createManager();
    expect(await manager.sendToPaced('nobody', frames(1, 10, { count: 0 }))).toBe(false);
    expect(manager.bufferedAmount('nobody')).toBe(0);
  });

  it('reads the receive limit from the settings: 0 means none', () => {
    const none = new ConnectionManager({ ...DEFAULT_SETTINGS, deviceId: 'x', maxReceiveMB: 0 }, 'v');
    const some = new ConnectionManager({ ...DEFAULT_SETTINGS, deviceId: 'x', maxReceiveMB: 200 }, 'v');
    expect(none.receiveLimitBytes()).toBe(0);
    expect(some.receiveLimitBytes()).toBe(200 * MB);
  });
});
