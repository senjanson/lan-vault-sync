import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TFile } from 'obsidian';
import { decodeMessage, encodeYjsSync } from '../../src/transport/protocol';
import { SyncCoordinator } from '../../src/sync/sync-coordinator';
import { DEFAULT_SETTINGS, MessageType } from '../../src/types';

class FakeVault {
  adapter = {};
  private files = new Map<string, { file: TFile; content: string }>();

  getName(): string {
    return 'TestVault';
  }

  setText(path: string, content: string): TFile {
    const entry = this.files.get(path);
    if (entry) {
      entry.content = content;
      entry.file.stat.size = content.length;
      return entry.file;
    }

    const file = new TFile(path);
    file.stat.size = content.length;
    this.files.set(path, { file, content });
    return file;
  }

  getFile(path: string): TFile | null {
    return this.files.get(path)?.file ?? null;
  }

  getAbstractFileByPath(path: string): TFile | null {
    return this.getFile(path);
  }

  async cachedRead(file: TFile): Promise<string> {
    return this.files.get(file.path)?.content ?? '';
  }

  async modify(file: TFile, content: string): Promise<void> {
    this.setText(file.path, content);
  }

  async create(path: string, content: string): Promise<void> {
    this.setText(path, content);
  }
}

describe('SyncCoordinator text conflict safety', () => {
  let vault: FakeVault;
  let coordinator: SyncCoordinator;

  beforeEach(() => {
    vault = new FakeVault();
    vault.setText('note.md', 'local pending');

    coordinator = new SyncCoordinator(vault as any, {
      ...DEFAULT_SETTINGS,
      deviceId: 'device-a',
      deviceName: 'Device A',
      manualPeers: [],
    });
  });

  it('flushes pending local text before applying a remote Yjs update', async () => {
    const applyRemoteUpdate = vi.fn().mockResolvedValue(undefined);
    const flushPendingLocalTextChange = vi
      .spyOn(coordinator as any, '_flushPendingLocalTextChange')
      .mockResolvedValue(true);

    (coordinator as any).docManager = {
      applyRemoteUpdate,
    };

    const payload = decodeMessage(
      encodeYjsSync(MessageType.YJS_UPDATE, 'note.md', new Uint8Array([1, 2, 3])),
    ).payload;

    await (coordinator as any)._handleMessage('peer-1', MessageType.YJS_UPDATE, payload);

    expect(flushPendingLocalTextChange).toHaveBeenCalledWith('note.md');
    expect(applyRemoteUpdate).toHaveBeenCalledWith('note.md', new Uint8Array([1, 2, 3]));
    expect(flushPendingLocalTextChange.mock.invocationCallOrder[0]).toBeLessThan(
      applyRemoteUpdate.mock.invocationCallOrder[0],
    );
  });

  it('writes the latest merged doc content after flushing pending local text', async () => {
    const applyLocalChange = vi.fn().mockResolvedValue(undefined);
    const getContent = vi.fn().mockResolvedValue('merged content');
    const markRemoteWrite = vi.fn();

    (coordinator as any).watcher = {
      consumePendingModify: vi.fn().mockReturnValue(true),
      markRemoteWrite,
    };
    (coordinator as any).docManager = {
      applyLocalChange,
      getContent,
    };

    await (coordinator as any)._writeFileFromRemote('note.md', 'stale remote content');

    expect(applyLocalChange).toHaveBeenCalledWith('note.md', 'local pending');
    expect(getContent).toHaveBeenCalledWith('note.md');
    expect(markRemoteWrite).toHaveBeenCalledWith('note.md');
    expect(await vault.cachedRead(vault.getFile('note.md')!)).toBe('merged content');
  });
});
