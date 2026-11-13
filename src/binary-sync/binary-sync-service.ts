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
import {
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
import { ensureParentDirectory, isCaseVariant, isSafeSyncPath } from "../utils/path-utils";

interface IncomingFile {
  path: string;
  mtime: number;
  data: Uint8Array;
  received: number;
}

export class BinaryFileSyncService {
  /** Chunked files being received, keyed by `${deviceId}\n${path}`. */
  private incoming = new Map<string, IncomingFile>();
  private isDeletedCb: ((path: string, hash: string) => boolean) | null = null;
  private holdsOtherContentCb:
    | ((path: string, hash: string) => Promise<boolean>)
    | null = null;
  private canCreateCb: ((path: string) => Promise<boolean>) | null = null;
  private onRemoteFileStoredCb:
    | ((path: string, hash: string, content: Uint8Array, fromDeviceId?: string) => void | Promise<void>)
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
  private onBackupCreatedCb:
    | ((path: string, backupId: string, reason: string) => void)
    | null = null;

  constructor(
    private vault: Vault,
    private connectionManager: ConnectionManager,
    private backupService: ConflictBackupService,
    private isAllowedPath: (path: string) => boolean = isSafeSyncPath,
    private isTextPath: (path: string) => boolean = () => false,
  ) {}

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
    cb: (path: string, hash: string, content: Uint8Array, fromDeviceId?: string) => void | Promise<void>,
  ): void {
    this.onRemoteFileStoredCb = cb;
  }

  /** Called before a peer's change is made to a file; `content` for writes. */
  onRemoteFileWritten(
    cb: (path: string, kind?: "write" | "delete" | "rename", content?: Uint8Array) => void,
  ): void {
    this.onRemoteFileWrittenCb = cb;
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
        await this._receiveFile(data.path, data.content, data.mtime, deviceId);
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
        if (del.hash) {
          const file = this.vault.getAbstractFileByPath(del.path);
          if (!(file instanceof TFile)) break;
          if ((await computeFileHash(await this.vault.readBinary(file))) !== del.hash) break;
        }
        // The deleting device's time is kept as the deletion's own (see
        // TombstoneStore.revive).
        const record = !del.movedTo && typeof del.deletedAt === "number"
          ? { path: del.path, deletedAt: del.deletedAt }
          : undefined;
        await this._deleteFile(del.path, del.hash, del.movedTo, record);
        break;
      }
      case MessageType.FILE_RENAME: {
        const ren = decodeJSON<FileRenamePayload>(payload);
        if (!this.isAllowedPath(ren.oldPath) || !this.isAllowedPath(ren.newPath))
          break;
        await this._renameFile(ren.oldPath, ren.newPath);
        break;
      }
    }
  }

  /** Send a file create/update to all peers */
  async broadcastFileChange(path: string): Promise<void> {
    const file = this.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return;

    const content = await this.vault.readBinary(file);
    for (const msg of this._encodeFile(path, new Uint8Array(content), file.stat.mtime)) {
      this.connectionManager.broadcast(msg);
    }
  }

  /** Send a file deletion to all peers, with when it was made. */
  broadcastFileDelete(path: string, deletedAt?: number): void {
    const msg = encodeFileDelete(deletedAt === undefined ? { path } : { path, deletedAt });
    this.connectionManager.broadcast(msg);
  }

  /** Send a file rename to all peers */
  broadcastFileRename(oldPath: string, newPath: string): void {
    const msg = encodeFileRename({ oldPath, newPath });
    this.connectionManager.broadcast(msg);
  }

  /** Request a file from a specific peer */
  requestFile(deviceId: string, path: string): void {
    const msg = encodeFileRequest(path);
    this.connectionManager.sendTo(deviceId, msg);
  }

  /** Send a file to a specific peer (not broadcast) */
  async sendFileToPeer(deviceId: string, path: string): Promise<void> {
    const file = this.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return;

    const content = await this.vault.readBinary(file);
    for (const msg of this._encodeFile(path, new Uint8Array(content), file.stat.mtime)) {
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

    const content = await this.vault.readBinary(file);
    for (const msg of this._encodeFile(path, new Uint8Array(content), file.stat.mtime)) {
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
  private _encodeFile(path: string, content: Uint8Array, mtime: number): Uint8Array[] {
    if (content.byteLength <= CHUNKED_FILE_THRESHOLD) {
      return [encodeFileData({ path, content, mtime })];
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
        }),
      );
    }
    return messages;
  }

  private async _receiveChunk(
    deviceId: string,
    chunk: { path: string; mtime: number; totalSize: number; offset: number; content: Uint8Array },
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
      entry = { path: chunk.path, mtime: chunk.mtime, data: new Uint8Array(totalSize), received: 0 };
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
      await this._receiveFile(entry.path, entry.data, entry.mtime, deviceId);
    }
  }

  private async _receiveFile(
    path: string,
    content: Uint8Array,
    _mtime: number,
    fromDeviceId?: string,
  ): Promise<void> {
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
      // Already here as it is: rewriting it would only change its mtime,
      // and a file sent as bytes would be sent back by its modify event.
      if (currentContent && this._isSameBinary(currentContent, content)) {
        await this.onRemoteFileStoredCb?.(path, hash, content, fromDeviceId);
        return;
      }
      // A peer that has not yet seen our deletion may still send the file
      // as it was when we deleted it; that must not bring it back.
      if (!existing && this.isDeletedCb?.(path, hash)) {
        return;
      }
      if (!existing && this.canCreateCb && !(await this.canCreateCb(path))) return;
      // Mark remote write BEFORE modifying vault to prevent echo-back
      this.onRemoteFileWrittenCb?.(path, "write", content);
      if (existing instanceof TFile && currentContent) {
        const backup = await this.backupService.backupBinaryFile(
          path,
          currentContent,
          "remote-file-overwrite",
          {
            incomingSize: content.byteLength,
            existingSize: currentContent.byteLength,
          },
        );
        if (!backup) {
          logger.error(
            `Aborting remote overwrite for ${path}: conflict backup unavailable`,
          );
          return;
        }
        logger.warn(
          `Backed up file before remote overwrite: ${path} -> ${backup.contentPath}`,
        );
        this.onBackupCreatedCb?.(
          path,
          backup.backupId,
          "remote-file-overwrite",
        );
        await this.vault.modifyBinary(existing, toExactArrayBuffer(content));
      } else {
        const adapter = (this.vault as any).adapter;
        if (adapter) {
          await ensureParentDirectory(adapter, path);
        }
        await this.vault.createBinary(path, toExactArrayBuffer(content));
      }
      await this.onRemoteFileStoredCb?.(path, hash, content, fromDeviceId);
      logger.debug(`Received binary file: ${path}`);
    } catch (err) {
      logger.error(`Failed to write binary file ${path}:`, err);
    }
  }

  /** Delete a local file because a peer deleted it (backed up first). */
  /**
   * Delete a file a peer deleted while this device was away. `record` is
   * the peer's deletion record, kept as this device's own in the same step.
   */
  async applyRemoteDelete(path: string, record?: Tombstone): Promise<void> {
    if (!this.isAllowedPath(path)) return;
    await this._deleteFile(path, undefined, record?.movedTo, record);
  }

  /**
   * Delete a file, backed up first. With `hash`, only that exact copy is
   * deleted: the file may change while it is backed up.
   */
  private async _deleteFile(path: string, hash?: string, movedTo?: string, record?: Tombstone): Promise<void> {
    // Renamed to another case of its own name: where the storage does not
    // tell the two apart, deleting the old name would delete the renamed
    // file itself. The rename is followed instead.
    if (movedTo && isCaseVariant(path, movedTo)) {
      if (!this.vault.getAbstractFileByPath(movedTo)) await this._renameFile(path, movedTo);
      return;
    }
    const file = this.vault.getAbstractFileByPath(path);
    if (file) {
      if (file instanceof TFile) {
        const currentContent = new Uint8Array(
          await this.vault.readBinary(file),
        );
        const backup = await this.backupService.backupBinaryFile(
          path,
          currentContent,
          "remote-file-delete",
          {
            size: currentContent.byteLength,
          },
        );
        if (!backup) {
          logger.error(
            `Aborting remote delete for ${path}: conflict backup unavailable`,
          );
          return;
        }
        logger.warn(
          `Backed up file before remote delete: ${path} -> ${backup.contentPath}`,
        );
        this.onBackupCreatedCb?.(path, backup.backupId, "remote-file-delete");
      }
      // Obsidian moves the file object itself on rename: if the file was
      // renamed while it was backed up, it is no longer this path's file.
      if (file.path !== path) {
        logger.warn(`Not deleting ${path}: it was renamed to ${file.path}`);
        return;
      }
      if (hash && file instanceof TFile && !(await this._isCopy(file, path, hash))) {
        logger.warn(`Not deleting ${path}: it changed while it was backed up`);
        return;
      }
      this.onRemoteFileWrittenCb?.(path, "delete");
      await this.vault.delete(file);
      await this.onRemoteFileDeletedCb?.(path, movedTo, record);
      logger.debug(`Deleted file: ${path}`);
    }
  }

  private async _isCopy(file: TFile, path: string, hash: string): Promise<boolean> {
    if ((await computeFileHash(await this.vault.readBinary(file))) !== hash) return false;
    if (await this.holdsOtherContentCb?.(path, hash)) return false;
    // Checked again: it may have been renamed meanwhile.
    return file.path === path;
  }

  private async _renameFile(oldPath: string, newPath: string): Promise<void> {
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
    if (existingTarget instanceof TFile) {
      const currentTargetContent = new Uint8Array(
        await this.vault.readBinary(existingTarget),
      );
      const backup = await this.backupService.backupBinaryFile(
        newPath,
        currentTargetContent,
        "remote-file-rename-overwrite",
        {
          oldPath,
          newPath,
          size: currentTargetContent.byteLength,
        },
      );
      if (!backup) {
        logger.error(
          `Aborting remote rename ${oldPath} -> ${newPath}: target backup unavailable`,
        );
        return;
      }
      logger.warn(
        `Backed up rename target before remote rename: ${newPath} -> ${backup.contentPath}`,
      );
      this.onBackupCreatedCb?.(
        newPath,
        backup.backupId,
        "remote-file-rename-overwrite",
      );
    }

    this.onRemoteFileWrittenCb?.(oldPath, "rename");
    this.onRemoteFileWrittenCb?.(newPath, "rename");
    const adapter = (this.vault as any).adapter;
    if (adapter) {
      await ensureParentDirectory(adapter, newPath);
    }
    if (!(file instanceof TFile)) await this.vault.rename(file, newPath);
    else await this.renameInVault(file, newPath);
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
function toExactArrayBuffer(view: Uint8Array): ArrayBuffer {
  return view.buffer.slice(
    view.byteOffset,
    view.byteOffset + view.byteLength,
  ) as ArrayBuffer;
}
