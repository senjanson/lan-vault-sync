import * as dgram from 'dgram';
import { DeviceInfo } from '../types';
import { DISCOVERY_PORT, DISCOVERY_INTERVAL_MS } from '../constants';
import { logger } from '../logger';

export class UdpBroadcast {
  private socket: dgram.Socket | null = null;
  private broadcastTimer: ReturnType<typeof setInterval> | null = null;
  private onDeviceSeenCb: ((device: DeviceInfo) => void) | null = null;

  constructor(private localDevice: DeviceInfo) {}

  onDeviceSeen(cb: (device: DeviceInfo) => void): void {
    this.onDeviceSeenCb = cb;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

        this.socket.on('error', (err) => {
          logger.error('UDP socket error:', err);
        });

        this.socket.on('message', (msg, rinfo) => {
          try {
            const data = JSON.parse(msg.toString()) as DeviceInfo;
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
        // Don't reject — discovery is optional
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
      const msg = Buffer.from(JSON.stringify(this.localDevice));
      this.socket.send(msg, 0, msg.length, DISCOVERY_PORT, '255.255.255.255', (err) => {
        if (err) logger.debug('Broadcast send error:', err.message);
      });
    };

    broadcast();
    this.broadcastTimer = setInterval(broadcast, DISCOVERY_INTERVAL_MS);
  }
}
