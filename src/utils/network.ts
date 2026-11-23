import { Platform } from 'obsidian';
import type { NodeWindow } from './runtime';

interface OsModule {
  networkInterfaces(): Record<string, Array<{
    family: string | number;
    internal: boolean;
    address: string;
    netmask: string;
  }> | undefined>;
}

/** Node's os module; null on mobile, where there is none. */
function loadOs(): OsModule | null {
  if (!Platform.isDesktopApp) return null;
  return ((window as NodeWindow).require?.('os') as OsModule | undefined) ?? null;
}

export function getLocalIPv4Addresses(): string[] {
  try {
    const os = loadOs();
    if (!os) {
      return [];
    }

    const interfaces = os.networkInterfaces();
    const ips: string[] = [];

    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name] ?? []) {
        if (iface.family === 'IPv4' && !iface.internal) {
          ips.push(iface.address);
        }
      }
    }

    return ips;
  } catch {
    // os module may not be available on mobile
    return [];
  }
}

/**
 * The broadcast address of each IPv4 network this device is on, e.g.
 * 192.168.1.255. Empty where Node's os module is missing (mobile).
 */
export function getIPv4BroadcastAddresses(): string[] {
  try {
    const os = loadOs();
    if (!os) {
      return [];
    }

    const addresses = new Set<string>();
    for (const list of Object.values(os.networkInterfaces())) {
      for (const iface of list ?? []) {
        // Node 18.0 to 18.3 report the family as a number.
        if ((iface.family !== 'IPv4' && iface.family !== 4) || iface.internal) continue;
        const broadcast = subnetBroadcastAddress(iface.address, iface.netmask);
        if (broadcast) addresses.add(broadcast);
      }
    }
    return Array.from(addresses);
  } catch {
    return [];
  }
}

/**
 * The broadcast address of the network `address` is on. Null for a network
 * of one or two hosts (a VPN tunnel, for example), which has none.
 */
export function subnetBroadcastAddress(address: string, netmask: string): string | null {
  const ip = ipv4ToNumber(address);
  const mask = ipv4ToNumber(netmask);
  if (ip === null || mask === null) return null;
  const hostBits = ~mask >>> 0;
  if (hostBits <= 1) return null;
  const broadcast = (ip | hostBits) >>> 0;
  return [24, 16, 8, 0].map((shift) => (broadcast >>> shift) & 255).join('.');
}

function ipv4ToNumber(text: string): number | null {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part) || Number(part) > 255) return null;
    value = value * 256 + Number(part);
  }
  return value;
}
