import { App } from "obsidian";
import { canUseNodeRuntime } from "./utils/runtime";
import { PHONE_MAX_RECEIVE_MB } from "./constants";

// ─── Settings ────────────────────────────────────────────
export interface LANSyncSettings {
  enabled: boolean;
  deviceName: string;
  deviceId: string;
  port: number;
  autoSync: boolean;
  syncIntervalMs: number;
  ignoredPaths: string[];
  manualPeers: string[]; // "ip:port" list
  /** Shared pairing key; only devices with the same key can connect. */
  syncKey: string;
  /**
   * Which vault this is, shared by pairing (plan 6.3). Empty on installs
   * from before 0.5: the vault's folder name stands in for it, as it did.
   */
  vaultId: string;
  enableDebugLog: boolean;
  enableSyncLog: boolean;
  maxSyncLogEntries: number;
  /** Days old versions are kept in the version history (.lan-vault-sync/history). */
  historyKeepDays: number;
  /** Space the version history may take on a phone, in MB; 0 for no limit. */
  historyMaxMB: number;
  /** Largest file taken from a peer, in MB; 0 for no limit. */
  maxReceiveMB: number;
}

export const DEFAULT_SETTINGS: LANSyncSettings = {
  enabled: true,
  deviceName: "",
  deviceId: "",
  port: 0, // 0 = not yet assigned; will be randomised in onload()
  autoSync: true,
  syncIntervalMs: 30000,
  ignoredPaths: [".obsidian/", ".trash/"],
  manualPeers: [],
  syncKey: "",
  vaultId: "",
  enableDebugLog: false,
  enableSyncLog: true,
  maxSyncLogEntries: 500,
  historyKeepDays: 30,
  historyMaxMB: 500,
  // A phone may not have room for a large file (or the memory to receive it
  // where its storage cannot append); a desktop takes any size.
  maxReceiveMB: canUseNodeRuntime() ? 0 : PHONE_MAX_RECEIVE_MB,
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
  /** Random for each run of the plugin: tells two devices with one device ID apart. */
  instance?: string;
  /** Largest file the device takes, in bytes; 0 or none for no limit. */
  maxReceiveBytes?: number;
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
  /** The file was also saved to disk while this (editor) change waited. */
  savedToDisk?: boolean;
  /**
   * Rename events only: the file was changed under its old name just before,
   * and that change was still waiting (`content` holds an editor's text).
   */
  editedBeforeRename?: boolean;
  /**
   * A second read of a file whose change matched an earlier remote write
   * (see SyncCoordinator._recheckEcho): only the newest write is ours now.
   */
  recheck?: boolean;
}

// ─── File metadata for tree sync ─────────────────────────
export interface FileMeta {
  path: string;
  hash: string;
  mtime: number;
  size: number;
  /**
   * Synced through a CRDT doc: a text file whose bytes are plain UTF-8. Other
   * files, text ones included, are synced as bytes.
   */
  isTextFile: boolean;
  /** Fingerprint of a note's CRDT history, if it has one (protocol 2). */
  crdt?: string;
  /**
   * The file was put back after this deletion; peers drop their record of
   * it. Older versions leave this out.
   */
  revives?: { deletedAt: number; hash?: string };
  /**
   * Hash of the note's content when this device last saw the receiving peer
   * list it with the very same content: the version those two last had in
   * common. Each peer is sent its own. Lets two devices whose histories no
   * longer match tell a note changed on one side only from one changed on
   * both. Older versions leave this out.
   */
  agreed?: string;
  /**
   * Notes: when this version (this content) was made, as early as known:
   * the file's modified time, or an earlier time a peer listing the same
   * content gave. A device that received the version learns the time of
   * the one that made it at their next list exchange, so all devices that
   * have the version give the same time, and weigh it alike against
   * another version. Older versions leave this out.
   */
  madeAt?: number;
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
  /** See DeviceInfo.instance. */
  instance?: string;
  /** See DeviceInfo.maxReceiveBytes; so that a peer does not send what we would refuse. */
  maxReceiveBytes?: number;
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
  /**
   * The device that made the deletion, as "deviceId (name)", when it was
   * not the device that holds this record: kept as the record is passed on,
   * so that a held deletion names who deleted the files.
   */
  by?: string;
}

/** A file put back after it was deleted; see TombstoneStore.revive. */
export interface Revival {
  path: string;
  /** When the deletion it undoes was made (that deletion's deletedAt). */
  deletedAt: number;
  /** Hash of the content that was deleted, when known. */
  hash?: string;
}

export interface FileMetaSyncPayload {
  files: FileMeta[];
  /** All folders of the sender's vault; older versions leave this out. */
  folders?: string[];
  /** Files the sender deleted; older versions leave this out. */
  deleted?: Tombstone[];
  /** Digest of the sender's file list (see vaultDigest); protocol 3. */
  digest?: string;
  /** When true this is a response to a received FILE_META_SYNC — the receiver
   *  should NOT echo yet another FILE_META_SYNC back to avoid ping-pong. */
  isResponse?: boolean;
}

/** What a file's sender says about the version it sends (protocol 3). */
export interface FileVersionInfo {
  /** Hash of the whole file, checked once it has all arrived. */
  hash?: string;
  /**
   * The version the sender believes the receiver has now (the one this
   * replaces). A receiver holding another version has changed the file too.
   */
  base?: string;
  /** When this version was made, as for notes (see FileMeta.madeAt). */
  madeAt?: number;
}

export interface FileDataPayload extends FileVersionInfo {
  path: string;
  content: Uint8Array;
  mtime: number;
}

export interface FileChunkPayload extends FileVersionInfo {
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
  /**
   * When the deletion was made, by the clock of the device that made it.
   * Recorded as it is, so every device's record of one deletion carries the
   * same time. Older versions leave this out.
   */
  deletedAt?: number;
  /**
   * How the sender learned of the deletion: "event" when the file was
   * deleted in Obsidian, "inferred" when it was found missing after sync was
   * off (see SyncCoordinator._wasDeletedWhileStopped).
   */
  source?: "event" | "inferred";
  /**
   * For a note: the sender's CRDT state vector (base64) when it deleted the
   * note. A receiver whose note holds edits beyond it keeps the note.
   */
  sv?: string;
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
