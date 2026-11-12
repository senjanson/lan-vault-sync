import { DeviceInfo } from '../types';
import { logger } from '../logger';

/**
 * Manual peer management — for environments where UDP broadcast
 * doesn't work (e.g. mobile, some corporate networks).
 */
/** Parse "ip:port" (host may be a name). Returns null when it is not usable. */
export function parsePeerAddress(address: string): { ip: string; port: number } | null {
  const trimmed = address.trim();
  const sep = trimmed.lastIndexOf(':');
  if (sep <= 0) return null;
  const ip = trimmed.slice(0, sep).trim();
  const portStr = trimmed.slice(sep + 1).trim();
  if (!ip || /\s/.test(ip) || !/^\d+$/.test(portStr)) return null;
  const port = Number(portStr);
  if (port < 1 || port > 65535) return null;
  return { ip, port };
}

export class ManualPeers {
  private peers = new Map<string, DeviceInfo>();

  addPeer(address: string, vaultId: string): DeviceInfo {
    const parsed = parsePeerAddress(address);
    if (!parsed) {
      throw new Error(`Invalid address: ${address}. Expected format: ip:port`);
    }
    const { ip, port } = parsed;

    const device: DeviceInfo = {
      deviceId: `manual-${ip}-${port}`,
      deviceName: `Manual (${ip})`,
      ip,
      port,
      vaultId,
      lastSeen: Date.now(),
      acceptsIncomingConnections: true,
    };

    this.peers.set(device.deviceId, device);
    logger.info(`Manual peer added: ${address}`);
    return device;
  }

  removePeer(address: string): void {
    const parsed = parsePeerAddress(address);
    if (!parsed) return;
    this.peers.delete(`manual-${parsed.ip}-${parsed.port}`);
  }

  getPeers(): DeviceInfo[] {
    return Array.from(this.peers.values());
  }
}
