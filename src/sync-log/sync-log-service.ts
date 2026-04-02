import { Vault, TFile } from 'obsidian';
import { ConflictBackupService } from '../conflict/conflict-backup-service';
import { SyncLogEntry, SyncLogEntryType, LANSyncSettings } from '../types';
import { SYNC_LOG_FILE_PATH, MAX_SYNC_LOG_ENTRIES } from '../constants';
import { logger } from '../logger';
import { ensureParentDirectory } from '../utils/path-utils';

export class SyncLogService {
  private entries: SyncLogEntry[] = [];
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private onChangeCb: (() => void) | null = null;
  private sequence = 0;
  private lastLocalSendTime = new Map<string, number>();

  constructor(
    private vault: Vault,
    private settings: LANSyncSettings,
    private backupService: ConflictBackupService,
  ) {}

  onChange(cb: () => void): void {
    this.onChangeCb = cb;
  }

  getEntries(): SyncLogEntry[] {
    return this.entries;
  }

  addEntry(
    type: SyncLogEntryType,
    path: string,
    options: {
      deviceName?: string;
      snapshotId?: string;
      hasSnapshot?: boolean;
      details?: SyncLogEntry['details'];
    } = {},
  ): SyncLogEntry | null {
    if (!this.settings.enableSyncLog) return null;

    // Dedup local-send for same path within 10s to avoid flooding
    if (type === 'local-send') {
      const last = this.lastLocalSendTime.get(path);
      if (last && Date.now() - last < 10000) return null;
      this.lastLocalSendTime.set(path, Date.now());
    }

    const entry: SyncLogEntry = {
      id: this._nextId(),
      timestamp: Date.now(),
      type,
      path,
      deviceName: options.deviceName,
      snapshotId: options.snapshotId,
      hasSnapshot: options.hasSnapshot ?? !!options.snapshotId,
      details: options.details,
    };

    this.entries.unshift(entry);
    const max = this.settings.maxSyncLogEntries || MAX_SYNC_LOG_ENTRIES;
    if (this.entries.length > max) {
      this.entries = this.entries.slice(0, max);
    }

    this._scheduleSave();
    this.onChangeCb?.();
    return entry;
  }

  async readSnapshotContent(entry: SyncLogEntry): Promise<string | null> {
    if (!entry.snapshotId) return null;
    return this.backupService.readTextBackup(entry.snapshotId, entry.path);
  }

  async restoreFromSnapshot(entry: SyncLogEntry): Promise<boolean> {
    if (!entry.snapshotId) return false;

    try {
      const isText = entry.details?.isText ?? true;

      if (isText) {
        const content = await this.backupService.readTextBackup(entry.snapshotId, entry.path);
        if (content === null) return false;

        const file = this.vault.getAbstractFileByPath(entry.path);
        if (file instanceof TFile) {
          await this.vault.modify(file, content);
        } else {
          const adapter = (this.vault as any).adapter;
          if (adapter) await ensureParentDirectory(adapter, entry.path);
          await this.vault.create(entry.path, content);
        }
      } else {
        const content = await this.backupService.readBinaryBackup(entry.snapshotId, entry.path);
        if (content === null) return false;

        const file = this.vault.getAbstractFileByPath(entry.path);
        if (file instanceof TFile) {
          await this.vault.modifyBinary(file, content);
        } else {
          const adapter = (this.vault as any).adapter;
          if (adapter) await ensureParentDirectory(adapter, entry.path);
          await this.vault.createBinary(entry.path, content);
        }
      }

      return true;
    } catch (err) {
      logger.error(`Failed to restore from snapshot ${entry.snapshotId}:`, err);
      return false;
    }
  }

  async loadFromDisk(): Promise<void> {
    const adapter = (this.vault as any).adapter;
    if (!adapter?.read) return;

    try {
      const raw = await adapter.read(SYNC_LOG_FILE_PATH);
      const data = JSON.parse(raw);
      if (Array.isArray(data)) {
        this.entries = data;
      }
    } catch {
      this.entries = [];
    }
  }

  async saveToDisk(): Promise<void> {
    const adapter = (this.vault as any).adapter;
    if (!adapter?.write) return;

    try {
      await ensureParentDirectory(adapter, SYNC_LOG_FILE_PATH);
      await adapter.write(SYNC_LOG_FILE_PATH, JSON.stringify(this.entries));
    } catch (err) {
      logger.error('Failed to save sync log:', err);
    }
  }

  async clearAll(): Promise<void> {
    this.entries = [];
    this.lastLocalSendTime.clear();
    await this.saveToDisk();
    this.onChangeCb?.();
  }

  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    await this.saveToDisk();
  }

  private _nextId(): string {
    this.sequence += 1;
    return `${Date.now()}-${this.sequence}`;
  }

  private _scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(async () => {
      this.saveTimer = null;
      await this.saveToDisk();
    }, 2000);
  }
}
