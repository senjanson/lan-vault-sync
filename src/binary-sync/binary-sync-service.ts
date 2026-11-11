import { Vault, TFile } from "obsidian";
import { ConnectionManager } from "../transport/connection-manager";
import { ConflictBackupService } from "../conflict/conflict-backup-service";
import {
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
import { ensureParentDirectory, isSafeSyncPath } from "../utils/path-utils";

export class BinaryFileSyncService {
  private onRemoteFileWrittenCb: ((path: string) => void) | null = null;
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
  ) {}

  onRemoteFileWritten(cb: (path: string) => void): void {
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
        if (!isSafeSyncPath(path)) break;
        await this._sendFile(deviceId, path);
        break;
      }
      case MessageType.FILE_DATA: {
        const data = decodeFileData(payload);
        if (!isSafeSyncPath(data.path)) break;
        await this._receiveFile(data.path, data.content, data.mtime);
        break;
      }
      case MessageType.FILE_DELETE: {
        const del = decodeJSON<FileDeletePayload>(payload);
        if (!isSafeSyncPath(del.path)) break;
        await this._deleteFile(del.path);
        break;
      }
      case MessageType.FILE_RENAME: {
        const ren = decodeJSON<FileRenamePayload>(payload);
        if (!isSafeSyncPath(ren.oldPath) || !isSafeSyncPath(ren.newPath))
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
    const msg = encodeFileData({
      path,
      content: new Uint8Array(content),
      mtime: file.stat.mtime,
    });
    this.connectionManager.broadcast(msg);
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
    const msg = encodeFileData({
      path,
      content: new Uint8Array(content),
      mtime: file.stat.mtime,
    });
    this.connectionManager.sendTo(deviceId, msg);
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
    const msg = encodeFileData({
      path,
      content: new Uint8Array(content),
      mtime: file.stat.mtime,
    });
    this.connectionManager.sendTo(deviceId, msg);
  }

  private async _receiveFile(
    path: string,
    content: Uint8Array,
    _mtime: number,
  ): Promise<void> {
    try {
      // Mark remote write BEFORE modifying vault to prevent echo-back
      this.onRemoteFileWrittenCb?.(path);
      const existing = this.vault.getAbstractFileByPath(path);
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
      this.onRemoteFileWrittenCb?.(path);
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

    this.onRemoteFileWrittenCb?.(oldPath);
    this.onRemoteFileWrittenCb?.(newPath);
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
