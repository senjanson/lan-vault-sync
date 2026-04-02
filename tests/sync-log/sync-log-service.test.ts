import { describe, expect, it, vi, beforeEach } from 'vitest';
import { TFile } from 'obsidian';
import { SyncLogService } from '../../src/sync-log/sync-log-service';
import { ConflictBackupService } from '../../src/conflict/conflict-backup-service';
import { DEFAULT_SETTINGS, SyncLogEntry } from '../../src/types';
import { SYNC_LOG_FILE_PATH } from '../../src/constants';

class FakeAdapter {
  textFiles = new Map<string, string>();
  directories = new Set<string>();

  async exists(path: string): Promise<boolean> {
    return this.directories.has(path) || this.textFiles.has(path);
  }

  async mkdir(path: string): Promise<void> {
    this.directories.add(path);
  }

  async read(path: string): Promise<string> {
    const content = this.textFiles.get(path);
    if (content === undefined) throw new Error(`File not found: ${path}`);
    return content;
  }

  async write(path: string, content: string): Promise<void> {
    this.textFiles.set(path, content);
  }
}

class FakeVault {
  adapter: FakeAdapter;
  private files = new Map<string, { file: TFile; content: string }>();

  constructor(adapter: FakeAdapter) {
    this.adapter = adapter;
  }

  getAbstractFileByPath(path: string): TFile | null {
    return this.files.get(path)?.file ?? null;
  }

  setText(path: string, content: string): TFile {
    const existing = this.files.get(path);
    if (existing) {
      existing.content = content;
      return existing.file;
    }
    const file = new TFile(path);
    file.stat.size = content.length;
    this.files.set(path, { file, content });
    return file;
  }

  async modify(file: TFile, content: string): Promise<void> {
    this.setText(file.path, content);
  }

  async create(path: string, content: string): Promise<void> {
    this.setText(path, content);
  }

  async cachedRead(file: TFile): Promise<string> {
    return this.files.get(file.path)?.content ?? '';
  }
}

describe('SyncLogService', () => {
  let adapter: FakeAdapter;
  let vault: FakeVault;
  let backupService: ConflictBackupService;
  let service: SyncLogService;

  beforeEach(() => {
    adapter = new FakeAdapter();
    vault = new FakeVault(adapter);
    backupService = new ConflictBackupService(vault as any);
    service = new SyncLogService(vault as any, { ...DEFAULT_SETTINGS }, backupService);
  });

  it('adds an entry and retrieves it', () => {
    const entry = service.addEntry('remote-overwrite', 'notes/test.md', {
      hasSnapshot: true,
      snapshotId: 'snap-1',
    });

    expect(entry).not.toBeNull();
    expect(entry!.type).toBe('remote-overwrite');
    expect(entry!.path).toBe('notes/test.md');
    expect(entry!.hasSnapshot).toBe(true);
    expect(entry!.snapshotId).toBe('snap-1');

    const entries = service.getEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe(entry!.id);
  });

  it('entries are ordered newest-first', () => {
    service.addEntry('local-send', 'a.md');
    service.addEntry('local-send', 'b.md');
    service.addEntry('local-send', 'c.md');

    const entries = service.getEntries();
    expect(entries[0].path).toBe('c.md');
    expect(entries[2].path).toBe('a.md');
  });

  it('respects maxSyncLogEntries', () => {
    const settings = { ...DEFAULT_SETTINGS, maxSyncLogEntries: 3 };
    const svc = new SyncLogService(vault as any, settings, backupService);

    for (let i = 0; i < 5; i++) {
      svc.addEntry('remote-overwrite', `file-${i}.md`);
    }

    expect(svc.getEntries()).toHaveLength(3);
    expect(svc.getEntries()[0].path).toBe('file-4.md');
  });

  it('returns null when sync log is disabled', () => {
    const settings = { ...DEFAULT_SETTINGS, enableSyncLog: false };
    const svc = new SyncLogService(vault as any, settings, backupService);

    const entry = svc.addEntry('remote-overwrite', 'test.md');
    expect(entry).toBeNull();
    expect(svc.getEntries()).toHaveLength(0);
  });

  it('deduplicates local-send for same path within 10s', () => {
    service.addEntry('local-send', 'test.md');
    service.addEntry('local-send', 'test.md'); // should be deduped
    service.addEntry('local-send', 'other.md'); // different path, should pass

    expect(service.getEntries()).toHaveLength(2);
    expect(service.getEntries().map(e => e.path)).toEqual(['other.md', 'test.md']);
  });

  it('persists to disk and loads back', async () => {
    service.addEntry('remote-overwrite', 'notes/hello.md', {
      snapshotId: 'snap-123',
      hasSnapshot: true,
    });
    service.addEntry('local-send', 'notes/world.md');

    await service.saveToDisk();

    // Create new service and load from disk
    const svc2 = new SyncLogService(vault as any, { ...DEFAULT_SETTINGS }, backupService);
    await svc2.loadFromDisk();

    expect(svc2.getEntries()).toHaveLength(2);
    expect(svc2.getEntries()[0].path).toBe('notes/world.md');
    expect(svc2.getEntries()[1].snapshotId).toBe('snap-123');
  });

  it('loadFromDisk handles missing file gracefully', async () => {
    await service.loadFromDisk();
    expect(service.getEntries()).toHaveLength(0);
  });

  it('loadFromDisk handles corrupt JSON gracefully', async () => {
    adapter.textFiles.set(SYNC_LOG_FILE_PATH, 'not json');
    await service.loadFromDisk();
    expect(service.getEntries()).toHaveLength(0);
  });

  it('clearAll removes all entries and persists', async () => {
    service.addEntry('remote-overwrite', 'test.md');
    service.addEntry('local-send', 'other.md');
    expect(service.getEntries()).toHaveLength(2);

    await service.clearAll();
    expect(service.getEntries()).toHaveLength(0);

    // Verify persisted
    const raw = adapter.textFiles.get(SYNC_LOG_FILE_PATH);
    expect(raw).toBeDefined();
    expect(JSON.parse(raw!)).toEqual([]);
  });

  it('calls onChange callback when entry is added', () => {
    const cb = vi.fn();
    service.onChange(cb);

    service.addEntry('remote-overwrite', 'test.md');
    expect(cb).toHaveBeenCalledTimes(1);

    service.addEntry('local-send', 'other.md');
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it('reads snapshot content from backup service', async () => {
    // Create a backup via the backup service
    const backup = await backupService.backupTextFile(
      'notes/data.md',
      'original content here',
      'test-reason',
    );
    expect(backup).not.toBeNull();

    const entry = service.addEntry('remote-overwrite', 'notes/data.md', {
      snapshotId: backup!.backupId,
      hasSnapshot: true,
    });

    const content = await service.readSnapshotContent(entry!);
    expect(content).toBe('original content here');
  });

  it('readSnapshotContent returns null for entries without snapshotId', async () => {
    const entry = service.addEntry('local-send', 'test.md')!;
    const content = await service.readSnapshotContent(entry);
    expect(content).toBeNull();
  });

  it('restores text file from snapshot', async () => {
    // Create a file and back it up
    vault.setText('notes/restore-me.md', 'original');
    const backup = await backupService.backupTextFile(
      'notes/restore-me.md',
      'original',
      'test-backup',
    );

    // Overwrite the file
    vault.setText('notes/restore-me.md', 'overwritten content');

    const entry = service.addEntry('remote-overwrite', 'notes/restore-me.md', {
      snapshotId: backup!.backupId,
      hasSnapshot: true,
      details: { isText: true },
    })!;

    const success = await service.restoreFromSnapshot(entry);
    expect(success).toBe(true);
    const restored = await vault.cachedRead(vault.getAbstractFileByPath('notes/restore-me.md')! as TFile);
    expect(restored).toBe('original');
  });

  it('restores a deleted file from snapshot', async () => {
    // Create backup before the file is "deleted"
    const backup = await backupService.backupTextFile(
      'notes/deleted.md',
      'was here',
      'test-backup',
    );

    // File is now gone (not in vault)
    const entry = service.addEntry('remote-delete', 'notes/deleted.md', {
      snapshotId: backup!.backupId,
      hasSnapshot: true,
      details: { isText: true },
    })!;

    const success = await service.restoreFromSnapshot(entry);
    expect(success).toBe(true);

    // File should now exist again
    const file = vault.getAbstractFileByPath('notes/deleted.md');
    expect(file).not.toBeNull();
  });

  it('restoreFromSnapshot returns false without snapshotId', async () => {
    const entry = service.addEntry('local-send', 'test.md')!;
    const success = await service.restoreFromSnapshot(entry);
    expect(success).toBe(false);
  });

  it('flush cancels pending save timer and writes immediately', async () => {
    service.addEntry('remote-overwrite', 'test.md');
    // Before flush, the debounced save hasn't fired
    expect(adapter.textFiles.has(SYNC_LOG_FILE_PATH)).toBe(false);

    await service.flush();
    expect(adapter.textFiles.has(SYNC_LOG_FILE_PATH)).toBe(true);
    const data = JSON.parse(adapter.textFiles.get(SYNC_LOG_FILE_PATH)!);
    expect(data).toHaveLength(1);
  });
});
