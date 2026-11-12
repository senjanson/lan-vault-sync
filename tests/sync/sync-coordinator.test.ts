import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TFile } from 'obsidian';
import { decodeMessage, decodeYjsSync, encodeYjsSync } from '../../src/transport/protocol';
import { SyncCoordinator } from '../../src/sync/sync-coordinator';
import { DEFAULT_SETTINGS, MessageType, type FileMetaSyncPayload } from '../../src/types';

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

  getFiles(): TFile[] {
    return Array.from(this.files.values()).map((entry) => entry.file);
  }

  async cachedRead(file: TFile): Promise<string> {
    return this.files.get(file.path)?.content ?? '';
  }

  async readBinary(file: TFile): Promise<ArrayBuffer> {
    const text = this.files.get(file.path)?.content ?? '';
    const bytes = new TextEncoder().encode(text);
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
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
    const applyRemoteUpdate = vi.fn().mockResolvedValue(true);
    const flushPendingLocalTextChange = vi
      .spyOn(coordinator as any, '_flushPendingLocalTextChange')
      .mockResolvedValue(true);

    (coordinator as any).docManager = {
      applyRelatedUpdate: applyRemoteUpdate,
      isDocSeeded: vi.fn().mockReturnValue(true),
    };

    const payload = decodeMessage(
      encodeYjsSync(MessageType.YJS_UPDATE, 'note.md', new Uint8Array([1, 2, 3])),
    ).payload;

    await (coordinator as any)._handleMessage('peer-1', MessageType.YJS_UPDATE, payload);

    expect(flushPendingLocalTextChange).toHaveBeenCalledWith('note.md');
    expect(applyRemoteUpdate).toHaveBeenCalledWith('note.md', new Uint8Array([1, 2, 3]), 'peer-1');
    expect(flushPendingLocalTextChange.mock.invocationCallOrder[0]).toBeLessThan(
      applyRemoteUpdate.mock.invocationCallOrder[0],
    );
  });

  it('prefers watcher-provided text content for local modify events', async () => {
    const applyLocalChange = vi.fn().mockResolvedValue(undefined);
    const cachedRead = vi.fn().mockRejectedValue(new Error('should not read vault'));

    (coordinator as any).vault.cachedRead = cachedRead;
    (coordinator as any).docManager = {
      applyLocalChange,
    };
    (coordinator as any).binarySync = {
      broadcastFileChange: vi.fn(),
    };

    await (coordinator as any)._handleLocalFileChange({
      type: 'modify',
      path: 'note.md',
      isTextFile: true,
      timestamp: Date.now(),
      content: 'edited on iphone',
      source: 'editor',
    });

    expect(applyLocalChange).toHaveBeenCalledWith('note.md', 'edited on iphone');
    expect(cachedRead).not.toHaveBeenCalled();
  });

  it('writes the latest merged doc content after flushing pending local text', async () => {
    const applyLocalChange = vi.fn().mockResolvedValue(undefined);
    const getContent = vi.fn().mockResolvedValue('merged content');
    const markRemoteWrite = vi.fn();
    const backupTextFile = vi.fn().mockResolvedValue({
      contentPath: '.obsidian/plugins/lan-sync/conflicts/mock/files/note.md',
    });

    (coordinator as any).watcher = {
      consumePendingModify: vi.fn().mockReturnValue(true),
      takePendingModify: vi.fn().mockReturnValue({}),
      markRemoteWrite,
    };
    (coordinator as any).docManager = {
      applyLocalChange,
      getContent,
    };
    (coordinator as any).backupService = {
      backupTextFile,
    };

    await (coordinator as any)._writeFileFromRemote(
      'note.md',
      'stale remote content',
      'server previous',
    );

    expect(applyLocalChange).toHaveBeenCalledWith('note.md', 'local pending');
    expect(getContent).toHaveBeenCalledWith('note.md');
    expect(backupTextFile).toHaveBeenCalledWith(
      'note.md',
      'local pending',
      'text-remote-overwrite',
      {
        previousContent: 'server previous',
        mergedContent: 'merged content',
      },
    );
    expect(markRemoteWrite).toHaveBeenCalledWith('note.md');
    expect(await vault.cachedRead(vault.getFile('note.md')!)).toBe('merged content');
  });

  it('aborts remote text overwrite when conflict backup cannot be created', async () => {
    const applyLocalChange = vi.fn().mockResolvedValue(undefined);
    const getContent = vi.fn().mockResolvedValue('merged content');
    const markRemoteWrite = vi.fn();
    const backupTextFile = vi.fn().mockResolvedValue(null);

    (coordinator as any).watcher = {
      consumePendingModify: vi.fn().mockReturnValue(true),
      takePendingModify: vi.fn().mockReturnValue({}),
      markRemoteWrite,
    };
    (coordinator as any).docManager = {
      applyLocalChange,
      getContent,
    };
    (coordinator as any).backupService = {
      backupTextFile,
    };

    await (coordinator as any)._writeFileFromRemote(
      'note.md',
      'stale remote content',
      'server previous',
    );

    expect(backupTextFile).toHaveBeenCalled();
    expect(markRemoteWrite).not.toHaveBeenCalled();
    expect(await vault.cachedRead(vault.getFile('note.md')!)).toBe('local pending');
  });

  it('requests remote-only text files through Yjs state sync', async () => {
    const sendTo = vi.fn();
    const buildFileTreeModule = await import('../../src/sync/file-tree');
    const buildSpy = vi.spyOn(buildFileTreeModule, 'buildFileTree');

    vault.setText('local.md', 'local');
    (coordinator as any).connectionManager = { sendTo };
    (coordinator as any).docManager = {
      removeDoc: vi.fn().mockResolvedValue(undefined),
      hasDocState: vi.fn().mockResolvedValue(false),
      crdtDigest: vi.fn().mockResolvedValue(undefined),
    };
    buildSpy.mockResolvedValueOnce({
      files: new Map([
        ['local.md', { path: 'local.md', hash: 'local-hash', mtime: 1, size: 5, isTextFile: true }],
      ]),
      timestamp: Date.now(),
    });

    const remoteTree: FileMetaSyncPayload = {
      files: [
        { path: 'local.md', hash: 'local-hash', mtime: 1, size: 5, isTextFile: true },
        { path: 'remote.md', hash: 'remote-hash', mtime: 2, size: 6, isTextFile: true },
      ],
    };

    await (coordinator as any)._handleRemoteFileTree('peer-1', remoteTree);

    expect(sendTo).toHaveBeenCalledTimes(1);
    expect(sendTo.mock.calls[0][0]).toBe('peer-1');

    const outbound = decodeMessage(sendTo.mock.calls[0][1]);
    expect(outbound.type).toBe(MessageType.YJS_SYNC_STEP1);
    expect(decodeYjsSync(outbound.payload).filePath).toBe('remote.md');
    buildSpy.mockRestore();
  });

  it('sends full text state for local-only text files', async () => {
    const sendTo = vi.fn();
    const sendFullTextState = vi
      .spyOn(coordinator as any, '_sendFullTextState')
      .mockResolvedValue(undefined);
    const buildFileTreeModule = await import('../../src/sync/file-tree');
    const buildSpy = vi.spyOn(buildFileTreeModule, 'buildFileTree');

    (coordinator as any).connectionManager = { sendTo };
    buildSpy.mockResolvedValueOnce({
      files: new Map([
        ['note.md', { path: 'note.md', hash: 'local-hash', mtime: 1, size: 13, isTextFile: true }],
      ]),
      timestamp: Date.now(),
    });

    const remoteTree: FileMetaSyncPayload = {
      files: [],
    };

    await (coordinator as any)._handleRemoteFileTree('peer-1', remoteTree);

    expect(sendFullTextState).toHaveBeenCalledWith('peer-1', 'note.md', 'Sending text state');
    expect(sendTo).not.toHaveBeenCalled();
    buildSpy.mockRestore();
  });

  it('bootstraps identical text files once during initial peer sync', async () => {
    const sendFullTextState = vi
      .spyOn(coordinator as any, '_sendFullTextState')
      .mockResolvedValue(undefined);

    (coordinator as any).pendingInitialBootstrapPeers.add('peer-z');

    const remoteTree: FileMetaSyncPayload = {
      files: [
        { path: 'note.md', hash: 'same-hash', mtime: 1, size: 13, isTextFile: true },
      ],
    };

    vi.spyOn(coordinator as any, '_shouldBootstrapSharedTextState').mockReturnValue(true);
    vi.spyOn(coordinator as any, '_emitEvent').mockImplementation(() => {});

    const buildFileTreeModule = await import('../../src/sync/file-tree');
    const buildSpy = vi.spyOn(buildFileTreeModule, 'buildFileTree');
    buildSpy.mockResolvedValueOnce({
      files: new Map([
        ['note.md', { path: 'note.md', hash: 'same-hash', mtime: 1, size: 13, isTextFile: true }],
      ]),
      timestamp: Date.now(),
    });

    await (coordinator as any)._handleRemoteFileTree('peer-z', remoteTree);

    expect(sendFullTextState).toHaveBeenCalledWith('peer-z', 'note.md', 'Bootstrapping shared text state');
    expect((coordinator as any).pendingInitialBootstrapPeers.has('peer-z')).toBe(false);

    buildSpy.mockRestore();
  });

  it('marks the local side as conflict loser when remote text wins without shared history', async () => {
    const buildFileTreeModule = await import('../../src/sync/file-tree');
    const buildSpy = vi.spyOn(buildFileTreeModule, 'buildFileTree');
    const sendTo = vi.fn();
    const consumePendingModify = vi.fn();
    const backupTextFile = vi.fn().mockResolvedValue({
      contentPath: '.obsidian/plugins/lan-sync/conflicts/mock/files/note.md',
    });

    vault.setText('note.md', 'local version');
    const localFile = vault.getFile('note.md')!;
    localFile.stat.mtime = 10;

    (coordinator as any).connectionManager = { sendTo };
    (coordinator as any).watcher = {
      consumePendingModify,
      takePendingModify: vi.fn().mockReturnValue(null),
      markRemoteWrite: vi.fn(),
    };
    (coordinator as any).backupService = {
      backupTextFile,
    };
    (coordinator as any).docManager = {
      hasDocState: vi.fn().mockResolvedValue(false),
      crdtDigest: vi.fn().mockResolvedValue(undefined),
    };

    buildSpy.mockResolvedValueOnce({
      files: new Map([
        ['note.md', { path: 'note.md', hash: 'local-hash', mtime: 10, size: 13, isTextFile: true }],
      ]),
      timestamp: Date.now(),
    });

    const remoteTree: FileMetaSyncPayload = {
      files: [
        { path: 'note.md', hash: 'remote-hash', mtime: 20, size: 14, isTextFile: true },
      ],
    };

    await (coordinator as any)._handleRemoteFileTree('peer-1', remoteTree);

    expect(consumePendingModify).toHaveBeenCalledWith('note.md');
    expect((coordinator as any)._hasConflictLoserGuard('note.md')).toBe(true);
    expect(sendTo).not.toHaveBeenCalled();
    buildSpy.mockRestore();
  });

  it('removes CRDT state after a remote text delete succeeds', async () => {
    const removeDoc = vi.fn().mockResolvedValue(undefined);
    (coordinator as any).docManager = { removeDoc };

    await (coordinator as any).binarySync.onRemoteFileDeletedCb?.('note.md');

    expect(removeDoc).toHaveBeenCalledWith('note.md');
  });

  it('renames CRDT state after a remote text rename succeeds', async () => {
    const renameDoc = vi.fn().mockResolvedValue(undefined);
    (coordinator as any).docManager = { renameDoc, removeDoc: vi.fn() };

    await (coordinator as any).binarySync.onRemoteFileRenamedCb?.('old.md', 'new.md');

    expect(renameDoc).toHaveBeenCalledWith('old.md', 'new.md');
  });

  it('redirects stale old-path text updates after a remote rename intent', async () => {
    const applyRemoteUpdate = vi.fn().mockResolvedValue(true);
    const renameDoc = vi.fn().mockResolvedValue(undefined);
    const flushPendingLocalTextChange = vi
      .spyOn(coordinator as any, '_flushPendingLocalTextChange')
      .mockResolvedValue(false);

    (coordinator as any).docManager = {
      applyRelatedUpdate: applyRemoteUpdate,
      isDocSeeded: vi.fn().mockReturnValue(true),
      renameDoc,
      removeDoc: vi.fn().mockResolvedValue(undefined),
    };

    await (coordinator as any).binarySync.onRemoteFileRenamedCb?.('Untitled.md', 'note.md');

    const payload = decodeMessage(
      encodeYjsSync(
        MessageType.YJS_UPDATE,
        'Untitled.md',
        new Uint8Array([1, 2, 3]),
      ),
    ).payload;

    await (coordinator as any)._handleMessage('peer-1', MessageType.YJS_UPDATE, payload);

    expect(flushPendingLocalTextChange).toHaveBeenCalledWith('note.md');
    expect(applyRemoteUpdate).toHaveBeenCalledWith('note.md', new Uint8Array([1, 2, 3]), 'peer-1');
  });

  it('migrates CRDT state on local text rename instead of deleting it', async () => {
    const renameDoc = vi.fn().mockResolvedValue(undefined);
    const removeDoc = vi.fn().mockResolvedValue(undefined);
    (coordinator as any).docManager = { renameDoc, removeDoc };
    (coordinator as any).binarySync = {
      broadcastFileRename: vi.fn(),
    };

    await (coordinator as any)._handleLocalFileChange({
      type: 'rename',
      path: 'new.md',
      oldPath: 'old.md',
      isTextFile: true,
      timestamp: Date.now(),
    });

    expect(renameDoc).toHaveBeenCalledWith('old.md', 'new.md');
    expect(removeDoc).not.toHaveBeenCalled();
  });

  it('serializes local create and rename events to preserve ordering', async () => {
    let resolveRead!: (value: string) => void;
    const cachedRead = vi.fn().mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolveRead = resolve;
        }),
    );
    const applyLocalChange = vi.fn().mockResolvedValue(undefined);
    const renameDoc = vi.fn().mockResolvedValue(undefined);
    const broadcastFileRename = vi.fn();

    vault.setText('Untitled.md', '# title');
    vault.setText('note-a.md', '# title');
    (coordinator as any).vault.cachedRead = cachedRead;
    (coordinator as any).docManager = {
      applyLocalChange,
      renameDoc,
      removeDoc: vi.fn().mockResolvedValue(undefined),
    };
    (coordinator as any).binarySync = {
      broadcastFileRename,
    };

    const createTask = (coordinator as any)._enqueueLocalFileChange({
      type: 'create',
      path: 'Untitled.md',
      isTextFile: true,
      timestamp: Date.now(),
    });
    const renameTask = (coordinator as any)._enqueueLocalFileChange({
      type: 'rename',
      path: 'note-a.md',
      oldPath: 'Untitled.md',
      isTextFile: true,
      timestamp: Date.now(),
    });

    await Promise.resolve();
    expect(renameDoc).not.toHaveBeenCalled();
    expect(broadcastFileRename).not.toHaveBeenCalled();

    resolveRead('# title');
    await createTask;
    await renameTask;

    expect(applyLocalChange).toHaveBeenCalledWith('Untitled.md', '# title');
    expect(renameDoc).toHaveBeenCalledWith('Untitled.md', 'note-a.md');
    expect(broadcastFileRename).toHaveBeenCalledWith('Untitled.md', 'note-a.md');
    expect(applyLocalChange.mock.invocationCallOrder[0]).toBeLessThan(
      renameDoc.mock.invocationCallOrder[0],
    );
  });

  it('only clears conflict-loser guards for the disconnected peer', () => {
    (coordinator as any)._addConflictLoserGuard('shared.md', 'peer-1');
    (coordinator as any)._addConflictLoserGuard('shared.md', 'peer-2');
    (coordinator as any)._addConflictLoserGuard('only-peer-1.md', 'peer-1');

    (coordinator as any)._clearConflictLoserGuardsForDevice('peer-1');

    expect((coordinator as any)._hasConflictLoserGuard('shared.md')).toBe(true);
    expect((coordinator as any)._hasConflictLoserGuard('only-peer-1.md')).toBe(false);
  });

  it('clears conflict-loser guard after remote text delete', async () => {
    const removeDoc = vi.fn().mockResolvedValue(undefined);
    (coordinator as any).docManager = { removeDoc };
    (coordinator as any)._addConflictLoserGuard('note.md', 'peer-1');

    await (coordinator as any).binarySync.onRemoteFileDeletedCb?.('note.md');

    expect((coordinator as any)._hasConflictLoserGuard('note.md')).toBe(false);
  });
});

describe('SyncCoordinator open editor writes', () => {
  function fakeEditor(initial: string) {
    let value = initial;
    const offsetToPos = (offset: number) => offset;
    return {
      getValue: () => value,
      offsetToPos,
      transaction: vi.fn(({ changes }: { changes: Array<{ from: number; to?: number; text: string }> }) => {
        for (const change of [...changes].sort((a, b) => b.from - a.from)) {
          value = value.slice(0, change.from) + change.text + value.slice(change.to ?? change.from);
        }
      }),
    };
  }

  it('applies a peer edit to the open editor instead of rewriting the file under unsaved typing', async () => {
    const vault = new FakeVault();
    vault.setText('note.md', 'L1\nL2\n');
    const editor = fakeEditor('L1\nL2\n');
    const workspace = {
      on: vi.fn(),
      offref: vi.fn(),
      getLeavesOfType: () => [{ view: { file: { path: 'note.md' }, editor } }],
    };
    const coordinator = new SyncCoordinator(
      vault as any,
      { ...DEFAULT_SETTINGS, deviceId: 'device-a', deviceName: 'Device A', manualPeers: [] },
      { workspace: workspace as any },
    );
    const docManager = (coordinator as any).docManager;
    await docManager.applyLocalChange('note.md', 'L1\nL2\n');
    docManager.markWritten('note.md', 'L1\nL2\n');

    // A peer appends to line 2 while the user types on line 1 (not yet saved).
    const peer = new (await import('yjs')).Doc();
    const Y = await import('yjs');
    Y.applyUpdate(peer, await docManager.encodeFullState('note.md'));
    peer.getText('content').insert(5, ' B');
    const update = Y.encodeStateAsUpdate(peer, await docManager.encodeSyncStep1('note.md'));
    editor.transaction({ changes: [{ from: 2, text: ' C' }] });
    const modify = vi.spyOn(vault, 'modify');

    await docManager.applyRemoteUpdate('note.md', update, 'peer-1');

    expect(modify).not.toHaveBeenCalled();
    expect(editor.getValue()).toBe('L1 C\nL2 B\n');
    expect(await docManager.getContent('note.md')).toBe('L1 C\nL2 B\n');
  });
});
