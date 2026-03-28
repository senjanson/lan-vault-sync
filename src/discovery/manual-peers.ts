import { DeviceInfo } from '../types';
import { logger } from '../logger';

/**
 * Manual peer management — for environments where UDP broadcast
 * doesn't work (e.g. mobile, some corporate networks).
 */
export class ManualPeers {
  private peers = new Map<string, DeviceInfo>();

  addPeer(address: string, vaultId: string): DeviceInfo {
    const [ip, portStr] = address.split(':');
    const port = parseInt(portStr, 10);

    if (!ip || isNaN(port)) {
      throw new Error(`Invalid address: ${address}. Expected format: ip:port`);
    }

    const device: DeviceInfo = {
      deviceId: `manual-${ip}-${port}`,
      deviceName: `Manual (${ip})`,
      ip,
      port,
      vaultId,
      lastSeen: Date.now(),
    };

    this.peers.set(device.deviceId, device);
    logger.info(`Manual peer added: ${address}`);
    return device;
  }

  removePeer(address: string): void {
    const [ip, portStr] = address.split(':');
    const port = parseInt(portStr, 10);
    const id = `manual-${ip}-${port}`;
    this.peers.delete(id);
  }

  getPeers(): DeviceInfo[] {
    return Array.from(this.peers.values());
  }
}
