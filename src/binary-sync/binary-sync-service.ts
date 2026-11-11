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
  MessageType,
} from "../types";
import { computeFileHash } from "./file-hash";
import { logger } from "../logger";
import {
  CHUNK_SIZE,
  CHUNKED_FILE_THRESHOLD,
  MAX_SYNC_FILE_SIZE,
} from "../constants";
import { ensureParentDirectory, isSafeSyncPath } from "../utils/path-utils";

interface IncomingFile {
  path: string;
  mtime: number;
  data: Uint8Array;
  received: number;
}

export class BinaryFileSyncService {
  /** Chunked files being received, keyed by `${deviceId}\n${path}`. */
  private incoming = new Map<string, IncomingFile>();
  private onRemoteFileWrittenCb:
    | ((path: string, kind?: "write" | "delete" | "rename") => void)
    | null = null;
  private onRemoteFileDeletedCb:
    | ((path: string) => Promise<void> | void)
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

  onRemoteFileWritten(
    cb: (path: string, kind?: "write" | "delete" | "rename") => void,
  ): void {
    this.onRemoteFileWrittenCb = cb;
  }

  onRemoteFileDeleted(cb: (path: string) => Promise<void> | void): void {
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
        await this._receiveFile(data.path, data.content, data.mtime);
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
        await this._deleteFile(del.path);
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

  /** Send a file deletion to all peers */
  broadcastFileDelete(path: string): void {
    const msg = encodeFileDelete({ path });
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
      await this._receiveFile(entry.path, entry.data, entry.mtime);
    }
  }

  private async _receiveFile(
    path: string,
    content: Uint8Array,
    _mtime: number,
  ): Promise<void> {
    try {
      const existing = this.vault.getAbstractFileByPath(path);
      // Text files only come this way when they are new and empty (an empty
      // note has no CRDT content to send). An existing note's content is
      // synced through its CRDT document, never overwritten here.
      if (existing instanceof TFile && this.isTextPath(path)) return;
      // Mark remote write BEFORE modifying vault to prevent echo-back
      this.onRemoteFileWrittenCb?.(path);
      if (existing instanceof TFile) {
        const currentContent = new Uint8Array(
          await this.vault.readBinary(existing),
        );
        if (!this._isSameBinary(currentContent, content)) {
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
        }
        await this.vault.modifyBinary(existing, toExactArrayBuffer(content));
      } else {
        const adapter = (this.vault as any).adapter;
        if (adapter) {
          await ensureParentDirectory(adapter, path);
        }
        await this.vault.createBinary(path, toExactArrayBuffer(content));
      }
      logger.debug(`Received binary file: ${path}`);
    } catch (err) {
      logger.error(`Failed to write binary file ${path}:`, err);
    }
  }

  /** Delete a local file because a peer deleted it (backed up first). */
  async applyRemoteDelete(path: string): Promise<void> {
    if (!this.isAllowedPath(path)) return;
    await this._deleteFile(path);
  }

  private async _deleteFile(path: string): Promise<void> {
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
      this.onRemoteFileWrittenCb?.(path, "delete");
      await this.vault.delete(file);
      await this.onRemoteFileDeletedCb?.(path);
      logger.debug(`Deleted file: ${path}`);
    }
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
    await this.vault.rename(file, newPath);
    await this.onRemoteFileRenamedCb?.(oldPath, newPath);
    logger.debug(`Renamed file: ${oldPath} → ${newPath}`);
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
