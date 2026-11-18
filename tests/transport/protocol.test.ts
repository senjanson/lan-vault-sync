import { describe, expect, it } from 'vitest';

import * as Y from 'yjs';
import { decodeFileData, decodeFullStateData, decodeMessage, decodeSyncStep1Data, decodeYjsSync, encodeFullStateData, encodeMessage, encodeSyncStep1Data } from '../../src/transport/protocol';
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

describe('text sent with a sync request', () => {
  const doc = new Y.Doc();
  doc.getText('content').insert(0, 'hello');
  // Several clients, and clocks that take more than one byte.
  for (let i = 0; i < 3; i++) {
    const other = new Y.Doc();
    other.getText('content').insert(0, 'x'.repeat(300));
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(other));
  }
  const sv = Y.encodeStateVector(doc);

  it('reads back the state vector and the text', () => {
    const data = encodeSyncStep1Data(sv, { text: '日记\nline', mtime: 1700000000123.5 });
    const { stateVector, apart } = decodeSyncStep1Data(data);
    expect(Array.from(stateVector)).toEqual(Array.from(sv));
    expect(apart).toEqual({ text: '日记\nline', mtime: 1700000000123.5 });
  });

  it('reads a plain state vector, or one followed by something unknown, as before', () => {
    expect(decodeSyncStep1Data(sv)).toEqual({ stateVector: sv });
    expect(decodeSyncStep1Data(Y.encodeStateVector(new Y.Doc())).apart).toBeUndefined();
    const garbled = new Uint8Array([...sv, 0x01, 0x7b]);
    expect(Array.from(decodeSyncStep1Data(garbled).stateVector)).toEqual(Array.from(sv));
    expect(decodeSyncStep1Data(garbled).apart).toBeUndefined();
  });

  it('is read by Yjs (as older versions do) as the state vector alone', () => {
    const data = encodeSyncStep1Data(sv, { text: 'text', mtime: 1 });
    expect(Y.decodeStateVector(data)).toEqual(Y.decodeStateVector(sv));
    const behind = new Y.Doc();
    expect(Y.encodeStateAsUpdate(doc, data)).toEqual(Y.encodeStateAsUpdate(doc, sv));
    expect(Y.encodeStateAsUpdate(doc, encodeSyncStep1Data(Y.encodeStateVector(behind), { text: '', mtime: 0 })))
      .toEqual(Y.encodeStateAsUpdate(doc, Y.encodeStateVector(behind)));
  });
});

describe('whole doc marked as an adopted history', () => {
  const doc = new Y.Doc();
  doc.getText('content').insert(0, 'hello world\n');
  doc.getText('content').delete(2, 3);
  const update = Y.encodeStateAsUpdate(doc);

  it('reads back the update and the dropped text\'s hash', () => {
    expect(decodeFullStateData(encodeFullStateData(update))).toEqual({ update });
    for (const dropped of ['ab'.repeat(32), '']) {
      const marked = decodeFullStateData(encodeFullStateData(update, { dropped }));
      expect(marked.adopted).toEqual({ dropped });
      expect(Array.from(marked.update)).toEqual(Array.from(update));
    }
  });

  it('never takes an update for a marked one', () => {
    // An update ends with a variable-length integer, below 0x80.
    for (const u of [update, Y.encodeStateAsUpdate(new Y.Doc()), new Uint8Array(0)]) {
      expect(decodeFullStateData(u).adopted).toBeUndefined();
    }
  });

  it('is read by Yjs (as older versions do) as the update alone', () => {
    const data = encodeFullStateData(update, { dropped: 'ab'.repeat(32) });
    const other = new Y.Doc();
    Y.applyUpdate(other, data);
    expect(other.getText('content').toString()).toBe('he world\n');
    expect(Y.decodeStateVector(Y.encodeStateVectorFromUpdate(data))).toEqual(Y.decodeStateVector(Y.encodeStateVector(doc)));
  });
});
