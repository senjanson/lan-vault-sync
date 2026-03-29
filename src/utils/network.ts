import * as os from 'os';

export function getLocalIPv4Addresses(): string[] {
  try {
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
