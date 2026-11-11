import {
  MessageType,
  HandshakePayload,
  YjsSyncMessage,
  FileMetaSyncPayload,
  FileDataPayload,
  FileChunkPayload,
  FileDeletePayload,
  FileRenamePayload,
} from '../types';

/**
 * Wire format:
 *   [1 byte type][4 bytes payload length (BE)][payload bytes]
 */

export function encodeMessage(type: MessageType, payload: Uint8Array): Uint8Array {
  const buf = new Uint8Array(1 + 4 + payload.length);
  buf[0] = type;
  const view = new DataView(buf.buffer);
  view.setUint32(1, payload.length, false);
  buf.set(payload, 5);
  return buf;
}

export function decodeMessage(data: Uint8Array): { type: MessageType; payload: Uint8Array } {
  if (data.byteLength < 5) {
    throw new Error('Malformed message: incomplete header');
  }
  const type = data[0] as MessageType;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const len = view.getUint32(1, false);
  if (data.byteLength < 5 + len) {
    throw new Error(`Malformed message: expected ${len} payload bytes, got ${data.byteLength - 5}`);
  }
  const payload = data.slice(5, 5 + len);
  return { type, payload };
}

// ─── JSON helpers ────────────────────────────────────────

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeJSON(obj: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(obj));
}

export function decodeJSON<T>(data: Uint8Array): T {
  return JSON.parse(decoder.decode(data)) as T;
}

// ─── Handshake ───────────────────────────────────────────

export function encodeHandshake(payload: HandshakePayload): Uint8Array {
  return encodeMessage(MessageType.HANDSHAKE, encodeJSON(payload));
}

export function encodeHandshakeAck(payload: HandshakePayload): Uint8Array {
  return encodeMessage(MessageType.HANDSHAKE_ACK, encodeJSON(payload));
}

// ─── Yjs sync messages ──────────────────────────────────

export function encodeYjsSync(type: MessageType.YJS_SYNC_STEP1 | MessageType.YJS_SYNC_STEP2 | MessageType.YJS_UPDATE | MessageType.YJS_FULL_STATE, filePath: string, data: Uint8Array): Uint8Array {
  const pathBytes = encoder.encode(filePath);
  // [2 bytes path length (BE)][path bytes][data bytes]
  const payload = new Uint8Array(2 + pathBytes.length + data.length);
  const pv = new DataView(payload.buffer);
  pv.setUint16(0, pathBytes.length, false);
  payload.set(pathBytes, 2);
  payload.set(data, 2 + pathBytes.length);
  return encodeMessage(type, payload);
}

export function decodeYjsSync(payload: Uint8Array): YjsSyncMessage {
  if (payload.byteLength < 2) {
    throw new Error('Malformed Yjs sync payload: missing path length');
  }
  const pv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const pathLen = pv.getUint16(0, false);
  if (payload.byteLength < 2 + pathLen) {
    throw new Error('Malformed Yjs sync payload: truncated path');
  }
  const filePath = decoder.decode(payload.slice(2, 2 + pathLen));
  const data = payload.slice(2 + pathLen);
  return { filePath, data };
}

// ─── File meta ───────────────────────────────────────────

export function encodeFileMetaSync(payload: FileMetaSyncPayload): Uint8Array {
  return encodeMessage(MessageType.FILE_META_SYNC, encodeJSON(payload));
}

export function encodeFileRequest(path: string): Uint8Array {
  return encodeMessage(MessageType.FILE_REQUEST, encoder.encode(path));
}

export function decodeFileRequest(payload: Uint8Array): string {
  return decoder.decode(payload);
}

export function encodeFileData(payload: FileDataPayload): Uint8Array {
  const pathBytes = encoder.encode(payload.path);
  // [2 bytes path len][path][8 bytes mtime][content]
  const buf = new Uint8Array(2 + pathBytes.length + 8 + payload.content.length);
  const view = new DataView(buf.buffer);
  view.setUint16(0, pathBytes.length, false);
  buf.set(pathBytes, 2);
  // store mtime as float64
  view.setFloat64(2 + pathBytes.length, payload.mtime, false);
  buf.set(payload.content, 2 + pathBytes.length + 8);
  return encodeMessage(MessageType.FILE_DATA, buf);
}

export function decodeFileData(payload: Uint8Array): FileDataPayload {
  if (payload.byteLength < 2) {
    throw new Error('Malformed file payload: missing path length');
  }
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const pathLen = view.getUint16(0, false);
  if (payload.byteLength < 2 + pathLen + 8) {
    throw new Error('Malformed file payload: truncated metadata');
  }
  const path = decoder.decode(payload.slice(2, 2 + pathLen));
  const mtime = view.getFloat64(2 + pathLen, false);
  const content = payload.slice(2 + pathLen + 8);
  return { path, content, mtime };
}

export function encodeFileChunk(payload: FileChunkPayload): Uint8Array {
  const pathBytes = encoder.encode(payload.path);
  // [2 bytes path len][path][8 bytes mtime][8 bytes total size][8 bytes offset][content]
  const header = 2 + pathBytes.length + 24;
  const buf = new Uint8Array(header + payload.content.length);
  const view = new DataView(buf.buffer);
  view.setUint16(0, pathBytes.length, false);
  buf.set(pathBytes, 2);
  view.setFloat64(2 + pathBytes.length, payload.mtime, false);
  view.setFloat64(2 + pathBytes.length + 8, payload.totalSize, false);
  view.setFloat64(2 + pathBytes.length + 16, payload.offset, false);
  buf.set(payload.content, header);
  return encodeMessage(MessageType.FILE_CHUNK, buf);
}

export function decodeFileChunk(payload: Uint8Array): FileChunkPayload {
  if (payload.byteLength < 2) {
    throw new Error('Malformed chunk payload: missing path length');
  }
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const pathLen = view.getUint16(0, false);
  const header = 2 + pathLen + 24;
  if (payload.byteLength < header) {
    throw new Error('Malformed chunk payload: truncated metadata');
  }
  return {
    path: decoder.decode(payload.slice(2, 2 + pathLen)),
    mtime: view.getFloat64(2 + pathLen, false),
    totalSize: view.getFloat64(2 + pathLen + 8, false),
    offset: view.getFloat64(2 + pathLen + 16, false),
    content: payload.slice(header),
  };
}

export function encodeFileDelete(payload: FileDeletePayload): Uint8Array {
  return encodeMessage(MessageType.FILE_DELETE, encodeJSON(payload));
}

export function encodeFileRename(payload: FileRenamePayload): Uint8Array {
  return encodeMessage(MessageType.FILE_RENAME, encodeJSON(payload));
}

// ─── Ping / Pong ─────────────────────────────────────────

export function encodePing(): Uint8Array {
  return encodeMessage(MessageType.PING, new Uint8Array(0));
}

export function encodePong(): Uint8Array {
  return encodeMessage(MessageType.PONG, new Uint8Array(0));
}
