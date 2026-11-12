import { App } from "obsidian";

// ─── Settings ────────────────────────────────────────────
export interface LANSyncSettings {
  enabled: boolean;
  deviceName: string;
  deviceId: string;
  port: number;
  autoSync: boolean;
  syncIntervalMs: number;
  ignoredPaths: string[];
  conflictStrategy: "crdt-auto" | "last-write-wins" | "keep-both";
  manualPeers: string[]; // "ip:port" list
  /** Shared pairing key; only devices with the same key can connect. */
  syncKey: string;
  enableDebugLog: boolean;
  enableSyncLog: boolean;
  maxSyncLogEntries: number;
}

export const DEFAULT_SETTINGS: LANSyncSettings = {
  enabled: true,
  deviceName: "",
  deviceId: "",
  port: 0, // 0 = not yet assigned; will be randomised in onload()
  autoSync: true,
  syncIntervalMs: 30000,
  ignoredPaths: [".obsidian/", ".trash/"],
  conflictStrategy: "crdt-auto",
  manualPeers: [],
  syncKey: "",
  enableDebugLog: false,
  enableSyncLog: true,
  maxSyncLogEntries: 500,
};

// ─── Device ──────────────────────────────────────────────
export interface DeviceInfo {
  deviceId: string;
  deviceName: string;
  ip: string;
  port: number;
  vaultId: string;
  lastSeen: number;
  acceptsIncomingConnections?: boolean;
}

// ─── File events ─────────────────────────────────────────
export interface FolderChangeEvent {
  type: "create" | "delete" | "rename";
  path: string;
  oldPath?: string;
}

export interface FileChangeEvent {
  type: "create" | "modify" | "delete" | "rename";
  path: string;
  oldPath?: string;
  isTextFile: boolean;
  timestamp: number;
  content?: string;
  source?: "vault" | "editor";
}

// ─── File metadata for tree sync ─────────────────────────
export interface FileMeta {
  path: string;
  hash: string;
  mtime: number;
  size: number;
  isTextFile: boolean;
  /** Fingerprint of a note's CRDT history, if it has one (protocol 2). */
  crdt?: string;
}

// ─── Sync state ──────────────────────────────────────────
export type SyncState =
  | "idle"
  | "discovering"
  | "connecting"
  | "initial-sync"
  | "watching"
  | "error";

// ─── Protocol messages ───────────────────────────────────
export enum MessageType {
  HANDSHAKE = 0x00,
  HANDSHAKE_ACK = 0x01,
  /** Connecting side's proof that it knows the sync key. */
  AUTH = 0x02,

  YJS_SYNC_STEP1 = 0x10,
  YJS_SYNC_STEP2 = 0x11,
  YJS_UPDATE = 0x12,
  /** A doc's complete state (not an incremental update). */
  YJS_FULL_STATE = 0x13,

  FILE_META_SYNC = 0x20,
  FILE_REQUEST = 0x21,
  FILE_DATA = 0x22,
  FILE_DELETE = 0x23,
  FILE_RENAME = 0x24,
  FILE_CHUNK = 0x25,
  /** A folder was created (payload: FileDeletePayload-shaped JSON). */
  FOLDER_CREATE = 0x26,
  /** A folder was deleted; peers remove it once it holds no files. */
  FOLDER_DELETE = 0x27,

  PING = 0xf0,
  PONG = 0xf1,
}

export interface HandshakePayload {
  deviceId: string;
  deviceName: string;
  vaultId: string;
  port: number;
  acceptsIncomingConnections?: boolean;
  /** Random challenge for the other side to sign. */
  nonce?: string;
  /** HMAC over the other side's nonce (handshake ack only). */
  proof?: string;
  /** Sync protocol version; plugin 0.3 and older send none (version 1). */
  protocolVersion?: number;
}

export interface AuthPayload {
  proof: string;
}

export interface YjsSyncMessage {
  filePath: string;
  data: Uint8Array;
}

/** A file this device deleted or renamed away. */
export interface Tombstone {
  path: string;
  deletedAt: number;
  /** Hash of the content that was deleted, when known. */
  hash?: string;
  /** Set when the file was renamed or moved: its new path. */
  movedTo?: string;
}

export interface FileMetaSyncPayload {
  files: FileMeta[];
  /** All folders of the sender's vault; older versions leave this out. */
  folders?: string[];
  /** Files the sender deleted; older versions leave this out. */
  deleted?: Tombstone[];
  /** When true this is a response to a received FILE_META_SYNC — the receiver
   *  should NOT echo yet another FILE_META_SYNC back to avoid ping-pong. */
  isResponse?: boolean;
}

export interface FileDataPayload {
  path: string;
  content: Uint8Array;
  mtime: number;
}

export interface FileChunkPayload {
  path: string;
  mtime: number;
  /** Size of the whole file in bytes. */
  totalSize: number;
  /** Byte offset of this chunk within the file. */
  offset: number;
  content: Uint8Array;
}

export interface FileDeletePayload {
  path: string;
  /** Delete only a copy with this content hash; other versions are kept. */
  hash?: string;
  /** The file was renamed to this path; the deletion only follows that. */
  movedTo?: string;
}

export interface FileRenamePayload {
  oldPath: string;
  newPath: string;
}

// ─── Sync Log ────────────────────────────────────────────
export type SyncLogEntryType =
  | "remote-overwrite"
  | "remote-delete"
  | "local-send"
  | "initial-sync-receive"
  | "conflict-backup";

export interface SyncLogEntry {
  id: string;
  timestamp: number;
  type: SyncLogEntryType;
  path: string;
  deviceName?: string;
  snapshotId?: string;
  hasSnapshot: boolean;
  details?: {
    fileSize?: number;
    isText?: boolean;
    reason?: string;
  };
}

// ─── Logger helper ─── (accessible everywhere via app)
export interface SyncLogger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}
