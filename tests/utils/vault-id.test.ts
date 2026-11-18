import { describe, expect, it } from 'vitest';
import { effectiveVaultId, isValidVaultId, nameVaultId, randomVaultId } from '../../src/utils/vault-id';
import { buildPeerURI } from '../../src/ui/qr-code';

describe('vault ID', () => {
  it('keeps the name-based ID for installs from before, and takes a set one over it', () => {
    expect(effectiveVaultId({ vaultId: '' }, 'Notes')).toBe(nameVaultId('Notes'));
    const id = randomVaultId();
    expect(effectiveVaultId({ vaultId: id }, 'Notes')).toBe(id);
    expect(randomVaultId()).not.toBe(id);
  });

  it('accepts only IDs it makes, so a pairing link cannot carry anything else', () => {
    expect(isValidVaultId(randomVaultId())).toBe(true);
    expect(isValidVaultId(nameVaultId('Weekend Escape'))).toBe(true);
    expect(isValidVaultId('v-x"><script>')).toBe(false);
    expect(isValidVaultId('')).toBe(false);
  });

  it('puts the vault ID in the pairing link', () => {
    expect(buildPeerURI('10.0.0.2', 5000, 'KEY', 'v-0123456789abcdef01')).toBe(
      'obsidian://lan-vault-sync?address=10.0.0.2:5000&key=KEY&vault=v-0123456789abcdef01',
    );
  });
});
