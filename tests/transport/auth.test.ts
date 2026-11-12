import { describe, expect, it } from 'vitest';
import { authProof, generateSyncKey, normalizeSyncKey, proofsMatch } from '../../src/transport/auth';
import { buildPeerURI } from '../../src/ui/qr-code';

describe('sync key', () => {
  it('generates distinct readable keys', () => {
    const a = generateSyncKey();
    expect(a).toMatch(/^[A-Z2-9]{4}(-[A-Z2-9]{4}){4}$/);
    expect(generateSyncKey()).not.toBe(a);
  });

  it('gives the same proof for the same key typed differently, and not for another key', async () => {
    const p = await authProof('ABCD-EFGH', 'msg');
    expect(proofsMatch(await authProof(' abcd efgh ', 'msg'), p)).toBe(true);
    expect(proofsMatch(await authProof('ABCD-EFGX', 'msg'), p)).toBe(false);
    expect(proofsMatch(undefined, p)).toBe(false);
    expect(normalizeSyncKey('ab-cd ef')).toBe('ABCDEF');
  });

  it('puts the key into the pairing link', () => {
    expect(buildPeerURI('192.168.1.5', 50000, 'AB+C')).toBe(
      'obsidian://lan-vault-sync?address=192.168.1.5:50000&key=AB%2BC',
    );
  });
});
