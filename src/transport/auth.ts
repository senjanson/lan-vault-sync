/**
 * Pairing key checks for the LAN handshake.
 *
 * Both devices prove they know the same sync key without sending it: each
 * side sends a random nonce and answers the other's nonce with an HMAC.
 * Traffic is still not encrypted; the key only keeps unknown devices from
 * reading or changing the vault.
 */

const KEY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** A random key such as "K7QF-2M9X-HR4T-8WNC-PZ3D" (about 100 bits). */
export function generateSyncKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  let key = '';
  for (let i = 0; i < bytes.length; i++) {
    if (i > 0 && i % 4 === 0) key += '-';
    key += KEY_ALPHABET[bytes[i] % KEY_ALPHABET.length];
  }
  return key;
}

/** Keys are compared without case, spaces or dashes, so typing is forgiving. */
export function normalizeSyncKey(key: string): string {
  return key.replace(/[\s-]/g, '').toUpperCase();
}

export function randomNonce(): string {
  return toHex(crypto.getRandomValues(new Uint8Array(16)));
}

export async function authProof(key: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(normalizeSyncKey(key)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return toHex(new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(message))));
}

/** Constant-time comparison of two proofs. */
export function proofsMatch(a: unknown, b: string): boolean {
  if (typeof a !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** What the listening side signs in its handshake ack. */
export function ackMessage(clientNonce: string, serverNonce: string, serverId: string): string {
  return `ack|${clientNonce}|${serverNonce}|${serverId}`;
}

/** What the connecting side signs in its AUTH message. */
export function authMessage(serverNonce: string, clientNonce: string, clientId: string): string {
  return `auth|${serverNonce}|${clientNonce}|${clientId}`;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
