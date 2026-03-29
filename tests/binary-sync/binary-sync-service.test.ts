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
});
