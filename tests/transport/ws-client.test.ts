import { afterEach, describe, expect, it, vi } from 'vitest';
import { REFUSED_RETRY_MS, WSClient } from '../../src/transport/ws-client';
import { RECONNECT_BASE_MS, RECONNECT_MAX_MS } from '../../src/constants';

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

/** A browser-style WebSocket the test opens, closes and fails by hand. */
class FakeSocket {
  static all: FakeSocket[] = [];
  readyState = 0;
  private listeners = new Map<string, Array<(...args: any[]) => void>>();
  constructor(public url: string) { FakeSocket.all.push(this); }
  addEventListener(event: string, l: (...args: any[]) => void) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), l]);
  }
  removeEventListener() {}
  send() {}
  close() { this.fire('close'); }
  fire(event: string, ...args: any[]) {
    if (event === 'open') this.readyState = 1;
    if (event === 'close') this.readyState = 3;
    for (const l of this.listeners.get(event) ?? []) l(...args);
  }
}

describe('WSClient backoff', () => {
  function setup() {
    vi.useFakeTimers();
    FakeSocket.all = [];
    vi.stubGlobal('WebSocket', FakeSocket);
    const client = new WSClient('ws://10.0.0.9:50000');
    const last = () => FakeSocket.all[FakeSocket.all.length - 1];
    /** Run timers for `ms` and return how many sockets were opened meanwhile. */
    const attemptsWithin = (ms: number) => {
      const before = FakeSocket.all.length;
      vi.advanceTimersByTime(ms);
      return FakeSocket.all.length - before;
    };
    return { client, last, attemptsWithin };
  }
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('waits minutes before calling again a device that took the connection and then refused it', () => {
    const { client, last, attemptsWithin } = setup();
    client.connect();
    for (let i = 0; i < 3; i++) {
      last().fire('open');
      last().fire('close');
      expect(attemptsWithin(60_000)).toBe(0);
      expect(attemptsWithin(REFUSED_RETRY_MS - 60_000)).toBe(1);
    }
    client.close();
  });

  it('resets the backoff only after the pairing succeeded', () => {
    const { client, last, attemptsWithin } = setup();
    client.connect();
    // A device that cannot be reached: 1 s, 2 s, 4 s ...
    last().fire('close');
    expect(attemptsWithin(RECONNECT_BASE_MS)).toBe(1);
    last().fire('close');
    expect(attemptsWithin(RECONNECT_BASE_MS)).toBe(0);
    expect(attemptsWithin(RECONNECT_BASE_MS)).toBe(1);
    last().fire('open');
    client.markPaired();
    last().fire('close');
    expect(attemptsWithin(RECONNECT_BASE_MS)).toBe(1);
    client.close();
  });

  it('counts attempts in a row that did not reach the device', () => {
    const { client, last, attemptsWithin } = setup();
    const changes: number[] = [];
    client.onClose(() => changes.push(client.failures));
    client.connect();
    last().fire('error', new Error('EHOSTUNREACH'));
    last().fire('close');
    attemptsWithin(RECONNECT_BASE_MS);
    last().fire('close');
    expect(client.failures).toBe(2);
    attemptsWithin(RECONNECT_BASE_MS * 2);
    last().fire('open');
    expect(client.failures).toBe(0);
    expect(changes).toEqual([1, 2]);
    client.close();
  });

  it('retries a refusing device at once when asked', () => {
    const { client, last } = setup();
    client.connect();
    last().fire('open');
    last().fire('close');
    client.reconnectNow();
    expect(FakeSocket.all.length).toBe(2);
    client.close();
  });
});
