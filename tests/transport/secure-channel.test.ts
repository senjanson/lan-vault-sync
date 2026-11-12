import { describe, expect, it } from 'vitest';
import { SecureChannel } from '../../src/transport/secure-channel';

const pair = async (clientKey = 'ABCD-EFGH-JKLM', serverKey = clientKey) => ({
  client: await SecureChannel.derive(clientKey, 'c-nonce', 's-nonce', true),
  server: await SecureChannel.derive(serverKey, 'c-nonce', 's-nonce', false),
});
const text = (s: string) => new TextEncoder().encode(s);

describe('SecureChannel', () => {
  it('carries messages both ways without the text showing', async () => {
    const { client, server } = await pair();
    const frame = await client.seal(text('secret note text'));
    expect(Buffer.from(frame).includes(Buffer.from('secret'))).toBe(false);
    expect(new TextDecoder().decode(await server.open(frame))).toBe('secret note text');
    const back = await server.seal(text('reply'));
    expect(new TextDecoder().decode(await client.open(back))).toBe('reply');
  });

  it('rejects a changed, replayed or reordered message', async () => {
    const { client, server } = await pair();
    const a = await client.seal(text('a'));
    const b = await client.seal(text('b'));
    const forged = a.slice(); forged[forged.length - 1] ^= 1;
    await expect(server.open(forged)).rejects.toThrow();
    await expect(server.open(b)).rejects.toThrow();
    await server.open(a);
    await expect(server.open(a)).rejects.toThrow();
    await server.open(b);
  });

  it('cannot be read with another key', async () => {
    const { client, server } = await pair('ABCD-EFGH-JKLM', 'ZZZZ-EFGH-JKLM');
    await expect(server.open(await client.seal(text('x')))).rejects.toThrow();
  });

  it('does not let a client message pass as a server message', async () => {
    const { client } = await pair();
    const other = await SecureChannel.derive('ABCD-EFGH-JKLM', 'c-nonce', 's-nonce', true);
    await expect(other.open(await client.seal(text('x')))).rejects.toThrow();
  });
});
