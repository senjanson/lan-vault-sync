import { Vault, TFile } from 'obsidian';
import { ConnectionManager } from '../transport/connection-manager';
import {
  encodeFileData,
  encodeFileDelete,
  encodeFileRename,
  encodeFileRequest,
  decodeFileData,
  decodeFileRequest,
  decodeJSON,
} from '../transport/protocol';
import { FileDeletePayload, FileRenamePayload, FileMeta, MessageType } from '../types';
import { computeFileHash } from './file-hash';
import { logger } from '../logger';

export class BinaryFileSyncService {
  private onRemoteFileWrittenCb: ((path: string) => void) | null = null;

  constructor(
    private vault: Vault,
    private connectionManager: ConnectionManager,
  ) {}

  onRemoteFileWritten(cb: (path: string) => void): void {
    this.onRemoteFileWrittenCb = cb;
  }

  /** Handle incoming protocol messages for binary file operations */
  async handleMessage(deviceId: string, type: MessageType, payload: Uint8Array): Promise<void> {
    switch (type) {
      case MessageType.FILE_REQUEST: {
        const path = decodeFileRequest(payload);
        await this._sendFile(deviceId, path);
        break;
      }
      case MessageType.FILE_DATA: {
        const data = decodeFileData(payload);
        await this._receiveFile(data.path, data.content, data.mtime);
        break;
      }
      case MessageType.FILE_DELETE: {
        const del = decodeJSON<FileDeletePayload>(payload);
        await this._deleteFile(del.path);
        break;
      }
      case MessageType.FILE_RENAME: {
        const ren = decodeJSON<FileRenamePayload>(payload);
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

  private async _receiveFile(path: string, content: Uint8Array, _mtime: number): Promise<void> {
    try {
      const existing = this.vault.getAbstractFileByPath(path);
      if (existing instanceof TFile) {
        await this.vault.modifyBinary(existing, content.buffer as ArrayBuffer);
      } else {
        // Ensure parent directory exists
        const dir = path.substring(0, path.lastIndexOf('/'));
        if (dir) {
          const adapter = (this.vault as any).adapter;
          if (adapter && !(await adapter.exists(dir))) {
            await adapter.mkdir(dir);
          }
        }
        await this.vault.createBinary(path, content.buffer as ArrayBuffer);
      }
      this.onRemoteFileWrittenCb?.(path);
      logger.debug(`Received binary file: ${path}`);
    } catch (err) {
      logger.error(`Failed to write binary file ${path}:`, err);
    }
  }

  private async _deleteFile(path: string): Promise<void> {
    const file = this.vault.getAbstractFileByPath(path);
    if (file) {
      await this.vault.delete(file);
      logger.debug(`Deleted file: ${path}`);
    }
  }

  private async _renameFile(oldPath: string, newPath: string): Promise<void> {
    const file = this.vault.getAbstractFileByPath(oldPath);
    if (file) {
      await this.vault.rename(file, newPath);
      logger.debug(`Renamed file: ${oldPath} → ${newPath}`);
    }
  }
}
