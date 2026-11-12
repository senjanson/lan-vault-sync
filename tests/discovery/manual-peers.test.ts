import { describe, expect, it } from 'vitest';
import { parsePeerAddress } from '../../src/discovery/manual-peers';

describe('parsePeerAddress', () => {
  it('accepts ip:port and host names', () => {
    expect(parsePeerAddress(' 192.168.1.5:51234 ')).toEqual({ ip: '192.168.1.5', port: 51234 });
    expect(parsePeerAddress('my-pc.local:8080')).toEqual({ ip: 'my-pc.local', port: 8080 });
  });

  it('rejects addresses without a valid port', () => {
    for (const bad of ['192.168.1.5', '192.168.1.5:abc', ':8080', '1.2.3.4:0', '1.2.3.4:70000', '1.2.3.4:80x']) {
      expect(parsePeerAddress(bad)).toBeNull();
    }
  });
});
