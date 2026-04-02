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

  YJS_SYNC_STEP1 = 0x10,
  YJS_SYNC_STEP2 = 0x11,
  YJS_UPDATE = 0x12,

  FILE_META_SYNC = 0x20,
  FILE_REQUEST = 0x21,
  FILE_DATA = 0x22,
  FILE_DELETE = 0x23,
  FILE_RENAME = 0x24,

  PING = 0xf0,
  PONG = 0xf1,
}

export interface HandshakePayload {
  deviceId: string;
  deviceName: string;
  vaultId: string;
  port: number;
  acceptsIncomingConnections?: boolean;
}

export interface YjsSyncMessage {
  filePath: string;
  data: Uint8Array;
}

export interface FileMetaSyncPayload {
  files: FileMeta[];
  /** When true this is a response to a received FILE_META_SYNC — the receiver
   *  should NOT echo yet another FILE_META_SYNC back to avoid ping-pong. */
  isResponse?: boolean;
}

export interface FileDataPayload {
  path: string;
  content: Uint8Array;
  mtime: number;
}

export interface FileDeletePayload {
  path: string;
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
