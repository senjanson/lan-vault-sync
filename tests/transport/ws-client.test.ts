import { describe, expect, it, vi } from 'vitest';
import { WSClient } from '../../src/transport/ws-client';
import { RECONNECT_MAX_MS } from '../../src/constants';

describe('WSClient', () => {
  it('reconnects at once when asked, instead of waiting out the backoff', () => {
    vi.useFakeTimers();
    try {
      const client = new WSClient('ws://127.0.0.1:1') as any;
      const connects: number[] = [];
      client._doConnect = () => connects.push(Date.now());
      client.reconnectDelay = RECONNECT_MAX_MS;
      client._scheduleReconnect();
      expect(connects).toHaveLength(0);

      client.reconnectNow();
      expect(connects).toHaveLength(1);
      // The pending backoff timer no longer fires a second attempt.
      vi.advanceTimersByTime(RECONNECT_MAX_MS * 2);
      expect(connects).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does nothing after it was closed', () => {
    const client = new WSClient('ws://127.0.0.1:1') as any;
    let connects = 0;
    client._doConnect = () => connects++;
    client.close();
    client.reconnectNow();
    expect(connects).toBe(0);
  });
});
