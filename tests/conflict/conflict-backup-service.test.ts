import { describe, expect, it } from 'vitest';
import { ConflictBackupService } from '../../src/conflict/conflict-backup-service';
import { CONFLICT_BACKUP_DIR } from '../../src/constants';

class FakeAdapter {
  textFiles = new Map<string, string>();
  binaryFiles = new Map<string, Uint8Array>();
  directories = new Set<string>();

  async exists(path: string): Promise<boolean> {
    return this.directories.has(path) || this.textFiles.has(path) || this.binaryFiles.has(path);
  }

  async mkdir(path: string): Promise<void> {
    this.directories.add(path);
  }

  async write(path: string, content: string): Promise<void> {
    this.textFiles.set(path, content);
  }

  async writeBinary(path: string, content: ArrayBuffer): Promise<void> {
    this.binaryFiles.set(path, new Uint8Array(content));
  }
}

describe('ConflictBackupService', () => {
  it('stores text backups with metadata', async () => {
    const adapter = new FakeAdapter();
    const service = new ConflictBackupService({ adapter } as any);

    const result = await service.backupTextFile(
      'notes/demo.md',
      'draft content',
      'text-remote-overwrite',
      { mergedContent: 'server content' },
    );

    expect(result).not.toBeNull();
    expect(result!.backupDir.startsWith(CONFLICT_BACKUP_DIR)).toBe(true);
    expect(adapter.textFiles.get(result!.contentPath)).toBe('draft content');

    const metadata = JSON.parse(adapter.textFiles.get(result!.metadataPath)!);
    expect(metadata.originalPath).toBe('notes/demo.md');
    expect(metadata.reason).toBe('text-remote-overwrite');
    expect(metadata.details.mergedContent).toBe('server content');
  });

  it('stores binary backups alongside metadata', async () => {
    const adapter = new FakeAdapter();
    const service = new ConflictBackupService({ adapter } as any);

    const result = await service.backupBinaryFile(
      'assets/image.png',
      new Uint8Array([1, 2, 3, 4]),
      'remote-file-delete',
      { size: 4 },
    );

    expect(result).not.toBeNull();
    expect(Array.from(adapter.binaryFiles.get(result!.contentPath)!)).toEqual([1, 2, 3, 4]);

    const metadata = JSON.parse(adapter.textFiles.get(result!.metadataPath)!);
    expect(metadata.originalPath).toBe('assets/image.png');
    expect(metadata.kind).toBe('binary');
    expect(metadata.reason).toBe('remote-file-delete');
  });
});
