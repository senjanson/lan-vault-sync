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
  MAX_SYNC_FILE_SIZE,
} from "../constants";
import { ensureVaultParentFolder, isCaseVariant, isSafeSyncPath } from "../utils/path-utils";

interface IncomingFile extends FileVersionInfo {
  path: string;
  mtime: number;
  data: Uint8Array;
  received: number;
}

export class BinaryFileSyncService {
  /** Chunked files being received, keyed by `${deviceId}\n${path}`. */
  private incoming = new Map<string, IncomingFile>();
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
  private onRemoteFileWrittenCb:
    | ((path: string, kind?: "write" | "delete" | "rename", content?: Uint8Array) => void)
    | null = null;
  private onRemoteFileDeletedCb:
    | ((path: string, movedTo?: string, record?: Tombstone) => Promise<void> | void)
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
    this.gate = new ApplyGate({ vault, keeper: new BackupKeeper(backupService), log: new EventLog(null) });
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

  onRemoteFileDeleted(cb: (path: string, movedTo?: string, record?: Tombstone) => Promise<void> | void): void {
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
  async broadcastFileChange(path: string, base?: string, madeAt?: number): Promise<string | undefined> {
    const file = this.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return undefined;

    const content = new Uint8Array(await this.vault.readBinary(file));
    const hash = await computeFileHash(toExactArrayBuffer(content));
    const info: FileVersionInfo = { hash, madeAt: madeAt ?? file.stat.mtime };
    if (base && base !== hash) info.base = base;
    for (const msg of this._encodeFile(path, content, file.stat.mtime, info)) {
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
  requestFile(deviceId: string, path: string, expectHash?: string | null): void {
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

    const content = new Uint8Array(await this.vault.readBinary(file));
    const hash = await computeFileHash(toExactArrayBuffer(content));
    const info: FileVersionInfo = { hash, madeAt: opts.madeAt ?? file.stat.mtime };
    if (opts.base) info.base = opts.base;
    for (const msg of this._encodeFile(path, content, file.stat.mtime, info)) {
      this.connectionManager.sendTo(deviceId, msg);
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

    const content = new Uint8Array(await this.vault.readBinary(file));
    const hash = await computeFileHash(toExactArrayBuffer(content));
    for (const msg of this._encodeFile(path, content, file.stat.mtime, { hash, madeAt: file.stat.mtime })) {
      this.connectionManager.sendTo(deviceId, msg);
    }
  }

  /** Drop partially received files from a peer that went away. */
  dropIncoming(deviceId: string): void {
    for (const key of this.incoming.keys()) {
      if (key.startsWith(`${deviceId}\n`)) this.incoming.delete(key);
    }
  }

  /**
   * Encode a file as one FILE_DATA message, or as FILE_CHUNK messages when it
   * is large: a single message over ~100 MiB is refused by the ws library and
   * closed the connection, so big files never synced.
   */
  private _encodeFile(path: string, content: Uint8Array, mtime: number, info: FileVersionInfo = {}): Uint8Array[] {
    if (content.byteLength <= CHUNKED_FILE_THRESHOLD) {
      return [encodeFileData({ path, content, mtime, ...info })];
    }
    const messages: Uint8Array[] = [];
    for (let offset = 0; offset < content.byteLength; offset += CHUNK_SIZE) {
      messages.push(
        encodeFileChunk({
          path,
          mtime,
          totalSize: content.byteLength,
          offset,
          content: content.subarray(offset, offset + CHUNK_SIZE),
          ...(offset === 0 ? info : {}),
        }),
      );
    }
    return messages;
  }

  private async _receiveChunk(
    deviceId: string,
    chunk: { path: string; mtime: number; totalSize: number; offset: number; content: Uint8Array } & FileVersionInfo,
  ): Promise<void> {
    const key = `${deviceId}\n${chunk.path}`;
    const { totalSize, offset, content } = chunk;
    if (
      !Number.isSafeInteger(totalSize) || totalSize <= 0 || totalSize > MAX_SYNC_FILE_SIZE ||
      !Number.isSafeInteger(offset) || offset < 0 || offset + content.byteLength > totalSize
    ) {
      logger.warn(`Ignoring malformed file chunk for ${chunk.path}`);
      this.incoming.delete(key);
      return;
    }

    let entry = this.incoming.get(key);
    if (offset === 0 || !entry || entry.data.byteLength !== totalSize) {
      // A new transfer of this file starts (a stale partial one is dropped).
      if (offset !== 0) return;
      entry = {
        path: chunk.path,
        mtime: chunk.mtime,
        data: new Uint8Array(totalSize),
        received: 0,
        hash: chunk.hash,
        base: chunk.base,
        madeAt: chunk.madeAt,
      };
      this.incoming.set(key, entry);
    }
    if (offset !== entry.received) {
      logger.warn(`Out-of-order chunk for ${chunk.path}; dropping transfer`);
      this.incoming.delete(key);
      return;
    }

    entry.data.set(content, offset);
    entry.received += content.byteLength;
    if (entry.received === totalSize) {
      this.incoming.delete(key);
      await this._receiveFile(entry.path, entry.data, entry.mtime, deviceId, entry);
    }
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
  ): Promise<void> {
    const previous = this.receiving.get(path) ?? Promise.resolve();
    const run = previous.then(() => this._receiveFileNow(path, content, mtime, fromDeviceId, info));
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
      const hash = await computeFileHash(toExactArrayBuffer(content));
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
        await ensureVaultParentFolder(this.vault as any, path, (folder) => this.onRemoteFolderMadeCb?.(folder));
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
   * peer deleted: the same bytes, or for a note, nothing the peer had not
   * seen (see setNoteDeletePrecondition). Otherwise it is kept, and the file
   * lists are compared again, where the peer gets it back.
   */
  async applyIncomingDelete(deviceId: string, del: FileDeletePayload, admit = true): Promise<boolean> {
    const ctx: OpContext = {
      peer: this.peerLabelCb(deviceId),
      rule: del.movedTo ? "live-rename" : "live-delete",
    };
    if (del.movedTo) {
      if (del.hash) {
        const file = this.vault.getAbstractFileByPath(del.path);
        if (!(file instanceof TFile)) return false;
        if ((await computeFileHash(await this.vault.readBinary(file))) !== del.hash) return false;
      }
      return this._deleteFile(del.path, { expectHash: del.hash, checkDoc: !!del.hash, movedTo: del.movedTo, ctx });
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
    if (ok === undefined) ok = !!del.hash && del.hash === snap.hash;
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
      await this.onRemoteFileDeletedCb?.(path, movedTo, record);
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
      await ensureVaultParentFolder(this.vault as any, newPath, (folder) => this.onRemoteFolderMadeCb?.(folder));
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
