import { DeviceInfo } from '../types';
import { DISCOVERY_PORT, DISCOVERY_INTERVAL_MS } from '../constants';
import { logger } from '../logger';
import { getDynamicRequire } from '../utils/runtime';
import { getIPv4BroadcastAddresses } from '../utils/network';

/** Reaches every network, but leaves through one interface only; see broadcast. */
const LIMITED_BROADCAST = '255.255.255.255';

export class UdpBroadcast {
  private socket: {
    bind(port: number, callback: () => void): void;
    close(): void;
    send(
      msg: Uint8Array,
      offset: number,
      length: number,
      port: number,
      address: string,
      callback: (err: Error | null) => void,
    ): void;
    setBroadcast(enabled: boolean): void;
    on(event: string, listener: (...args: any[]) => void): void;
  } | null = null;
  private broadcastTimer: ReturnType<typeof setInterval> | null = null;
  private onDeviceSeenCb: ((device: DeviceInfo) => void) | null = null;
  /** Addresses whose last send failed, so a failure is logged once. */
  private failing = new Set<string>();
  /** How many times sending to an address started failing. */
  private reported = new Map<string, number>();

  constructor(private localDevice: DeviceInfo) {}

  onDeviceSeen(cb: (device: DeviceInfo) => void): void {
    this.onDeviceSeenCb = cb;
  }

  start(): Promise<void> {
    return new Promise((resolve) => {
      try {
        const require = getDynamicRequire();
        if (!require) {
          resolve();
          return;
        }

        const dgram = require('dgram') as {
          createSocket(options: { type: 'udp4'; reuseAddr: boolean }): typeof this.socket;
        };
        const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
        this.socket = socket;
        let settled = false;

        socket.on('error', (err: Error) => {
          logger.error('UDP socket error:', err);
          if (!settled) {
            settled = true;
            socket.close();
            this.socket = null;
            resolve();
          }
        });

        socket.on('message', (msg: Uint8Array, rinfo: { address: string }) => {
          try {
            const data = JSON.parse(new TextDecoder().decode(msg)) as DeviceInfo;
            // Ignore our own broadcasts. Another device with our ID (a
            // different run) goes on, to be reported as such.
            if (data.deviceId === this.localDevice.deviceId && data.instance === this.localDevice.instance) return;
            // Fill in the sender's IP from the packet (more reliable)
            data.ip = rinfo.address;
            data.lastSeen = Date.now();
            this.onDeviceSeenCb?.(data);
          } catch {
            // ignore malformed packets
          }
        });

        socket.bind(DISCOVERY_PORT, () => {
          if (settled) {
            return;
          }
          settled = true;
          socket.setBroadcast(true);
          this._startBroadcasting();
          logger.info(`UDP discovery started on port ${DISCOVERY_PORT}`);
          resolve();
        });
      } catch (err) {
        logger.warn('UDP discovery not available (mobile?):', err);
        resolve();
      }
    });
  }

  stop(): void {
    if (this.broadcastTimer) {
      clearInterval(this.broadcastTimer);
      this.broadcastTimer = null;
    }
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
  }

  private _startBroadcasting(): void {
    const broadcast = () => {
      if (!this.socket) return;
      const msg = new TextEncoder().encode(JSON.stringify(this.localDevice));
      // The limited broadcast leaves through the interface of the default
      // route only, and fails (EHOSTUNREACH on macOS) while that route is
      // missing or points elsewhere, e.g. at a VPN. Each network's own
      // broadcast address reaches its devices regardless. Interfaces are
      // read every time: Wi-Fi may change networks while sync runs.
      const addresses = new Set([LIMITED_BROADCAST, ...getIPv4BroadcastAddresses()]);
      for (const address of addresses) {
        this.socket.send(msg, 0, msg.length, DISCOVERY_PORT, address, (err) => this._logSend(address, err));
      }
    };

    broadcast();
    this.broadcastTimer = setInterval(broadcast, DISCOVERY_INTERVAL_MS);
  }

  /**
   * Log a failing address once until it works again. Sends repeat every few
   * seconds, and a failure that lasts would otherwise fill the log.
   */
  private _logSend(address: string, err: Error | null): void {
    // An interface that keeps going up and down (seen with a USB network
    // adapter on macOS) is reported once; later changes go to the debug log.
    const reported = this.reported.get(address) ?? 0;
    if (err) {
      if (this.failing.has(address)) return;
      this.failing.add(address);
      const text = `Discovery broadcast to ${address} failed: ${err.message}. Still trying.`;
      if (reported === 0) logger.warn(text);
      else logger.debug(text);
      this.reported.set(address, reported + 1);
    } else if (this.failing.delete(address)) {
      const text = `Discovery broadcast to ${address} works again`;
      if (reported === 1) logger.info(text);
      else logger.debug(text);
    }
  }
}
