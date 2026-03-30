import { DeviceInfo } from '../types';
import { DISCOVERY_PORT, DISCOVERY_INTERVAL_MS } from '../constants';
import { logger } from '../logger';
import { getDynamicRequire } from '../utils/runtime';

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

  constructor(private localDevice: DeviceInfo) {}

  onDeviceSeen(cb: (device: DeviceInfo) => void): void {
    this.onDeviceSeenCb = cb;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        const require = getDynamicRequire();
        if (!require) {
          resolve();
          return;
        }

        const dgram = require('dgram') as {
          createSocket(options: { type: 'udp4'; reuseAddr: boolean }): typeof this.socket;
        };
        this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

        this.socket.on('error', (err) => {
          logger.error('UDP socket error:', err);
        });

        this.socket.on('message', (msg: Uint8Array, rinfo: { address: string }) => {
          try {
            const data = JSON.parse(new TextDecoder().decode(msg)) as DeviceInfo;
            // Ignore our own broadcasts
            if (data.deviceId === this.localDevice.deviceId) return;
            // Fill in the sender's IP from the packet (more reliable)
            data.ip = rinfo.address;
            data.lastSeen = Date.now();
            this.onDeviceSeenCb?.(data);
          } catch {
            // ignore malformed packets
          }
        });

        this.socket.bind(DISCOVERY_PORT, () => {
          this.socket!.setBroadcast(true);
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
      this.socket.send(msg, 0, msg.length, DISCOVERY_PORT, '255.255.255.255', (err) => {
        if (err) logger.debug('Broadcast send error:', err.message);
      });
    };

    broadcast();
    this.broadcastTimer = setInterval(broadcast, DISCOVERY_INTERVAL_MS);
  }
}
