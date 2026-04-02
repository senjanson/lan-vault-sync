import { Vault } from "obsidian";
import { CONFLICT_BACKUP_DIR } from "../constants";
import { logger } from "../logger";
import { ensureParentDirectory } from "../utils/path-utils";

type ConflictBackupKind = "text" | "binary";

export interface ConflictBackupResult {
  backupId: string;
  backupDir: string;
  contentPath: string;
  metadataPath: string;
}

export class ConflictBackupService {
  private sequence = 0;

  constructor(private vault: Vault) {}

  async backupTextFile(
    filePath: string,
    content: string,
    reason: string,
    details: Record<string, unknown> = {},
  ): Promise<ConflictBackupResult | null> {
    const adapter = (this.vault as any).adapter;
    if (!adapter?.write) {
      logger.warn(
        `Conflict backup skipped for ${filePath}: adapter.write unavailable`,
      );
      return null;
    }

    try {
      const snapshot = this._buildSnapshotPaths(filePath);
      const metadata = this._buildMetadata(filePath, reason, "text", details);

      await ensureParentDirectory(adapter, snapshot.contentPath);
      await ensureParentDirectory(adapter, snapshot.metadataPath);
      await adapter.write(snapshot.contentPath, content);
      await adapter.write(
        snapshot.metadataPath,
        JSON.stringify(metadata, null, 2),
      );
      return snapshot;
    } catch (err) {
      logger.error(
        `Failed to create text conflict backup for ${filePath}:`,
        err,
      );
      return null;
    }
  }

  async backupBinaryFile(
    filePath: string,
    content: Uint8Array,
    reason: string,
    details: Record<string, unknown> = {},
  ): Promise<ConflictBackupResult | null> {
    const adapter = (this.vault as any).adapter;
    if (!adapter?.writeBinary || !adapter?.write) {
      logger.warn(
        `Conflict backup skipped for ${filePath}: adapter write methods unavailable`,
      );
      return null;
    }

    try {
      const snapshot = this._buildSnapshotPaths(filePath);
      const metadata = this._buildMetadata(filePath, reason, "binary", details);

      await ensureParentDirectory(adapter, snapshot.contentPath);
      await ensureParentDirectory(adapter, snapshot.metadataPath);
      await adapter.writeBinary(
        snapshot.contentPath,
        this._toArrayBuffer(content),
      );
      await adapter.write(
        snapshot.metadataPath,
        JSON.stringify(metadata, null, 2),
      );
      return snapshot;
    } catch (err) {
      logger.error(
        `Failed to create binary conflict backup for ${filePath}:`,
        err,
      );
      return null;
    }
  }

  private _buildSnapshotPaths(filePath: string): ConflictBackupResult {
    const backupId = this._nextBackupId(filePath);
    const backupDir = `${CONFLICT_BACKUP_DIR}/${backupId}`;
    return {
      backupId,
      backupDir,
      contentPath: `${backupDir}/files/${filePath}`,
      metadataPath: `${backupDir}/metadata.json`,
    };
  }

  private _buildMetadata(
    filePath: string,
    reason: string,
    kind: ConflictBackupKind,
    details: Record<string, unknown>,
  ): Record<string, unknown> {
    return {
      originalPath: filePath,
      reason,
      kind,
      savedAt: new Date().toISOString(),
      details,
    };
  }

  private _nextBackupId(filePath: string): string {
    this.sequence += 1;
    const safeTime = new Date().toISOString().replace(/[:.]/g, "-");
    return `${safeTime}-${this.sequence}-${this._keyForPath(filePath)}`;
  }

  private _keyForPath(filePath: string): string {
    const bytes = new TextEncoder().encode(filePath);
    let binary = "";
    for (const byte of bytes) {
      binary += String.fromCharCode(byte);
    }
    return btoa(binary)
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  }

  private _toArrayBuffer(content: Uint8Array): ArrayBuffer {
    return content.buffer.slice(
      content.byteOffset,
      content.byteOffset + content.byteLength,
    ) as ArrayBuffer;
  }

  async readTextBackup(
    snapshotId: string,
    filePath: string,
  ): Promise<string | null> {
    const adapter = (this.vault as any).adapter;
    if (!adapter?.read) return null;

    const contentPath = `${CONFLICT_BACKUP_DIR}/${snapshotId}/files/${filePath}`;
    try {
      return await adapter.read(contentPath);
    } catch {
      return null;
    }
  }

  async readBinaryBackup(
    snapshotId: string,
    filePath: string,
  ): Promise<ArrayBuffer | null> {
    const adapter = (this.vault as any).adapter;
    if (!adapter?.readBinary) return null;

    const contentPath = `${CONFLICT_BACKUP_DIR}/${snapshotId}/files/${filePath}`;
    try {
      return await adapter.readBinary(contentPath);
    } catch {
      return null;
    }
  }
}
