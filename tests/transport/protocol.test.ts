import { describe, expect, it } from 'vitest';

import { decodeFileData, decodeMessage, decodeYjsSync, encodeMessage } from '../../src/transport/protocol';
import { MessageType } from '../../src/types';

describe('protocol guards', () => {
  it('rejects messages with incomplete headers', () => {
    expect(() => decodeMessage(new Uint8Array([MessageType.PING, 0, 0, 0]))).toThrow(/incomplete header/i);
  });

  it('rejects messages with truncated payloads', () => {
    const frame = encodeMessage(MessageType.FILE_REQUEST, new TextEncoder().encode('note.md'));
    expect(() => decodeMessage(frame.slice(0, frame.length - 2))).toThrow(/expected 7 payload bytes, got 5/i);
  });

  it('rejects truncated Yjs payload paths', () => {
    const payload = new Uint8Array([0, 4, 0x6e, 0x6f]);
    expect(() => decodeYjsSync(payload)).toThrow(/truncated path/i);
  });

  it('rejects truncated file metadata payloads', () => {
    const payload = new Uint8Array([0, 4, 0x6e, 0x6f, 0x74, 0x65]);
    expect(() => decodeFileData(payload)).toThrow(/truncated metadata/i);
  });
});

describe('file chunks', () => {
  it('round-trips a chunk with its offsets', async () => {
    const { encodeFileChunk, decodeFileChunk, decodeMessage } = await import('../../src/transport/protocol');
    const msg = decodeMessage(encodeFileChunk({
      path: '视频/a b.mp4', mtime: 123.5, totalSize: 3_000_000_000, offset: 2_147_483_648, content: new Uint8Array([1, 2, 3]),
    }));
    const chunk = decodeFileChunk(msg.payload);
    expect(chunk).toMatchObject({ path: '视频/a b.mp4', mtime: 123.5, totalSize: 3_000_000_000, offset: 2_147_483_648 });
    expect(Array.from(chunk.content)).toEqual([1, 2, 3]);
  });
});
