/**
 * Vault identity (plan 6.3). Devices sync with each other only when their
 * vault IDs match. It used to come from the vault's folder name alone, so
 * two different vaults with the same name (or one renamed on one device)
 * were mixed up or kept apart. Now a random ID is made with a new sync key
 * and passed on by pairing; installs from before keep the name's ID.
 */

/** The ID older versions derive from the vault's name. */
export function nameVaultId(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash << 5) - hash + name.charCodeAt(i);
    hash |= 0;
  }
  return "vault-" + Math.abs(hash).toString(36);
}

export function randomVaultId(): string {
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  return "v-" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function effectiveVaultId(settings: { vaultId?: string }, vaultName: string): string {
  return settings.vaultId || nameVaultId(vaultName);
}

/** Accepts only IDs these functions make, so a link cannot carry anything else. */
export function isValidVaultId(id: string): boolean {
  return /^(vault-[0-9a-z]{1,13}|v-[0-9a-f]{18})$/.test(id);
}

export function randomInstanceId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
