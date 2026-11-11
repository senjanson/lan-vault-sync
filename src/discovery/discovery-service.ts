import { DeviceInfo, LANSyncSettings } from '../types';
import { DEVICE_TIMEOUT_MS } from '../constants';
import { UdpBroadcast } from './udp-broadcast';
import { ManualPeers, parsePeerAddress } from './manual-peers';
import { logger } from '../logger';

export class DiscoveryService {
  private devices = new Map<string, DeviceInfo>();
  private udp: UdpBroadcast | null = null;
  private manual: ManualPeers;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  private onFoundCb: ((device: DeviceInfo) => void) | null = null;
  private onLostCb: ((device: DeviceInfo) => void) | null = null;

  constructor(private localDevice: DeviceInfo) {
    this.manual = new ManualPeers();
  }

  onDeviceFound(cb: (device: DeviceInfo) => void): void {
    this.onFoundCb = cb;
  }

  onDeviceLost(cb: (device: DeviceInfo) => void): void {
    this.onLostCb = cb;
  }

  async start(): Promise<void> {
    // Try UDP broadcast (may not work on mobile)
    this.udp = new UdpBroadcast(this.localDevice);
    this.udp.onDeviceSeen((device) => this._handleDeviceSeen(device));

    try {
      await this.udp.start();
    } catch {
      logger.warn('UDP broadcast unavailable, relying on manual peers');
    }

    // Start cleanup timer
    this.cleanupTimer = setInterval(() => this._cleanupStale(), DEVICE_TIMEOUT_MS);
  }

  stop(): void {
    this.udp?.stop();
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  getOnlineDevices(): DeviceInfo[] {
    return Array.from(this.devices.values());
  }

  addManualPeer(address: string, vaultId: string): void {
    const device = this.manual.addPeer(address, vaultId);
    this._handleDeviceSeen(device);
  }

  removeManualPeer(address: string): void {
    const parsed = parsePeerAddress(address);
    this.manual.removePeer(address);
    if (parsed) this.devices.delete(`manual-${parsed.ip}-${parsed.port}`);
  }

  private _handleDeviceSeen(device: DeviceInfo): void {
    const existing = this.devices.get(device.deviceId);
    device.lastSeen = Date.now();
    this.devices.set(device.deviceId, device);

    if (!existing) {
      logger.info(`Device found: ${device.deviceName} (${device.ip}:${device.port})`);
      this.onFoundCb?.(device);
    }
  }

  private _cleanupStale(): void {
    const now = Date.now();
    for (const [id, device] of this.devices) {
      // Don't clean up manual peers
      if (id.startsWith('manual-')) continue;

      if (now - device.lastSeen > DEVICE_TIMEOUT_MS) {
        this.devices.delete(id);
        logger.info(`Device lost: ${device.deviceName}`);
        this.onLostCb?.(device);
      }
    }
  }
}
