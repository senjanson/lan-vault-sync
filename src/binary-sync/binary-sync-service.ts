import { Vault, TFile } from "obsidian";
import { ConnectionManager } from "../transport/connection-manager";
import { ConflictBackupService } from "../conflict/conflict-backup-service";
import {
  decodeFileChunk,
  encodeFileChunk,
  encodeFileData,
  encodeFileDelete,
  encodeFileRename,
  encodeFileRequest,
  decodeFileData,
  decodeFileRequest,
  decodeJSON,
} from "../transport/protocol";
import { ApplyGate, BackupKeeper, OpContext } from "../sync/apply-gate";
import { EventLog } from "../diagnostics/event-log";
import {
  FileVersionInfo,
  FileDeletePayload,
  FileRenamePayload,
  FileMeta,
  Tombstone,
  MessageType,
} from "../types";
import { computeFileHash } from "./file-hash";
import { isPlainUtf8 } from "../utils/utf8";
import { logger } from "../logger";
import {
  CHUNK_SIZE,
  CHUNKED_FILE_THRESHOLD,
  INCOMING_DIR,
  MAX_SYNC_FILE_SIZE,
} from "../constants";
import { ensureVaultParentFolder, isCaseVariant, isSafeSyncPath } from "../utils/path-utils";

interface IncomingFile extends FileVersionInfo {
  path: string;
  mtime: number;
  totalSize: number;
  received: number;
  /** Temporary file the chunks are written to (see INCOMING_DIR); null when they are kept in `data`. */
  tempPath: string | null;
  data: Uint8Array | null;
}

/** The part of Obsidian's DataAdapter that receiving into a temporary file needs. */
interface TempAdapter {
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  writeBinary(path: string, data: ArrayBuffer): Promise<void>;
  appendBinary(path: string, data: ArrayBuffer): Promise<void>;
  readBinary(path: string): Promise<ArrayBuffer>;
  remove(path: string): Promise<void>;
  list?(path: string): Promise<{ files: string[]; folders: string[] }>;
}

/** What is sent for one version of a file. */
interface OutgoingFile {
  content: Uint8Array;
  mtime: number;
  info: FileVersionInfo;
}

export class BinaryFileSyncService {
  /** Chunked files being received, keyed by `${deviceId}\n${path}`. */
  private incoming = new Map<string, IncomingFile>();
  /** Temporary files left by an earlier run are removed before new ones are made. */
  private incomingCleaned: Promise<void>;
  private tempSeq = 0;
  /** Files refused as too large, by path and hash, so each is logged once. */
  private refusedLarge = new Set<string>();
  /**
   * Large files to each peer go one after another, each read when its turn
   * comes, so several are not held in memory at once.
   */
  private outgoing = new Map<string, Promise<void>>();
  /** Large transfers queued or running, by `${deviceId}\n${path}`; see _sendMessage. */
  private outgoingPaths = new Map<string, number>();
  /** Goes up when a peer disconnects, so transfers queued for it are dropped. */
  private outgoingEpoch = new Map<string, number>();
  /** Deletions being applied, by path; see _deleteFile. */
  private deleting = new Map<string, Promise<boolean>>();
  private isDeletedCb: ((path: string, hash: string) => boolean) | null = null;
  private holdsOtherContentCb:
    | ((path: string, hash: string) => Promise<boolean>)
    | null = null;
  private canCreateCb: ((path: string) => Promise<boolean>) | null = null;
  private onRemoteFileStoredCb:
    | ((path: string, hash: string, content: Uint8Array, fromDeviceId?: string, info?: FileVersionInfo) => void | Promise<void>)
    | null = null;
  private isOwnVersionCb: ((path: string, hash: string) => boolean) | null = null;
  private isOlderCopyCb: ((deviceId: string, path: string, hash: string) => boolean) | null = null;
  private onRemoteFileWrittenCb:
    | ((path: string, kind?: "write" | "delete" | "rename", content?: Uint8Array) => void)
    | null = null;
  private onRemoteFileDeletedCb:
    | ((path: string, movedTo?: string, record?: Tombstone, by?: string) => Promise<void> | void)
    | null = null;
  private onRemoteFileRenamedCb:
    | ((oldPath: string, newPath: string) => Promise<void> | void)
    | null = null;
  private onRemoteFolderMadeCb: ((path: string) => void) | null = null;
  private onBackupCreatedCb:
    | ((path: string, backupId: string, reason: string) => void)
    | null = null;

  /** Steps that replace or remove content go through here (see ApplyGate). */
  private gate: ApplyGate;
  /**
   * Files asked of a peer, by path: the hash the file had here when it was
   * decided to take the peer's version (null: it was not here). The peer's
   * version only replaces that one.
   */
  private expected = new Map<string, { hash: string | null; at: number; from?: string }>();
  private static readonly EXPECT_FOR_MS = 10 * 60 * 1000;
  private admitDeleteCb: ((deviceId: string, del: FileDeletePayload) => boolean) | null = null;
  private notePreconditionCb:
    | ((path: string, del: FileDeletePayload, diskHash: string) => Promise<boolean | undefined>)
    | null = null;
  private peerLabelCb: (deviceId: string) => string | undefined = (id) => id;

  constructor(
    private vault: Vault,
    private connectionManager: ConnectionManager,
    private backupService: ConflictBackupService,
    private isAllowedPath: (path: string) => boolean = isSafeSyncPath,
    private isTextPath: (path: string) => boolean = () => false,
  ) {
    // Replaced by the coordinator's gate (setGate), which has the trash.
    this.gate = new ApplyGate({
      vault,
      keeper: new BackupKeeper(backupService),
      log: new EventLog(null),
      trash: () => Promise.reject(new Error("No trash to delete into: setGate was not called")),
    });
    this.incomingCleaned = this._cleanIncoming();
  }

  setGate(gate: ApplyGate): void {
    this.gate = gate;
  }

  setPeerLabel(cb: (deviceId: string) => string | undefined): void {
    this.peerLabelCb = cb;
  }

  /**
   * Asked before a peer's deletion is applied; false holds it (the caller
   * keeps it, to apply with applyHeldDelete or drop).
   */
  setDeleteAdmission(cb: (deviceId: string, del: FileDeletePayload) => boolean): void {
    this.admitDeleteCb = cb;
  }

  /**
   * Decides whether a peer's deletion of a note may delete our copy (see
   * SyncCoordinator); undefined falls back to comparing hashes.
   */
  setNoteDeletePrecondition(
    cb: (path: string, del: FileDeletePayload, diskHash: string) => Promise<boolean | undefined>,
  ): void {
    this.notePreconditionCb = cb;
  }

  /** Called with the content hash once a peer's file has been written. */
  /** Tells whether this exact file (path and hash) was deleted here. */
  setDeletedCheck(cb: (path: string, hash: string) => boolean): void {
    this.isDeletedCb = cb;
  }

  /**
   * Tells whether the file holds more than the given content beyond what is
   * on disk, e.g. a note's text that was merged but not written yet.
   */
  setHoldsOtherContent(cb: (path: string, hash: string) => Promise<boolean>): void {
    this.holdsOtherContentCb = cb;
  }

  /** Tells whether a peer's new file may be created at this path here. */
  setCanCreate(cb: (path: string) => Promise<boolean>): void {
    this.canCreateCb = cb;
  }

  /**
   * Tells whether this version of a file here is one no peer is known to
   * have (made or changed on this device); see _receiveFileNow.
   */
  setOwnVersionCheck(cb: (path: string, hash: string) => boolean): void {
    this.isOwnVersionCb = cb;
  }

  /**
   * Tells whether our copy (this hash) is an older version of a file the
   * peer deleted or moved: one it had before, unchanged here since. Such a
   * copy goes with the file; see applyIncomingDelete.
   */
  setOlderCopyCheck(cb: (deviceId: string, path: string, hash: string) => boolean): void {
    this.isOlderCopyCb = cb;
  }

  /** Called once a peer's file is in place here, with its bytes. */
  onRemoteFileStored(
    cb: (path: string, hash: string, content: Uint8Array, fromDeviceId?: string, info?: FileVersionInfo) => void | Promise<void>,
  ): void {
    this.onRemoteFileStoredCb = cb;
  }

  /** Called before a peer's change is made to a file; `content` for writes. */
  onRemoteFileWritten(
    cb: (path: string, kind?: "write" | "delete" | "rename", content?: Uint8Array) => void,
  ): void {
    this.onRemoteFileWrittenCb = cb;
  }

  /**
   * Called before a folder is made to hold a file a peer sent or moved;
   * see ensureVaultParentFolder.
   */
  onRemoteFolderMade(cb: (path: string) => void): void {
    this.onRemoteFolderMadeCb = cb;
  }

  /** `by`: the device that made the deletion, as "deviceId (name)". */
  onRemoteFileDeleted(cb: (path: string, movedTo?: string, record?: Tombstone, by?: string) => Promise<void> | void): void {
    this.onRemoteFileDeletedCb = cb;
  }

  onRemoteFileRenamed(
    cb: (oldPath: string, newPath: string) => Promise<void> | void,
  ): void {
    this.onRemoteFileRenamedCb = cb;
  }

  onBackupCreated(
    cb: (path: string, backupId: string, reason: string) => void,
  ): void {
    this.onBackupCreatedCb = cb;
  }

  /** Handle incoming protocol messages for binary file operations */
  async handleMessage(
    deviceId: string,
    type: MessageType,
    payload: Uint8Array,
  ): Promise<void> {
    switch (type) {
      case MessageType.FILE_REQUEST: {
        const path = decodeFileRequest(payload);
        if (!this.isAllowedPath(path)) break;
        await this._sendFile(deviceId, path);
        break;
      }
      case MessageType.FILE_DATA: {
        const data = decodeFileData(payload);
        if (!this.isAllowedPath(data.path)) break;
        if (this._refuseTooLarge(deviceId, data.path, data.content.byteLength, data.hash)) break;
        await this._receiveFile(data.path, data.content, data.mtime, deviceId, data);
        break;
      }
      case MessageType.FILE_CHUNK: {
        const chunk = decodeFileChunk(payload);
        if (!this.isAllowedPath(chunk.path)) break;
        await this._receiveChunk(deviceId, chunk);
        break;
      }
      case MessageType.FILE_DELETE: {
        const del = decodeJSON<FileDeletePayload>(payload);
        if (!this.isAllowedPath(del.path)) break;
        await this.applyIncomingDelete(deviceId, del);
        break;
      }
      case MessageType.FILE_RENAME: {
        const ren = decodeJSON<FileRenamePayload>(payload);
        if (!this.isAllowedPath(ren.oldPath) || !this.isAllowedPath(ren.newPath))
          break;
        await this._renameFile(ren.oldPath, ren.newPath, { peer: this.peerLabelCb(deviceId), rule: "live-rename" });
        break;
      }
    }
  }

  /**
   * Send a file create/update to all peers. `base` is the version peers are
   * thought to have (the one this change replaces). Returns the new hash.
   */
  async broadcastFileChange(path: string, base?: string, madeAt?: number, unlessBase = false): Promise<string | undefined> {
    const file = this.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return undefined;

    const content = new Uint8Array(await this.vault.readBinary(file));
    const hash = await computeFileHash(toExactArrayBuffer(content));
    // `unlessBase`: the file is still the version peers have (e.g. a peer's
    // version this device just wrote, seen by its modify event); nothing
    // is sent, and undefined returned.
    if (unlessBase && base === hash) return undefined;
    const info: FileVersionInfo = { hash, madeAt: madeAt ?? file.stat.mtime };
    if (base && base !== hash) info.base = base;
    const out: OutgoingFile = { content, mtime: file.stat.mtime, info };
    if (content.byteLength > CHUNKED_FILE_THRESHOLD) {
      // One copy of the content is shared by the transfers to every peer.
      for (const deviceId of this.connectionManager.getConnectedPeerIds()) {
        if (!this._peerTakes(deviceId, path)) continue;
        if (this._overPeerLimit(deviceId, content.byteLength)) continue;
        this._queueTransfer(deviceId, path, async () => out);
      }
      return hash;
    }
    const msg = encodeFileData({ path, content, mtime: file.stat.mtime, ...info });
    const peers = this.connectionManager.getConnectedPeerIds?.() ?? [];
    if (peers.some((id) => this.outgoingPaths.has(`${id}\n${path}`))) {
      for (const deviceId of peers) this._sendMessage(deviceId, path, msg);
    } else {
      this.connectionManager.broadcast(msg);
    }
    return hash;
  }

  /** Send a file deletion to all peers: when it was made and what was deleted. */
  broadcastFileDelete(path: string, deletedAt?: number, info: Partial<FileDeletePayload> = {}): void {
    const payload: FileDeletePayload = { path, ...info };
    if (deletedAt !== undefined) payload.deletedAt = deletedAt;
    const msg = encodeFileDelete(payload);
    this.connectionManager.broadcast(msg);
  }

  /** Send a file rename to all peers */
  broadcastFileRename(oldPath: string, newPath: string): void {
    const msg = encodeFileRename({ oldPath, newPath });
    this.connectionManager.broadcast(msg);
  }

  /**
   * Request a file from a specific peer. `expectHash` is the hash of our
   * copy when the peer's version was chosen (null: we have none): the peer's
   * version replaces only that (see _receiveFile).
   */
  requestFile(deviceId: string, path: string, expectHash?: string | null, listed?: { size: number; hash: string }): void {
    // A file over the receive limit is not asked for: it would be sent whole
    // and thrown away, at every round.
    if (listed && this._refuseTooLarge(deviceId, path, listed.size, listed.hash)) return;
    if (expectHash !== undefined) this.expected.set(path, { hash: expectHash, at: Date.now(), from: deviceId });
    const msg = encodeFileRequest(path);
    this.connectionManager.sendTo(deviceId, msg);
  }

  /** Files asked of this peer that have not arrived yet. */
  waitingFrom(deviceId: string): number {
    const now = Date.now();
    let n = 0;
    for (const e of this.expected.values()) {
      if (e.from === deviceId && now - e.at < BinaryFileSyncService.EXPECT_FOR_MS) n++;
    }
    return n;
  }

  /** Send a file to a specific peer (not broadcast) */
  /**
   * Sends our file to one peer. `base` is the version the peer is thought to
   * have, so it replaces only that; `madeAt` is when this version was made,
   * when known better than the file's modified time.
   */
  async sendFileToPeer(deviceId: string, path: string, opts: { base?: string; madeAt?: number } = {}): Promise<void> {
    const file = this.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return;

    // Outside the folder the peer (or this device) syncs: not read, not sent.
    if (!this._peerTakes(deviceId, path)) return;
    // The peer said it would refuse a file this large: it is not sent.
    if (this._overPeerLimit(deviceId, file.stat.size)) return;
    if (file.stat.size > CHUNKED_FILE_THRESHOLD) {
      // Read when its turn comes (see _queueTransfer); `madeAt` belongs to
      // the version seen now, so it is dropped if the file changes before.
      const seenMtime = file.stat.mtime;
      this._queueTransfer(deviceId, path, () => this._readOutgoing(path, opts, seenMtime));
      return;
    }
    const out = await this._readOutgoing(path, opts);
    if (!out) return;
    if (out.content.byteLength > CHUNKED_FILE_THRESHOLD) {
      this._queueTransfer(deviceId, path, async () => out);
      return;
    }
    this._sendMessage(deviceId, path, encodeFileData({ path, content: out.content, mtime: out.mtime, ...out.info }));
  }

  /**
   * Whether a path lies in what the connection with this peer carries (see
   * ConnectionManager.peerAccepts). The connection drops anything else as
   * well; checking here first spares reading a file that would not go.
   */
  private _peerTakes(deviceId: string, path: string): boolean {
    return this.connectionManager.peerAccepts?.(deviceId, path) ?? true;
  }

  /** Whether a peer said it takes no file of this size (see maxReceiveMB). */
  private _overPeerLimit(deviceId: string, size: number): boolean {
    const limit = this.connectionManager.peerReceiveLimit?.(deviceId) ?? 0;
    return limit > 0 && size > limit;
  }

  /** Resolves once every queued large transfer has finished (tests). */
  async outgoingIdle(): Promise<void> {
    while (this.outgoing.size > 0) {
      await Promise.all([...this.outgoing.values()]);
    }
  }

  /** Build metadata list of all non-text files in the vault */
  async buildBinaryFileList(): Promise<FileMeta[]> {
    const files = this.vault.getFiles();
    const result: FileMeta[] = [];

    for (const file of files) {
      const data = await this.vault.readBinary(file);
      const hash = await computeFileHash(data);
      result.push({
        path: file.path,
        hash,
        mtime: file.stat.mtime,
        size: file.stat.size,
        isTextFile: false,
      });
    }

    return result;
  }

  // ─── Private ────────────────────────────────────────────

  private async _sendFile(deviceId: string, path: string): Promise<void> {
    const file = this.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      logger.warn(`Requested file not found: ${path}`);
      return;
    }
    // A large file is queued, not awaited: this runs in the peer's message
    // queue, which must not wait the minutes a large transfer can take.
    await this.sendFileToPeer(deviceId, path);
  }

  /**
   * Drop partially received files from a peer that went away, with their
   * temporary files, and the large transfers still queued for it.
   */
  dropIncoming(deviceId: string): void {
    for (const [key, entry] of this.incoming) {
      if (!key.startsWith(`${deviceId}\n`)) continue;
      this.incoming.delete(key);
      if (entry.tempPath) void this._removeTemp(entry.tempPath);
    }
    if (this.outgoing.has(deviceId)) {
      this.outgoingEpoch.set(deviceId, (this.outgoingEpoch.get(deviceId) ?? 0) + 1);
    }
  }

  private async _readOutgoing(
    path: string,
    opts: { base?: string; madeAt?: number },
    seenMtime?: number,
  ): Promise<OutgoingFile | null> {
    const file = this.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return null;
    let content: Uint8Array;
    try {
      content = new Uint8Array(await this.vault.readBinary(file));
    } catch (err) {
      // Renamed or deleted while it was read, e.g. for another peer whose
      // messages are handled alongside: nothing to send under this name.
      // Thrown, it ended the whole file list exchange that sent it.
      if (this.vault.getAbstractFileByPath(path) !== file) return null;
      throw err;
    }
    const hash = await computeFileHash(toExactArrayBuffer(content));
    const madeAt = seenMtime === undefined || seenMtime === file.stat.mtime ? opts.madeAt : undefined;
    const info: FileVersionInfo = { hash, madeAt: madeAt ?? file.stat.mtime };
    if (opts.base) info.base = opts.base;
    return { content, mtime: file.stat.mtime, info };
  }

  /**
   * Send one message about a file. While a large transfer of the same file
   * to this peer is queued or running, the message waits behind it, so an
   * older version cannot arrive after a newer one.
   */
  private _sendMessage(deviceId: string, path: string, msg: Uint8Array): void {
    if (this.outgoingPaths.has(`${deviceId}\n${path}`)) {
      void this._enqueue(deviceId, path, async () => this.connectionManager.sendTo(deviceId, msg));
    } else {
      this.connectionManager.sendTo(deviceId, msg);
    }
  }

  /**
   * Send a large file as FILE_CHUNK messages (a single message over ~100 MiB
   * is refused by the ws library and closes the connection). The chunks go
   * out paced by what the connection still has to send (see
   * ConnectionManager.sendToPaced), each built only when it can go.
   */
  private _queueTransfer(deviceId: string, path: string, load: () => Promise<OutgoingFile | null>): void {
    const epoch = this.outgoingEpoch.get(deviceId) ?? 0;
    void this._enqueue(deviceId, path, async () => {
      if ((this.outgoingEpoch.get(deviceId) ?? 0) !== epoch || !this.connectionManager.isConnectedTo(deviceId)) return;
      const out = await load();
      if (!out) return;
      const sent = await this.connectionManager.sendToPaced(deviceId, this._chunkFrames(path, out));
      if (!sent) logger.info(`Stopped sending ${path} to ${deviceId}: the peer disconnected`);
    });
  }

  private _enqueue(deviceId: string, path: string, task: () => Promise<void>): Promise<void> {
    const key = `${deviceId}\n${path}`;
    this.outgoingPaths.set(key, (this.outgoingPaths.get(key) ?? 0) + 1);
    const run = (this.outgoing.get(deviceId) ?? Promise.resolve())
      .then(task)
      .catch((err) => logger.error(`Failed to send ${path} to ${deviceId}:`, err))
      .finally(() => {
        const left = (this.outgoingPaths.get(key) ?? 1) - 1;
        if (left > 0) this.outgoingPaths.set(key, left);
        else this.outgoingPaths.delete(key);
        if (this.outgoing.get(deviceId) === run) this.outgoing.delete(deviceId);
      });
    this.outgoing.set(deviceId, run);
    return run;
  }

  private *_chunkFrames(path: string, out: OutgoingFile): Generator<Uint8Array> {
    const { content, mtime, info } = out;
    for (let offset = 0; offset < content.byteLength; offset += CHUNK_SIZE) {
      yield encodeFileChunk({
        path,
        mtime,
        totalSize: content.byteLength,
        offset,
        content: content.subarray(offset, offset + CHUNK_SIZE),
        ...(offset === 0 ? info : {}),
      });
    }
  }

  /**
   * Refuse a file over this device's receive limit (maxReceiveMB), before
   * any of it is kept. Logged once per version of the file.
   */
  private _refuseTooLarge(deviceId: string, path: string, size: number, hash?: string): boolean {
    const limit = this.connectionManager.receiveLimitBytes?.() ?? 0;
    if (!limit || size <= limit) return false;
    const key = `${path}\n${hash ?? size}`;
    if (!this.refusedLarge.has(key)) {
      this.refusedLarge.add(key);
      const mb = (n: number) => Math.round((n / (1024 * 1024)) * 10) / 10;
      const msg = `${mb(size)} MB is over this device's limit of ${mb(limit)} MB for received files; not taken`;
      logger.warn(`${path}: ${msg}`);
      this.gate.log.record({ op: "skip", level: "warn", path, peer: this.peerLabelCb(deviceId), rule: "too-large", msg });
    }
    // It will not arrive, so it is not waited for.
    if (this.expected.get(path)?.from === deviceId) this.expected.delete(path);
    return true;
  }

  /** The adapter, when it can receive into a temporary file; null keeps chunks in memory. */
  private _tempAdapter(): TempAdapter | null {
    const adapter = (this.vault as unknown as { adapter?: Partial<TempAdapter> }).adapter;
    if (
      adapter &&
      typeof adapter.appendBinary === "function" &&
      typeof adapter.writeBinary === "function" &&
      typeof adapter.readBinary === "function" &&
      typeof adapter.remove === "function" &&
      typeof adapter.exists === "function" &&
      typeof adapter.mkdir === "function"
    ) {
      return adapter as TempAdapter;
    }
    return null;
  }

  /** Remove temporary files left by an earlier run (the app quit mid-transfer). */
  private async _cleanIncoming(): Promise<void> {
    const adapter = (this.vault as unknown as { adapter?: Partial<TempAdapter> }).adapter;
    if (!adapter?.list || !adapter.remove || !adapter.exists) return;
    try {
      if (!(await adapter.exists(INCOMING_DIR))) return;
      const { files } = await adapter.list(INCOMING_DIR);
      for (const file of files) await adapter.remove(file).catch(() => undefined);
    } catch (err) {
      logger.debug("Could not clean up partly received files:", err);
    }
  }

  private async _removeTemp(path: string): Promise<void> {
    try {
      const adapter = this._tempAdapter();
      if (adapter && (await adapter.exists(path))) await adapter.remove(path);
    } catch (err) {
      logger.debug(`Could not remove ${path}:`, err);
    }
  }

  private async _newTempPath(adapter: TempAdapter, deviceId: string): Promise<string> {
    if (!(await adapter.exists(INCOMING_DIR))) await adapter.mkdir(INCOMING_DIR);
    // Named after the peer only for reading; the device ID comes from the network.
    const peer = deviceId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 40);
    return `${INCOMING_DIR}/${peer}-${Date.now().toString(36)}-${++this.tempSeq}.part`;
  }

  private _discardIncoming(key: string): void {
    const entry = this.incoming.get(key);
    if (!entry) return;
    this.incoming.delete(key);
    if (entry.tempPath) void this._removeTemp(entry.tempPath);
  }

  /**
   * Take one chunk of a large file. Chunks are written to a temporary file as
   * they come (where the adapter can append), so a large file is not held in
   * memory while it arrives; once all are there, the file is checked against
   * the hash the peer sent and only then goes the way of any received file.
   */
  private async _receiveChunk(
    deviceId: string,
    chunk: { path: string; mtime: number; totalSize: number; offset: number; content: Uint8Array } & FileVersionInfo,
  ): Promise<void> {
    await this.incomingCleaned;
    const key = `${deviceId}\n${chunk.path}`;
    const { totalSize, offset, content } = chunk;
    if (
      !Number.isSafeInteger(totalSize) || totalSize <= 0 || totalSize > MAX_SYNC_FILE_SIZE ||
      !Number.isSafeInteger(offset) || offset < 0 || offset + content.byteLength > totalSize
    ) {
      logger.warn(`Ignoring malformed file chunk for ${chunk.path}`);
      this._discardIncoming(key);
      return;
    }

    let entry = this.incoming.get(key);
    if (offset === 0) {
      // A new transfer of this file starts (a stale partial one is dropped).
      this._discardIncoming(key);
      if (this._refuseTooLarge(deviceId, chunk.path, totalSize, chunk.hash)) return;
      const adapter = this._tempAdapter();
      let tempPath: string | null = null;
      if (adapter) {
        try {
          tempPath = await this._newTempPath(adapter, deviceId);
        } catch (err) {
          logger.warn(`Could not make a temporary file for ${chunk.path}; receiving it in memory:`, err);
        }
      }
      entry = {
        path: chunk.path,
        mtime: chunk.mtime,
        totalSize,
        received: 0,
        tempPath,
        data: tempPath ? null : new Uint8Array(totalSize),
        hash: chunk.hash,
        base: chunk.base,
        madeAt: chunk.madeAt,
      };
      this.incoming.set(key, entry);
    } else if (!entry || entry.totalSize !== totalSize) {
      // The rest of a transfer that was dropped, refused or never started.
      return;
    }
    if (offset !== entry.received) {
      logger.warn(`Out-of-order chunk for ${chunk.path}; dropping transfer`);
      this._discardIncoming(key);
      return;
    }

    try {
      if (entry.tempPath) {
        const adapter = this._tempAdapter()!;
        const bytes = toExactArrayBuffer(content);
        // The first chunk replaces whatever a file of that name held.
        if (offset === 0) await adapter.writeBinary(entry.tempPath, bytes);
        else await adapter.appendBinary(entry.tempPath, bytes);
      } else {
        entry.data!.set(content, offset);
      }
    } catch (err) {
      logger.warn(`Could not write a received part of ${chunk.path}; dropping transfer:`, err);
      if (this.incoming.get(key) === entry) this._discardIncoming(key);
      else if (entry.tempPath) await this._removeTemp(entry.tempPath);
      return;
    }
    if (this.incoming.get(key) !== entry) {
      // Dropped while the chunk was being written (the peer disconnected);
      // the write may have made the file again.
      if (entry.tempPath) await this._removeTemp(entry.tempPath);
      return;
    }
    entry.received += content.byteLength;
    if (entry.received < totalSize) return;

    this.incoming.delete(key);
    let whole: Uint8Array;
    let buffer: ArrayBuffer;
    try {
      if (entry.tempPath) {
        buffer = await this._tempAdapter()!.readBinary(entry.tempPath);
        whole = new Uint8Array(buffer);
      } else {
        whole = entry.data!;
        buffer = whole.buffer as ArrayBuffer;
      }
    } catch (err) {
      logger.warn(`Could not read back the received ${chunk.path}:`, err);
      return;
    } finally {
      if (entry.tempPath) await this._removeTemp(entry.tempPath);
    }
    if (whole.byteLength !== totalSize) {
      logger.warn(`Received ${chunk.path} has ${whole.byteLength} bytes, not ${totalSize}; discarded`);
      return;
    }
    const hash = await computeFileHash(buffer);
    if (entry.hash && entry.hash !== hash) {
      const msg = "the received file does not match the hash the peer sent; discarded";
      logger.warn(`${chunk.path}: ${msg}`);
      this.gate.log.record({ op: "skip", level: "warn", path: chunk.path, peer: this.peerLabelCb(deviceId), rule: "bad-hash", after: { hash, size: totalSize }, msg });
      return;
    }
    await this._receiveFile(entry.path, whole, entry.mtime, deviceId, entry, hash);
  }

  /** Files being written from a peer, so that two peers' copies of one file are taken in turn. */
  private receiving = new Map<string, Promise<void>>();

  /**
   * Two peers can send the same file at once (each answers a file list).
   * Taken together, both saw no file here and the second create failed
   * ("already exists"); taken in turn, the second sees the first's copy.
   */
  private _receiveFile(
    path: string,
    content: Uint8Array,
    mtime: number,
    fromDeviceId?: string,
    info: FileVersionInfo = {},
    knownHash?: string,
  ): Promise<void> {
    const previous = this.receiving.get(path) ?? Promise.resolve();
    const run = previous.then(() => this._receiveFileNow(path, content, mtime, fromDeviceId, info, knownHash));
    const tail = run.catch(() => undefined);
    this.receiving.set(path, tail);
    void tail.then(() => {
      if (this.receiving.get(path) === tail) this.receiving.delete(path);
    });
    return run;
  }

  private async _receiveFileNow(
    path: string,
    content: Uint8Array,
    mtime: number,
    fromDeviceId?: string,
    info: FileVersionInfo = {},
    /** The content's hash when the caller has just computed it (a large file). */
    knownHash?: string,
  ): Promise<void> {
    const ctx: OpContext = {
      peer: fromDeviceId ? this.peerLabelCb(fromDeviceId) : undefined,
      rule: "binary-newer",
    };
    // Kept until the file is written, not taken by the first arrival: a
    // refused answer can be followed by another (the request went out
    // after each file list), which must be refused too.
    let expected = this.expected.get(path);
    if (expected && Date.now() - expected.at >= BinaryFileSyncService.EXPECT_FOR_MS) {
      this.expected.delete(path);
      expected = undefined;
    }
    if (expected) {
      ctx.rule = expected.hash ? "binary-newer" : "remote-only";
    } else {
      ctx.rule = "live-write";
    }
    try {
      const existing = this.vault.getAbstractFileByPath(path);
      const currentContent = existing instanceof TFile
        ? new Uint8Array(await this.vault.readBinary(existing))
        : null;
      // Text files come this way when they are new and empty (an empty note
      // has no CRDT content to send), or when either copy is not plain UTF-8
      // (see isPlainUtf8). Otherwise an existing note's content is synced
      // through its CRDT document, never overwritten here.
      if (currentContent && this.isTextPath(path) && isPlainUtf8(content) && isPlainUtf8(currentContent)) return;
      const hash = knownHash ?? await computeFileHash(toExactArrayBuffer(content));
      if (info.hash && info.hash !== hash) {
        this.gate.failed("receive", path, ctx, new Error("content does not match the hash the peer sent"));
        return;
      }
      // Already here as it is: rewriting it would only change its mtime,
      // and a file sent as bytes would be sent back by its modify event.
      if (currentContent && this._isSameBinary(currentContent, content)) {
        if (expected) this.expected.delete(path);
        await this.onRemoteFileStoredCb?.(path, hash, content, fromDeviceId, info);
        return;
      }
      // A peer that has not yet seen our deletion may still send the file
      // as it was when we deleted it; that must not bring it back.
      if (!existing && this.isDeletedCb?.(path, hash)) {
        return;
      }
      const currentHash = currentContent ? await computeFileHash(toExactArrayBuffer(currentContent)) : null;
      const actual = currentContent ? { hash: currentHash!, size: currentContent.byteLength } : null;
      // The peer's version was chosen over the one we had then; it changed
      // here since (or was made here): both sides changed it.
      if (expected && currentHash !== expected.hash) {
        this.gate.preconditionFailed("overwrite", path, ctx, expected.hash ?? undefined, actual, "changed here while the peer's version was on its way");
        return;
      }
      // Sent as a change of a version we no longer have: changed here too.
      if (!expected && info.base && currentHash && currentHash !== info.base) {
        this.gate.preconditionFailed("overwrite", path, ctx, info.base, actual, "the peer changed a version this device had already changed");
        return;
      }
      // Sent with no version it replaces, and not asked for, while our copy
      // is a version no peer is known to have: the sender knows no version
      // the two share (one both devices made under the same name, or one it
      // had sent us before we changed it), and ours was made or changed
      // here. Replaced, it was left in the version store only; the file
      // lists settle it, keeping the losing version as a visible conflict
      // copy (see SyncCoordinator._settleBinaryConflict).
      if (!expected && !info.base && currentHash && this.isOwnVersionCb?.(path, currentHash)) {
        this.gate.preconditionFailed("overwrite", path, ctx, undefined, actual, "changed here, and the peer did not say which version it replaces");
        return;
      }
      if (!existing && this.canCreateCb && !(await this.canCreateCb(path))) return;
      if (expected) this.expected.delete(path);
      // Mark remote write BEFORE modifying vault to prevent echo-back
      this.onRemoteFileWrittenCb?.(path, "write", content);
      if (existing instanceof TFile && currentContent) {
        const kept = await this.gate.keepOld(path, currentContent, "remote-file-overwrite", ctx);
        if (!kept) {
          logger.error(`Aborting remote overwrite for ${path}: conflict backup unavailable`);
          return;
        }
        this.onBackupCreatedCb?.(path, kept.id, "remote-file-overwrite");
        await this.vault.modifyBinary(existing, toExactArrayBuffer(content), mtimeOption(info.madeAt ?? mtime));
        this.gate.applied("overwrite", path, ctx, actual ?? undefined, { hash, size: content.byteLength }, kept.hash ?? kept.id);
      } else {
        await ensureVaultParentFolder(this.vault, path, (folder) => this.onRemoteFolderMadeCb?.(folder));
        await this.vault.createBinary(path, toExactArrayBuffer(content), mtimeOption(info.madeAt ?? mtime));
      }
      await this.onRemoteFileStoredCb?.(path, hash, content, fromDeviceId, info);
      logger.debug(`Received binary file: ${path}`);
    } catch (err) {
      this.gate.failed("write", path, ctx, err);
      logger.error(`Failed to write binary file ${path}:`, err);
    }
  }

  /**
   * Apply a peer's live deletion. Our copy goes only when it is the one the
   * peer deleted: the same bytes, an older version of an attachment that
   * the peer had too before it changed and deleted it (see
   * setOlderCopyCheck), or for a note, nothing the peer had not seen (see
   * setNoteDeletePrecondition). Otherwise it is kept, and the file lists
   * are compared again, where the peer gets it back.
   */
  async applyIncomingDelete(deviceId: string, del: FileDeletePayload, admit = true): Promise<boolean> {
    const ctx: OpContext = {
      peer: this.peerLabelCb(deviceId),
      rule: del.movedTo ? "live-rename" : "live-delete",
    };
    if (del.movedTo) {
      let expectHash = del.hash;
      if (del.hash) {
        const file = this.vault.getAbstractFileByPath(del.path);
        if (!(file instanceof TFile)) return false;
        const hash = await computeFileHash(await this.vault.readBinary(file));
        if (hash !== del.hash) {
          // An older version of the file the peer moved on goes too: the
          // file is under its new name. Asked like any deletion (the
          // breaker lets moves through: the file lives on).
          if (!this.isOlderCopyCb?.(deviceId, del.path, hash)) return false;
          if (admit && this.admitDeleteCb && !this.admitDeleteCb(deviceId, del)) return false;
          expectHash = hash;
        }
      }
      return this._deleteFile(del.path, { expectHash, checkDoc: !!del.hash, movedTo: del.movedTo, ctx });
    }
    // The same deletion comes from each peer: wait for one already under
    // way, which leaves nothing for this one to do.
    await this.deleting.get(del.path)?.catch(() => false);
    // A file removed while it was read (by the trash, or the user) is gone.
    const snap = await this.gate.snapshot(del.path).catch(() => null);
    if (!snap) return false;
    if (admit && this.admitDeleteCb && !this.admitDeleteCb(deviceId, del)) return false;
    let ok: boolean | undefined;
    let checkDoc = true;
    if (this.isTextPath(del.path) && isPlainUtf8(snap.bytes) && this.notePreconditionCb) {
      ok = await this.notePreconditionCb(del.path, del, snap.hash);
      // Approved from the note's history, not its bytes: what the doc holds
      // beyond the disk is what the peer deleted.
      if (ok) checkDoc = false;
    }
    if (ok === undefined) {
      ok = !!del.hash && (del.hash === snap.hash || !!this.isOlderCopyCb?.(deviceId, del.path, snap.hash));
    }
    if (!ok) {
      this.gate.preconditionFailed(
        "delete",
        del.path,
        ctx,
        del.hash,
        { hash: snap.hash, size: snap.bytes.byteLength },
        del.hash ? "changed here since the peer deleted it" : "the peer did not say what it deleted",
      );
      return false;
    }
    // The deleting device's time is kept as the deletion's own (see
    // TombstoneStore.revive).
    const record: Tombstone | undefined = typeof del.deletedAt === "number"
      ? { path: del.path, deletedAt: del.deletedAt, hash: del.hash }
      : undefined;
    const deleted = await this._deleteFile(del.path, { expectHash: snap.hash, checkDoc, record, ctx });
    // Passed on to the other peers, as edits are (see SyncCoordinator):
    // a device connected only through this one would otherwise get a
    // new note made under the name before it knew the old one was gone,
    // and keep the old one as a conflict copy. Only when this message
    // deleted the file here, so the message does not go round.
    if (deleted && !this.vault.getAbstractFileByPath(del.path)) {
      const msg = encodeFileDelete(del);
      for (const peerId of this.connectionManager.getConnectedPeerIds()) {
        if (peerId !== deviceId) this.connectionManager.sendTo(peerId, msg);
      }
    }
    return deleted;
  }

  /**
   * Delete a file a peer deleted while this device was away. `record` is
   * the peer's deletion record, kept as this device's own in the same step.
   * `expectHash` is the hash the decision saw: a copy changed since is kept.
   */
  async applyRemoteDelete(
    path: string,
    record?: Tombstone,
    expectHash?: string,
    ctx: OpContext = { rule: "tombstone-covers" },
  ): Promise<boolean> {
    if (!this.isAllowedPath(path)) return false;
    return this._deleteFile(path, { expectHash, checkDoc: true, movedTo: record?.movedTo, record, ctx });
  }

  /**
   * Delete a file, its old version kept first. With `expectHash`, only that
   * exact copy is deleted: the file may change while it is kept.
   */
  private _deleteFile(path: string, opts: DeleteOptions): Promise<boolean> {
    // One deletion of a path at a time. The same deletion comes from each
    // peer (one passes on what another sent), and a tree sync may apply it
    // too; each peer's messages are handled apart, so on a slow device all
    // of them found the file still there, and backed it up and deleted it
    // once each. Taken in turn, the later ones find it gone.
    const run = (this.deleting.get(path) ?? Promise.resolve(false))
      .catch(() => false)
      .then(() => this._deleteFileNow(path, opts));
    this.deleting.set(path, run);
    const forget = () => {
      if (this.deleting.get(path) === run) this.deleting.delete(path);
    };
    run.then(forget, forget);
    return run;
  }

  /** See _deleteFile; returns whether the file was deleted. */
  private async _deleteFileNow(path: string, opts: DeleteOptions): Promise<boolean> {
    const { expectHash, movedTo, record, ctx } = opts;
    // Renamed to another case of its own name: where the storage does not
    // tell the two apart, deleting the old name would delete the renamed
    // file itself. The rename is followed instead.
    if (movedTo && isCaseVariant(path, movedTo)) {
      if (!this.vault.getAbstractFileByPath(movedTo)) await this._renameFile(path, movedTo, ctx);
      return false;
    }
    const file = this.vault.getAbstractFileByPath(path);
    if (!file) return false;
    let before: { hash: string; size: number } | undefined;
    let version: string | undefined;
    try {
      if (file instanceof TFile) {
        const currentContent = new Uint8Array(await this.vault.readBinary(file));
        before = { hash: await computeFileHash(toExactArrayBuffer(currentContent)), size: currentContent.byteLength };
        if (expectHash && before.hash !== expectHash) {
          this.gate.preconditionFailed("delete", path, ctx, expectHash, before, "changed here since the deletion was decided");
          return false;
        }
        const kept = await this.gate.keepOld(path, currentContent, "remote-file-delete", ctx);
        if (!kept) {
          logger.error(`Aborting remote delete for ${path}: conflict backup unavailable`);
          return false;
        }
        version = kept.hash ?? kept.id;
        // Routine, once per file of a bulk delete; the sync log lists it.
        logger.debug(`Kept ${path} before a remote delete`);
        this.onBackupCreatedCb?.(path, kept.id, "remote-file-delete");
      }
      // Obsidian moves the file object itself on rename: if the file was
      // renamed while it was backed up, it is no longer this path's file.
      if (file.path !== path) {
        logger.warn(`Not deleting ${path}: it was renamed to ${file.path}`);
        return false;
      }
      if (expectHash && file instanceof TFile && !(await this._isCopy(file, path, expectHash, opts.checkDoc))) {
        this.gate.preconditionFailed("delete", path, ctx, expectHash, before ?? null, "changed while its old version was kept");
        return false;
      }
      this.onRemoteFileWrittenCb?.(path, "delete");
      await this.gate.remove(file);
      this.gate.applied(movedTo ? "rename" : "delete", path, ctx, before, undefined, version, movedTo ? `moved to ${movedTo}` : undefined);
      await this.onRemoteFileDeletedCb?.(path, movedTo, record, ctx.peer);
      logger.debug(`Deleted file: ${path}`);
      return true;
    } catch (err) {
      this.gate.failed("delete", path, ctx, err);
      logger.error(`Failed to delete ${path}:`, err);
      return false;
    }
  }

  private async _isCopy(file: TFile, path: string, hash: string, checkDoc = true): Promise<boolean> {
    if ((await computeFileHash(await this.vault.readBinary(file))) !== hash) return false;
    if (checkDoc && (await this.holdsOtherContentCb?.(path, hash))) return false;
    // Checked again: it may have been renamed meanwhile.
    return file.path === path;
  }

  private async _renameFile(oldPath: string, newPath: string, ctx: OpContext = { rule: "live-rename" }): Promise<void> {
    if (oldPath === newPath) return;

    const file = this.vault.getAbstractFileByPath(oldPath);
    if (!file) {
      await this.onRemoteFileRenamedCb?.(oldPath, newPath);
      logger.debug(
        `Recorded rename intent without source file: ${oldPath} → ${newPath}`,
      );
      return;
    }

    const existingTarget = this.vault.getAbstractFileByPath(newPath);
    let version: string | undefined;
    let before: { hash: string; size: number } | undefined;
    if (existingTarget instanceof TFile) {
      const currentTargetContent = new Uint8Array(
        await this.vault.readBinary(existingTarget),
      );
      before = { hash: await computeFileHash(toExactArrayBuffer(currentTargetContent)), size: currentTargetContent.byteLength };
      const kept = await this.gate.keepOld(newPath, currentTargetContent, "remote-file-rename-overwrite", ctx);
      if (!kept) {
        logger.error(
          `Aborting remote rename ${oldPath} -> ${newPath}: target backup unavailable`,
        );
        return;
      }
      version = kept.hash ?? kept.id;
      this.onBackupCreatedCb?.(
        newPath,
        kept.id,
        "remote-file-rename-overwrite",
      );
    }

    try {
      this.onRemoteFileWrittenCb?.(oldPath, "rename");
      this.onRemoteFileWrittenCb?.(newPath, "rename");
      await ensureVaultParentFolder(this.vault, newPath, (folder) => this.onRemoteFolderMadeCb?.(folder));
      if (!(file instanceof TFile)) await this.vault.rename(file, newPath);
      else await this.renameInVault(file, newPath);
    } catch (err) {
      this.gate.failed("rename", newPath, ctx, err);
      throw err;
    }
    this.gate.applied("rename", newPath, ctx, before, undefined, version, `from ${oldPath}`);
    await this.onRemoteFileRenamedCb?.(oldPath, newPath);
    logger.debug(`Renamed file: ${oldPath} → ${newPath}`);
  }

  /**
   * Rename a file for a peer. A rename that only changes the case of the
   * name fails where the storage does not tell such names apart (Android):
   * the new name counts as taken, by the file itself. It is then done in two
   * steps, through a temporary name.
   */
  async renameInVault(file: TFile, newPath: string): Promise<void> {
    const oldPath = file.path;
    if (!isCaseVariant(oldPath, newPath)) {
      await this.vault.rename(file, newPath);
      return;
    }
    try {
      await this.vault.rename(file, newPath);
      return;
    } catch (err) {
      if (file.path !== oldPath) throw err;
      logger.debug(`Renaming ${oldPath} -> ${newPath} through a temporary name:`, err);
    }
    const slash = newPath.lastIndexOf("/");
    const dot = newPath.lastIndexOf(".");
    const extAt = dot > slash ? dot : newPath.length;
    const temp = `${newPath.slice(0, extAt)}.lvs-rename-${Date.now().toString(36)}${newPath.slice(extAt)}`;
    this.onRemoteFileWrittenCb?.(temp, "rename");
    await this.vault.rename(file, temp);
    try {
      await this.vault.rename(file, newPath);
    } catch (err) {
      this.onRemoteFileWrittenCb?.(oldPath, "rename");
      await this.vault.rename(file, oldPath).catch(() => undefined);
      throw err;
    }
  }

  private _isSameBinary(left: Uint8Array, right: Uint8Array): boolean {
    if (left.byteLength !== right.byteLength) return false;
    for (let i = 0; i < left.byteLength; i++) {
      if (left[i] !== right[i]) return false;
    }
    return true;
  }
}

/**
 * Copy exactly the bytes of a view. `view.buffer` alone may be a larger shared
 * buffer (Node's ws hands out Buffers that are slices of one chunk).
 */
interface DeleteOptions {
  /** Delete only a copy with this hash. */
  expectHash?: string;
  /** Also keep the file when its note holds content beyond the disk. */
  checkDoc?: boolean;
  movedTo?: string;
  record?: Tombstone;
  ctx: OpContext;
}


/** Keeps the version's own time on the written file (Obsidian 1.x DataWriteOptions). */
function mtimeOption(mtime: number | undefined): { mtime: number } | undefined {
  return typeof mtime === "number" && Number.isFinite(mtime) && mtime > 0 ? { mtime } : undefined;
}

function toExactArrayBuffer(view: Uint8Array): ArrayBuffer {
  return view.buffer.slice(
    view.byteOffset,
    view.byteOffset + view.byteLength,
  ) as ArrayBuffer;
}
