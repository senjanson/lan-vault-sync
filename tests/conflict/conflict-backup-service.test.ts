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

  it('makes a backup\'s folders without looking each one up, and again after they were removed', async () => {
    // Folders are made one level at a time, as on storage where mkdir is not recursive.
    const adapter = new FakeAdapter();
    let lookups = 0;
    const exists = adapter.exists.bind(adapter);
    adapter.exists = async (p: string) => (lookups++, exists(p));
    adapter.mkdir = async (p: string) => {
      const parent = p.slice(0, p.lastIndexOf('/'));
      if (adapter.directories.has(p) || (p.includes('/') && !adapter.directories.has(parent))) throw new Error(`mkdir ${p}`);
      adapter.directories.add(p);
    };
    const service = new ConflictBackupService({ adapter } as any);

    await service.backupBinaryFile('a/b/c.png', new Uint8Array([1]), 'remote-file-delete');
    lookups = 0;
    const second = await service.backupBinaryFile('a/b/d.png', new Uint8Array([2]), 'remote-file-delete');
    expect(lookups).toBe(0);
    expect(Array.from(adapter.binaryFiles.get(second!.contentPath)!)).toEqual([2]);

    for (const dir of [...adapter.directories]) if (dir.startsWith(CONFLICT_BACKUP_DIR)) adapter.directories.delete(dir);
    const third = await service.backupTextFile('e.md', 'text', 'text-remote-overwrite');
    expect(adapter.textFiles.get(third!.contentPath)).toBe('text');
  });

  it('makes a backup\'s folders with one call where the adapter makes missing parents', async () => {
    // Like Obsidian's adapters: mkdir makes the parents, a write needs its folder.
    const adapter = new FakeAdapter();
    let mkdirs = 0;
    adapter.mkdir = async (p: string) => {
      mkdirs++;
      for (let at = p.indexOf('/'); at > 0; at = p.indexOf('/', at + 1)) adapter.directories.add(p.slice(0, at));
      adapter.directories.add(p);
    };
    const write = adapter.writeBinary.bind(adapter);
    adapter.writeBinary = async (p: string, d: ArrayBuffer) => {
      if (!adapter.directories.has(p.slice(0, p.lastIndexOf('/')))) throw new Error(`no folder for ${p}`);
      return write(p, d);
    };
    const service = new ConflictBackupService({ adapter } as any);

    await service.backupBinaryFile('a/b/c.png', new Uint8Array([1]), 'remote-file-delete');
    mkdirs = 0;
    const second = await service.backupBinaryFile('x/y/z/d.png', new Uint8Array([2]), 'remote-file-delete');
    expect(mkdirs).toBe(1);
    expect(Array.from(adapter.binaryFiles.get(second!.contentPath)!)).toEqual([2]);
  });
});
