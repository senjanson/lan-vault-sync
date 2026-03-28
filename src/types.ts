import { App } from 'obsidian';

// ─── Settings ────────────────────────────────────────────
export interface LANSyncSettings {
  enabled: boolean;
  deviceName: string;
  deviceId: string;
  port: number;
  autoSync: boolean;
  syncIntervalMs: number;
  ignoredPaths: string[];
  conflictStrategy: 'crdt-auto' | 'last-write-wins' | 'keep-both';
  manualPeers: string[];       // "ip:port" list
  enableDebugLog: boolean;
}

export const DEFAULT_SETTINGS: LANSyncSettings = {
  enabled: true,
  deviceName: '',
  deviceId: '',
  port: 53712,
  autoSync: true,
  syncIntervalMs: 30000,
  ignoredPaths: ['.obsidian/', '.trash/'],
  conflictStrategy: 'crdt-auto',
  manualPeers: [],
  enableDebugLog: false,
};

// ─── Device ──────────────────────────────────────────────
export interface DeviceInfo {
  deviceId: string;
  deviceName: string;
  ip: string;
  port: number;
  vaultId: string;
  lastSeen: number;
}

// ─── File events ─────────────────────────────────────────
export interface FileChangeEvent {
  type: 'create' | 'modify' | 'delete' | 'rename';
  path: string;
  oldPath?: string;
  isTextFile: boolean;
  timestamp: number;
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
  | 'idle'
  | 'discovering'
  | 'connecting'
  | 'initial-sync'
  | 'watching'
  | 'error';

// ─── Protocol messages ───────────────────────────────────
export enum MessageType {
  HANDSHAKE       = 0x00,
  HANDSHAKE_ACK   = 0x01,

  YJS_SYNC_STEP1  = 0x10,
  YJS_SYNC_STEP2  = 0x11,
  YJS_UPDATE      = 0x12,

  FILE_META_SYNC  = 0x20,
  FILE_REQUEST    = 0x21,
  FILE_DATA       = 0x22,
  FILE_DELETE     = 0x23,
  FILE_RENAME     = 0x24,

  PING            = 0xF0,
  PONG            = 0xF1,
}

export interface HandshakePayload {
  deviceId: string;
  deviceName: string;
  vaultId: string;
  port: number;
}

export interface YjsSyncMessage {
  filePath: string;
  data: Uint8Array;
}

export interface FileMetaSyncPayload {
  files: FileMeta[];
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

// ─── Logger helper ─── (accessible everywhere via app)
export interface SyncLogger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}
