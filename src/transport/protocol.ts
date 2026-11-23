import {
  MessageType,
  HandshakePayload,
  AuthPayload,
  YjsSyncMessage,
  FileMetaSyncPayload,
  FileDataPayload,
  FileChunkPayload,
  FileDeletePayload,
  FileRenamePayload,
  FileVersionInfo,
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
  const type: MessageType = data[0];
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

export function encodeAuth(payload: AuthPayload): Uint8Array {
  return encodeMessage(MessageType.AUTH, encodeJSON(payload));
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

/**
 * A note's text on the sending device as the devices meet again, sent with
 * the state vector of a YJS_SYNC_STEP1 when the note differs between them.
 * See SyncCoordinator._settleApartEdits.
 */
export interface ApartText {
  text: string;
  /**
   * When the sender's version was made (FileMeta.madeAt), or its file last
   * modified. Both devices weigh the same two values, whichever was sent.
   */
  mtime: number;
}

const APART_TEXT_TAG = 0x01;

/**
 * The data of a YJS_SYNC_STEP1: a Yjs state vector, optionally followed by
 * the sender's text (see ApartText). Yjs reads a state vector up to its last
 * entry and ignores what follows, so older versions read such a message as
 * a plain state vector.
 */
export function encodeSyncStep1Data(stateVector: Uint8Array, apart?: ApartText): Uint8Array {
  if (!apart) return stateVector;
  const extra = encoder.encode(JSON.stringify({ text: apart.text, mtime: apart.mtime }));
  const data = new Uint8Array(stateVector.length + 1 + extra.length);
  data.set(stateVector, 0);
  data[stateVector.length] = APART_TEXT_TAG;
  data.set(extra, stateVector.length + 1);
  return data;
}

export function decodeSyncStep1Data(data: Uint8Array): { stateVector: Uint8Array; apart?: ApartText } {
  // A state vector is a count, then that many (client, clock) pairs, all
  // variable-length unsigned integers.
  let pos = 0;
  const readVarUint = (): number | null => {
    let value = 0;
    for (let shift = 0; pos < data.length && shift < 53; shift += 7) {
      const byte = data[pos++];
      value += (byte & 0x7f) * 2 ** shift;
      if (byte < 0x80) return value;
    }
    return null;
  };
  const count = readVarUint();
  for (let i = 0; count !== null && i < count * 2; i++) {
    if (readVarUint() === null) return { stateVector: data };
  }
  if (count === null || pos >= data.length || data[pos] !== APART_TEXT_TAG) {
    return { stateVector: data };
  }
  const stateVector = data.slice(0, pos);
  try {
    const extra = JSON.parse(decoder.decode(data.slice(pos + 1))) as Partial<ApartText>;
    if (typeof extra.text === 'string' && typeof extra.mtime === 'number' && Number.isFinite(extra.mtime)) {
      return { stateVector, apart: { text: extra.text, mtime: extra.mtime } };
    }
  } catch {
    // Not one we can read: the state vector still is.
  }
  return { stateVector };
}

/**
 * Marks the data of a YJS_FULL_STATE as a history the sender adopted a
 * moment ago (see SyncCoordinator.recentAdoptions), with the hash of the
 * text it dropped for it. Appended after the Yjs update, which Yjs reads up
 * to its end and ignores what follows, so older versions read such a
 * message as a plain update. An update in Yjs' format ends with a
 * variable-length integer, whose last byte is below 0x80: the mark ends
 * with 0xff, so no update is taken for a marked one.
 */
const ADOPTED_HISTORY_MARK = new Uint8Array([0x4c, 0x56, 0x53, 0x61, 0x64, 0x6f, 0x70, 0xff]);

/** A whole doc the sender adopted a moment ago: the hash of the text it had before. */
export interface AdoptedHistory {
  dropped: string;
}

/**
 * The data of a YJS_FULL_STATE: a Yjs update, then, for a history the
 * sender adopted a moment ago, the dropped text's hash, its length (one
 * byte) and the mark.
 */
export function encodeFullStateData(update: Uint8Array, adopted?: AdoptedHistory): Uint8Array {
  if (!adopted) return update;
  const dropped = encoder.encode(adopted.dropped).slice(0, 255);
  const data = new Uint8Array(update.length + dropped.length + 1 + ADOPTED_HISTORY_MARK.length);
  data.set(update, 0);
  data.set(dropped, update.length);
  data[update.length + dropped.length] = dropped.length;
  data.set(ADOPTED_HISTORY_MARK, update.length + dropped.length + 1);
  return data;
}

export function decodeFullStateData(data: Uint8Array): { update: Uint8Array; adopted?: AdoptedHistory } {
  const markAt = data.length - ADOPTED_HISTORY_MARK.length;
  if (markAt < 1 || ADOPTED_HISTORY_MARK.some((b, i) => data[markAt + i] !== b)) return { update: data };
  const droppedAt = markAt - 1 - data[markAt - 1];
  if (droppedAt < 0) return { update: data };
  return {
    update: data.slice(0, droppedAt),
    adopted: { dropped: decoder.decode(data.slice(droppedAt, markAt - 1)) },
  };
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

function versionInfo(p: FileVersionInfo): Uint8Array {
  const info: FileVersionInfo = {};
  if (p.hash) info.hash = p.hash;
  if (p.base) info.base = p.base;
  if (typeof p.madeAt === 'number' && Number.isFinite(p.madeAt)) info.madeAt = p.madeAt;
  return Object.keys(info).length ? encoder.encode(JSON.stringify(info)) : new Uint8Array(0);
}

function readVersionInfo(bytes: Uint8Array): FileVersionInfo {
  if (bytes.byteLength === 0) return {};
  try {
    const raw = JSON.parse(decoder.decode(bytes)) as Record<string, unknown>;
    const info: FileVersionInfo = {};
    if (typeof raw.hash === 'string') info.hash = raw.hash;
    if (typeof raw.base === 'string') info.base = raw.base;
    if (typeof raw.madeAt === 'number' && Number.isFinite(raw.madeAt)) info.madeAt = raw.madeAt;
    return info;
  } catch {
    return {};
  }
}

/**
 * FILE_DATA: [u16 path length][path][f64 mtime][u32 info length][info JSON]
 * [content]. The info (protocol 3) says which version this is; see
 * FileVersionInfo.
 */
export function encodeFileData(payload: FileDataPayload): Uint8Array {
  const pathBytes = encoder.encode(payload.path);
  const info = versionInfo(payload);
  const header = 2 + pathBytes.length + 8 + 4 + info.length;
  const buf = new Uint8Array(header + payload.content.length);
  const view = new DataView(buf.buffer);
  view.setUint16(0, pathBytes.length, false);
  buf.set(pathBytes, 2);
  view.setFloat64(2 + pathBytes.length, payload.mtime, false);
  view.setUint32(2 + pathBytes.length + 8, info.length, false);
  buf.set(info, 2 + pathBytes.length + 12);
  buf.set(payload.content, header);
  return encodeMessage(MessageType.FILE_DATA, buf);
}

export function decodeFileData(payload: Uint8Array): FileDataPayload {
  if (payload.byteLength < 2) {
    throw new Error('Malformed file payload: missing path length');
  }
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const pathLen = view.getUint16(0, false);
  if (payload.byteLength < 2 + pathLen + 12) {
    throw new Error('Malformed file payload: truncated metadata');
  }
  const path = decoder.decode(payload.slice(2, 2 + pathLen));
  const mtime = view.getFloat64(2 + pathLen, false);
  const infoLen = view.getUint32(2 + pathLen + 8, false);
  const header = 2 + pathLen + 12 + infoLen;
  if (payload.byteLength < header) {
    throw new Error('Malformed file payload: truncated metadata');
  }
  const info = readVersionInfo(payload.slice(2 + pathLen + 12, header));
  const content = payload.slice(header);
  return { path, content, mtime, ...info };
}

/** FILE_CHUNK: as FILE_DATA, with the total size and offset after mtime. */
export function encodeFileChunk(payload: FileChunkPayload): Uint8Array {
  const pathBytes = encoder.encode(payload.path);
  const info = versionInfo(payload);
  const header = 2 + pathBytes.length + 28 + info.length;
  const buf = new Uint8Array(header + payload.content.length);
  const view = new DataView(buf.buffer);
  view.setUint16(0, pathBytes.length, false);
  buf.set(pathBytes, 2);
  view.setFloat64(2 + pathBytes.length, payload.mtime, false);
  view.setFloat64(2 + pathBytes.length + 8, payload.totalSize, false);
  view.setFloat64(2 + pathBytes.length + 16, payload.offset, false);
  view.setUint32(2 + pathBytes.length + 24, info.length, false);
  buf.set(info, 2 + pathBytes.length + 28);
  buf.set(payload.content, header);
  return encodeMessage(MessageType.FILE_CHUNK, buf);
}

export function decodeFileChunk(payload: Uint8Array): FileChunkPayload {
  if (payload.byteLength < 2) {
    throw new Error('Malformed chunk payload: missing path length');
  }
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const pathLen = view.getUint16(0, false);
  if (payload.byteLength < 2 + pathLen + 28) {
    throw new Error('Malformed chunk payload: truncated metadata');
  }
  const infoLen = view.getUint32(2 + pathLen + 24, false);
  const header = 2 + pathLen + 28 + infoLen;
  if (payload.byteLength < header) {
    throw new Error('Malformed chunk payload: truncated metadata');
  }
  return {
    path: decoder.decode(payload.slice(2, 2 + pathLen)),
    mtime: view.getFloat64(2 + pathLen, false),
    totalSize: view.getFloat64(2 + pathLen + 8, false),
    offset: view.getFloat64(2 + pathLen + 16, false),
    ...readVersionInfo(payload.slice(2 + pathLen + 28, header)),
    content: payload.slice(header),
  };
}

export function encodeFileDelete(payload: FileDeletePayload): Uint8Array {
  return encodeMessage(MessageType.FILE_DELETE, encodeJSON(payload));
}

export function encodeFileRename(payload: FileRenamePayload): Uint8Array {
  return encodeMessage(MessageType.FILE_RENAME, encodeJSON(payload));
}

export function encodeFolderOp(
  type: MessageType.FOLDER_CREATE | MessageType.FOLDER_DELETE,
  path: string,
): Uint8Array {
  return encodeMessage(type, encodeJSON({ path }));
}

// ─── Ping / Pong ─────────────────────────────────────────

/** PING carries the sender's clock (protocol 3), to estimate clock skew. */
export function encodePing(now: number = Date.now()): Uint8Array {
  const buf = new Uint8Array(8);
  new DataView(buf.buffer).setFloat64(0, now, false);
  return encodeMessage(MessageType.PING, buf);
}

/** PONG echoes the ping's time and adds the answering device's clock. */
export function encodePong(pingTime = 0, now: number = Date.now()): Uint8Array {
  const buf = new Uint8Array(16);
  const view = new DataView(buf.buffer);
  view.setFloat64(0, pingTime, false);
  view.setFloat64(8, now, false);
  return encodeMessage(MessageType.PONG, buf);
}

export function decodePing(payload: Uint8Array): number | null {
  if (payload.byteLength < 8) return null;
  return new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getFloat64(0, false);
}

export function decodePong(payload: Uint8Array): { pingTime: number; peerTime: number } | null {
  if (payload.byteLength < 16) return null;
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  return { pingTime: view.getFloat64(0, false), peerTime: view.getFloat64(8, false) };
}
