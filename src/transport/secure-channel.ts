import { normalizeSyncKey } from './auth';

/**
 * Encryption of a paired connection.
 *
 * After both devices have proven that they know the sync key, each derives
 * the same two AES-256-GCM keys from the key and both handshake nonces (one
 * key per direction), so every connection has keys of its own. Each message
 * is sealed as [8-byte counter][ciphertext + tag]. The counter is the GCM
 * nonce and must go up by one per message, which also rejects replayed,
 * dropped or reordered messages.
 */
export class SecureChannel {
  private sendCounter = 0n;
  private recvCounter = 0n;

  private constructor(private sendKey: CryptoKey, private recvKey: CryptoKey) {}

  /** Keys for one side of a connection; `isClient` is the side that dialed. */
  static async derive(
    syncKey: string,
    clientNonce: string,
    serverNonce: string,
    isClient: boolean,
  ): Promise<SecureChannel> {
    const enc = new TextEncoder();
    const base = await crypto.subtle.importKey(
      'raw',
      enc.encode(normalizeSyncKey(syncKey)),
      'HKDF',
      false,
      ['deriveKey'],
    );
    const salt = enc.encode(`${clientNonce}|${serverNonce}`);
    const key = (info: string) =>
      crypto.subtle.deriveKey(
        { name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode(info) },
        base,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt'],
      );
    const toServer = await key('lan-vault-sync v2 client-to-server');
    const toClient = await key('lan-vault-sync v2 server-to-client');
    return isClient ? new SecureChannel(toServer, toClient) : new SecureChannel(toClient, toServer);
  }

  /**
   * Encrypt one message. The counter is taken when this is called, so
   * messages must be sent in the order seal() was called.
   */
  async seal(plain: Uint8Array): Promise<Uint8Array> {
    const counter = ++this.sendCounter;
    const sealed = new Uint8Array(
      await crypto.subtle.encrypt({ name: 'AES-GCM', iv: SecureChannel.iv(counter) as BufferSource }, this.sendKey, plain as BufferSource),
    );
    const frame = new Uint8Array(8 + sealed.byteLength);
    new DataView(frame.buffer).setBigUint64(0, counter, false);
    frame.set(sealed, 8);
    return frame;
  }

  /** Decrypt the next message; throws when it is forged, replayed or out of order. */
  async open(frame: Uint8Array): Promise<Uint8Array> {
    if (frame.byteLength < 8 + 16) throw new Error('Encrypted message too short');
    const counter = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getBigUint64(0, false);
    if (counter !== this.recvCounter + 1n) throw new Error('Encrypted message out of order');
    const plain = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: SecureChannel.iv(counter) as BufferSource },
        this.recvKey,
        frame.subarray(8) as BufferSource,
      ),
    );
    this.recvCounter = counter;
    return plain;
  }

  private static iv(counter: bigint): Uint8Array {
    const iv = new Uint8Array(12);
    new DataView(iv.buffer).setBigUint64(4, counter, false);
    return iv;
  }
}
