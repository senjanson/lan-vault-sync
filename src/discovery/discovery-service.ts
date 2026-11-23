import { DeviceInfo } from '../types';
import { DEVICE_TIMEOUT_MS } from '../constants';
import { UdpBroadcast } from './udp-broadcast';
import { ManualPeers, parsePeerAddress } from './manual-peers';
import { logger } from '../logger';

export class DiscoveryService {
  private devices = new Map<string, DeviceInfo>();
  private udp: UdpBroadcast | null = null;
  private manual: ManualPeers;
  private cleanupTimer: number | null = null;

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

  private onDuplicateCb: ((deviceName: string) => void) | null = null;

  /** Another device of this vault announces this device's ID. */
  onDuplicateDevice(cb: (deviceName: string) => void): void {
    this.onDuplicateCb = cb;
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
    this.cleanupTimer = window.setInterval(() => this._cleanupStale(), DEVICE_TIMEOUT_MS);
  }

  stop(): void {
    this.udp?.stop();
    if (this.cleanupTimer) {
      window.clearInterval(this.cleanupTimer);
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
    // UDP discovery hears every vault on the network. Another vault's
    // devices refuse the pairing, so they are not listed or called at all.
    if (device.vaultId !== this.localDevice.vaultId) return;
    if (device.deviceId === this.localDevice.deviceId) {
      if (device.instance && this.localDevice.instance && device.instance !== this.localDevice.instance) {
        this.onDuplicateCb?.(device.deviceName ?? "");
      }
      return;
    }
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
