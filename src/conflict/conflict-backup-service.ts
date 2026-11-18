import { Vault } from "obsidian";
import { CONFLICT_BACKUP_DIR } from "../constants";
import { logger } from "../logger";
import { ensureDirectory, ensureParentDirectory, getParentDir } from "../utils/path-utils";

type ConflictBackupKind = "text" | "binary";

export interface ConflictBackupResult {
  backupId: string;
  backupDir: string;
  contentPath: string;
  metadataPath: string;
}

export class ConflictBackupService {
  private sequence = 0;
  /** Whether CONFLICT_BACKUP_DIR is known to exist; see _makeFolders. */
  private rootReady = false;
  /** The adapter does not make missing parent folders; see _writeInNewFolders. */
  private oneLevelAtATime = false;

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

      await this._writeInNewFolders(adapter, snapshot, () => adapter.write(snapshot.contentPath, content));
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

      await this._writeInNewFolders(adapter, snapshot, () =>
        adapter.writeBinary(snapshot.contentPath, this._toArrayBuffer(content)),
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

  /**
   * Write a new backup's file, making its folders first. Obsidian's adapters
   * make a folder's missing parents along with it, so one call makes them
   * all: a bulk delete from a peer backs up every file, and a call per
   * folder level was most of the work of each. Where that fails (the call
   * refused the missing parents, or the write found no folder) they are
   * made one level at a time and the file written again.
   */
  private async _writeInNewFolders(
    adapter: any,
    snapshot: ConflictBackupResult,
    write: () => Promise<void>,
  ): Promise<void> {
    if (this.rootReady && !this.oneLevelAtATime) {
      try {
        await adapter.mkdir(getParentDir(snapshot.contentPath));
        await write();
        return;
      } catch (err) {
        logger.debug("Making backup folders one level at a time:", err);
        this.oneLevelAtATime = true;
      }
    }
    await this._makeFolders(adapter, snapshot);
    await write();
  }

  /**
   * Create a new backup's folders. They are new (the backup id is unique),
   * so they are made without looking each one up first: on a phone every
   * lookup is a round trip to the file system, and a bulk delete from a
   * peer backs up every file, which made such lookups most of its work.
   */
  private async _makeFolders(adapter: any, snapshot: ConflictBackupResult): Promise<void> {
    try {
      if (!this.rootReady) {
        await ensureDirectory(adapter, CONFLICT_BACKUP_DIR);
        this.rootReady = true;
      }
      const parent = getParentDir(snapshot.contentPath);
      let dir = snapshot.backupDir;
      await adapter.mkdir(dir);
      for (const name of parent.slice(dir.length + 1).split("/")) {
        dir = `${dir}/${name}`;
        await adapter.mkdir(dir);
      }
    } catch (err) {
      // E.g. the backup folder was removed meanwhile.
      logger.debug("Creating backup folders one by one:", err);
      this.rootReady = false;
      await ensureParentDirectory(adapter, snapshot.contentPath);
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

  /**
   * Short tag for the backup folder name (FNV-1a of the path). The folder must
   * stay well under the 255-byte name limit; the full path is kept under
   * files/ and in metadata.json.
   */
  private _keyForPath(filePath: string): string {
    let hash = 0x811c9dc5;
    for (const byte of new TextEncoder().encode(filePath)) {
      hash ^= byte;
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, "0");
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
