import { describe, expect, it, vi } from 'vitest';
import { TFile } from 'obsidian';
import { BinaryFileSyncService } from '../../src/binary-sync/binary-sync-service';

class FakeVault {
  adapter = {
    exists: vi.fn().mockResolvedValue(true),
    mkdir: vi.fn().mockResolvedValue(undefined),
  };

  private files = new Map<string, { file: TFile; content: Uint8Array }>();

  setBinary(path: string, content: number[]): TFile {
    const entry = this.files.get(path);
    const nextContent = new Uint8Array(content);
    if (entry) {
      entry.content = nextContent;
      entry.file.stat.size = nextContent.byteLength;
      return entry.file;
    }

    const file = new TFile(path);
    file.stat.size = nextContent.byteLength;
    this.files.set(path, { file, content: nextContent });
    return file;
  }

  getAbstractFileByPath(path: string): TFile | null {
    return this.files.get(path)?.file ?? null;
  }

  async readBinary(file: TFile): Promise<ArrayBuffer> {
    const content = this.files.get(file.path)?.content ?? new Uint8Array();
    return content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength) as ArrayBuffer;
  }

  async modifyBinary(file: TFile, content: ArrayBuffer): Promise<void> {
    this.files.set(file.path, {
      file,
      content: new Uint8Array(content),
    });
  }

  async createBinary(path: string, content: ArrayBuffer): Promise<void> {
    this.setBinary(path, Array.from(new Uint8Array(content)));
  }

  async delete(file: TFile): Promise<void> {
    this.files.delete(file.path);
  }

  async rename(file: TFile, newPath: string): Promise<void> {
    const entry = this.files.get(file.path);
    if (!entry) return;

    this.files.delete(file.path);
    file.path = newPath;
    this.files.set(newPath, {
      file,
      content: entry.content,
    });
  }
}

describe('BinaryFileSyncService conflict backups', () => {
  it('backs up existing content before remote overwrite', async () => {
    const vault = new FakeVault();
    vault.setBinary('assets/file.bin', [1, 2, 3]);

    const backupBinaryFile = vi.fn().mockResolvedValue({
      contentPath: '.obsidian/plugins/lan-sync/conflicts/mock/files/assets/file.bin',
    });
    const service = new BinaryFileSyncService(
      vault as any,
      { broadcast: vi.fn(), sendTo: vi.fn() } as any,
      { backupBinaryFile } as any,
    );

    await (service as any)._receiveFile('assets/file.bin', new Uint8Array([9, 9, 9]), Date.now());

    expect(backupBinaryFile).toHaveBeenCalledWith(
      'assets/file.bin',
      new Uint8Array([1, 2, 3]),
      'remote-file-overwrite',
      {
        incomingSize: 3,
        existingSize: 3,
      },
    );
  });

  it('backs up existing content before remote delete', async () => {
    const vault = new FakeVault();
    vault.setBinary('assets/file.bin', [4, 5, 6]);

    const backupBinaryFile = vi.fn().mockResolvedValue({
      contentPath: '.obsidian/plugins/lan-sync/conflicts/mock/files/assets/file.bin',
    });
    const service = new BinaryFileSyncService(
      vault as any,
      { broadcast: vi.fn(), sendTo: vi.fn() } as any,
      { backupBinaryFile } as any,
    );

    await (service as any)._deleteFile('assets/file.bin');

    expect(backupBinaryFile).toHaveBeenCalledWith(
      'assets/file.bin',
      new Uint8Array([4, 5, 6]),
      'remote-file-delete',
      {
        size: 3,
      },
    );
    expect(vault.getAbstractFileByPath('assets/file.bin')).toBeNull();
  });

  it('aborts remote overwrite when backup creation fails', async () => {
    const vault = new FakeVault();
    vault.setBinary('assets/file.bin', [1, 2, 3]);

    const backupBinaryFile = vi.fn().mockResolvedValue(null);
    const service = new BinaryFileSyncService(
      vault as any,
      { broadcast: vi.fn(), sendTo: vi.fn() } as any,
      { backupBinaryFile } as any,
    );

    await (service as any)._receiveFile('assets/file.bin', new Uint8Array([9, 9, 9]), Date.now());

    const content = new Uint8Array(await vault.readBinary(vault.getAbstractFileByPath('assets/file.bin')!));
    expect(Array.from(content)).toEqual([1, 2, 3]);
  });

  it('backs up rename target before remote rename overwrite', async () => {
    const vault = new FakeVault();
    vault.setBinary('assets/source.bin', [1, 2, 3]);
    vault.setBinary('assets/target.bin', [7, 8, 9]);

    const backupBinaryFile = vi.fn().mockResolvedValue({
      contentPath: '.obsidian/plugins/lan-sync/conflicts/mock/files/assets/target.bin',
    });
    const service = new BinaryFileSyncService(
      vault as any,
      { broadcast: vi.fn(), sendTo: vi.fn() } as any,
      { backupBinaryFile } as any,
    );

    await (service as any)._renameFile('assets/source.bin', 'assets/target.bin');

    expect(backupBinaryFile).toHaveBeenCalledWith(
      'assets/target.bin',
      new Uint8Array([7, 8, 9]),
      'remote-file-rename-overwrite',
      {
        oldPath: 'assets/source.bin',
        newPath: 'assets/target.bin',
        size: 3,
      },
    );
  });

  it('aborts remote rename overwrite when target backup creation fails', async () => {
    const vault = new FakeVault();
    vault.setBinary('assets/source.bin', [1, 2, 3]);
    vault.setBinary('assets/target.bin', [7, 8, 9]);

    const backupBinaryFile = vi.fn().mockResolvedValue(null);
    const service = new BinaryFileSyncService(
      vault as any,
      { broadcast: vi.fn(), sendTo: vi.fn() } as any,
      { backupBinaryFile } as any,
    );

    await (service as any)._renameFile('assets/source.bin', 'assets/target.bin');

    expect(vault.getAbstractFileByPath('assets/source.bin')).not.toBeNull();
    const targetContent = new Uint8Array(await vault.readBinary(vault.getAbstractFileByPath('assets/target.bin')!));
    expect(Array.from(targetContent)).toEqual([7, 8, 9]);
  });

  it('still reports remote rename intent when source file is missing', async () => {
    const vault = new FakeVault();
    const onRemoteFileRenamed = vi.fn().mockResolvedValue(undefined);
    const service = new BinaryFileSyncService(
      vault as any,
      { broadcast: vi.fn(), sendTo: vi.fn() } as any,
      { backupBinaryFile: vi.fn() } as any,
    );
    service.onRemoteFileRenamed(onRemoteFileRenamed);

    await (service as any)._renameFile('Untitled.md', 'note.md');

    expect(onRemoteFileRenamed).toHaveBeenCalledWith('Untitled.md', 'note.md');
  });
});

describe('BinaryFileSyncService received bytes', () => {
  it('writes only the file bytes when the message is a view into a larger buffer', async () => {
    const { encodeFileData, decodeMessage } = await import('../../src/transport/protocol');
    const { toUint8Array } = await import('../../src/transport/socket');
    const { MessageType } = await import('../../src/types');

    // ws hands out Node Buffers that are views into one shared chunk buffer.
    const frame = encodeFileData({ path: 'img/图.png', content: new Uint8Array([1, 2, 0, 255]), mtime: 1 });
    const chunk = Buffer.concat([Buffer.from('other-message-bytes'), Buffer.from(frame), Buffer.from('tail')]);
    const view = chunk.subarray(19, 19 + frame.length);

    const vault = new FakeVault();
    const service = new BinaryFileSyncService(
      vault as any,
      { broadcast: vi.fn(), sendTo: vi.fn() } as any,
      { backupBinaryFile: vi.fn() } as any,
    );
    const msg = decodeMessage(await toUint8Array(view));
    await service.handleMessage('peer', MessageType.FILE_DATA, msg.payload);

    const file = vault.getAbstractFileByPath('img/图.png')!;
    expect(Array.from(new Uint8Array(await vault.readBinary(file)))).toEqual([1, 2, 0, 255]);
  });
});
