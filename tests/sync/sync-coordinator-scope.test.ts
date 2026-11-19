/**
 * The coordinator's side of syncing only one folder (settings.syncFolder):
 * the file lists it sends and takes, the panel's notes about each
 * connection's folder, and changing the setting without losing files.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TFile, TFolder } from 'obsidian';
import { computeFileHash } from '../../src/binary-sync/file-hash';
import { FILE_INDEX_FILE } from '../../src/constants';
import { EventLog } from '../../src/diagnostics/event-log';
import { vaultDigest } from '../../src/diagnostics/health';
import { setLanguage } from '../../src/i18n';
import { SyncCoordinator } from '../../src/sync/sync-coordinator';
import { decodeJSON, decodeMessage } from '../../src/transport/protocol';
import {
  DEFAULT_SETTINGS,
  MessageType,
  type FileMeta,
  type FileMetaSyncPayload,
  type Tombstone,
} from '../../src/types';
import type { SyncScope } from '../../src/sync/sync-scope';

class MemAdapter {
  files = new Map<string, string>();
  dirs = new Set<string>();
  async exists(p: string): Promise<boolean> {
    return this.files.has(p) || this.dirs.has(p);
  }
  async read(p: string): Promise<string> {
    const v = this.files.get(p);
    if (v === undefined) throw new Error(`missing ${p}`);
    return v;
  }
  async write(p: string, data: string): Promise<void> {
    this.files.set(p, data);
  }
  async mkdir(p: string): Promise<void> {
    this.dirs.add(p);
  }
  async remove(p: string): Promise<void> {
    this.files.delete(p);
  }
  async rename(from: string, to: string): Promise<void> {
    this.files.set(to, this.files.get(from)!);
    this.files.delete(from);
  }
}

/** A vault with files and folders, kept in memory. */
class FakeVault {
  adapter: MemAdapter;
  private files = new Map<string, { file: TFile; content: string }>();
  private folders = new Map<string, TFolder>();

  constructor(adapter = new MemAdapter()) {
    this.adapter = adapter;
  }

  getName(): string {
    return 'TestVault';
  }

  put(path: string, content: string): void {
    const file = new TFile(path);
    file.stat.size = content.length;
    file.stat.mtime = 1000;
    this.files.set(path, { file, content });
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) this.addFolder(parts.slice(0, i).join('/'));
  }

  addFolder(path: string): void {
    if (!this.folders.has(path)) this.folders.set(path, new TFolder(path));
  }

  getAbstractFileByPath(path: string): TFile | TFolder | null {
    return this.files.get(path)?.file ?? this.folders.get(path) ?? null;
  }

  getFiles(): TFile[] {
    return [...this.files.values()].map((e) => e.file);
  }

  getAllLoadedFiles(): Array<TFile | TFolder> {
    return [...this.folders.values(), ...this.getFiles()];
  }

  async readBinary(file: TFile): Promise<ArrayBuffer> {
    const bytes = new TextEncoder().encode(this.files.get(file.path)?.content ?? '');
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  }

  async cachedRead(file: TFile): Promise<string> {
    return this.files.get(file.path)?.content ?? '';
  }

  async createFolder(path: string): Promise<void> {
    this.addFolder(path);
  }

  async delete(f: TFile | TFolder): Promise<void> {
    this.files.delete(f.path);
    this.folders.delete(f.path);
  }
}

async function hashOf(content: string): Promise<string> {
  const bytes = new TextEncoder().encode(content);
  return computeFileHash(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
}

async function meta(path: string, content: string): Promise<FileMeta> {
  return { path, hash: await hashOf(content), mtime: 1000, size: content.length, isTextFile: false };
}

interface Setup {
  vault: FakeVault;
  coordinator: SyncCoordinator;
  c: any;
  sendTo: ReturnType<typeof vi.fn>;
  broadcast: ReturnType<typeof vi.fn>;
  notePeerScope: ReturnType<typeof vi.fn>;
  events: string[];
}

/**
 * A coordinator on `vault` whose connection with peer-1 carries `scope`
 * (see ConnectionManager.connectionScope); `peerFolder` is what the peer
 * said in its handshake. Attachments only (.png), so no notes' histories.
 */
function setup(
  vault: FakeVault,
  syncFolder: string,
  connection: { scope?: SyncScope; peerFolder?: string } = {},
): Setup {
  const coordinator = new SyncCoordinator(
    vault as any,
    { ...DEFAULT_SETTINGS, deviceId: 'device-a', deviceName: 'Device A', manualPeers: [], syncFolder },
    { eventLog: new EventLog(null), deleteLimits: { inferredMin: 1000, inferredMax: 1000 } },
  );
  const c = coordinator as any;
  const sendTo = vi.fn();
  const broadcast = vi.fn();
  const cm: any = {
    sendTo,
    broadcast,
    getConnectedPeers: () => [{ deviceId: 'peer-1', deviceName: 'Phone' }],
    getConnectedPeerIds: () => ['peer-1'],
    getClockOffset: () => undefined,
    peerSyncFolder: () => connection.peerFolder,
  };
  if ('scope' in connection) cm.connectionScope = () => connection.scope;
  c.connectionManager = cm;
  c.docManager = {
    crdtDigest: vi.fn().mockResolvedValue(undefined),
    hasDocState: vi.fn().mockResolvedValue(false),
    removeDoc: vi.fn().mockResolvedValue(undefined),
    renameDoc: vi.fn().mockResolvedValue(undefined),
  };
  c.watcher = { markRemoteWrite: vi.fn(), consumePendingModify: vi.fn(), takePendingModify: vi.fn() };
  vi.spyOn(c.binarySync, 'requestFile').mockImplementation(() => undefined);
  vi.spyOn(c.binarySync, 'sendFileToPeer').mockResolvedValue(undefined);
  vi.spyOn(c.binarySync, 'applyRemoteDelete').mockResolvedValue(true);
  vi.spyOn(c.binarySync, 'broadcastFileDelete').mockImplementation(() => undefined);
  const notePeerScope = vi.fn();
  c.health.notePeerScope = notePeerScope;
  const events: string[] = [];
  coordinator.onSyncEvent((m) => events.push(m));
  return { vault, coordinator, c, sendTo, broadcast, notePeerScope, events };
}

/** What a start does before the first connection: the last run's list, then the hashes. */
async function startUp(c: any): Promise<void> {
  await c._loadFileIndex();
  c.primed = c._primeKnownHashes();
  await c.primed;
}

/** The file list a message holds, or null for another message. */
function treeIn(data: Uint8Array): FileMetaSyncPayload | null {
  const msg = decodeMessage(data);
  return msg.type === MessageType.FILE_META_SYNC ? decodeJSON<FileMetaSyncPayload>(msg.payload) : null;
}

function sentTypes(sendTo: ReturnType<typeof vi.fn>): MessageType[] {
  return sendTo.mock.calls.map((call) => decodeMessage(call[1]).type);
}

function requested(c: any): string[] {
  return c.binarySync.requestFile.mock.calls.map((call: any[]) => call[1]);
}

function sent(c: any): string[] {
  return c.binarySync.sendFileToPeer.mock.calls.map((call: any[]) => call[1]);
}

afterEach(() => {
  vi.restoreAllMocks();
  setLanguage(null);
});

describe('SyncCoordinator file list for a connection limited to one folder', () => {
  async function listFor(scope: SyncScope, deleted: Tombstone[]): Promise<{ tree: FileMetaSyncPayload; all: FileMeta[] }> {
    const vault = new FakeVault();
    vault.put('Work/a.png', 'a');
    vault.put('Work/sub/b.png', 'b');
    vault.put('Personal/c.png', 'c');
    vault.put('Workshop/d.png', 'd');
    const { c } = setup(vault, '', { scope });
    for (const t of deleted) c.tombstones.add(t.path, t.hash, undefined, t.movedTo);
    const all = [...(await c._buildTree()).files.values()] as FileMeta[];
    return { tree: treeIn(c._encodeTree(all, 'peer-1'))!, all };
  }

  const deletions: Tombstone[] = [
    { path: 'Work/gone.png', deletedAt: 5, hash: 'h1' },
    { path: 'Personal/gone.png', deletedAt: 5, hash: 'h2' },
    { path: 'Work/out.png', deletedAt: 5, hash: 'h3', movedTo: 'Personal/out.png' },
    { path: 'Personal/in.png', deletedAt: 5, hash: 'h4', movedTo: 'Work/in.png' },
    { path: 'Work/x.png', deletedAt: 5, hash: 'h5', movedTo: 'Work/y.png' },
  ];

  it('lists only the files, folders and deletions in the folder, with its digest', async () => {
    const { tree } = await listFor('Work', deletions);
    expect(tree.files.map((f) => f.path).sort()).toEqual(['Work/a.png', 'Work/sub/b.png']);
    expect([...(tree.folders ?? [])].sort()).toEqual(['Work', 'Work/sub']);
    expect(tree.digest).toBe(vaultDigest(tree.files));
    const byPath = new Map((tree.deleted ?? []).map((t) => [t.path, t]));
    expect([...byPath.keys()].sort()).toEqual(['Work/gone.png', 'Work/out.png', 'Work/x.png']);
    // Moved out of the folder: the peer sees a deletion, not where it went.
    expect(byPath.get('Work/out.png')).not.toHaveProperty('movedTo');
    expect(byPath.get('Work/out.png')?.hash).toBe('h3');
    expect(byPath.get('Work/x.png')?.movedTo).toBe('Work/y.png');
    expect(JSON.stringify(tree)).not.toContain('Personal');
    expect(JSON.stringify(tree)).not.toContain('Workshop');
  });

  it('lists nothing when the two sides sync folders that do not overlap', async () => {
    const { tree } = await listFor(null, deletions);
    expect(tree.files).toEqual([]);
    expect(tree.folders).toEqual([]);
    expect(tree.deleted).toEqual([]);
    expect(tree.digest).toBe(vaultDigest([]));
  });

  it('lists everything as before for the whole vault', async () => {
    const { tree, all } = await listFor('', deletions);
    expect(tree.files.map((f) => f.path).sort()).toEqual(all.map((f) => f.path).sort());
    expect(tree.files).toHaveLength(4);
    expect(tree.digest).toBe(vaultDigest(all));
    expect(tree.deleted).toHaveLength(deletions.length);
    expect(tree.deleted?.find((t) => t.path === 'Work/out.png')?.movedTo).toBe('Personal/out.png');
    expect(tree.folders).toContain('Personal');
  });
});

describe('SyncCoordinator taking a file list over a connection limited to one folder', () => {
  it('leaves alone what the peer lists outside the folder, and does not offer our files outside it', async () => {
    const vault = new FakeVault();
    vault.put('Work/a.png', 'a');
    vault.put('Work/mine.png', 'mine');
    vault.put('Personal/p.png', 'p');
    vault.put('Personal/private.png', 'private');
    // This device syncs the whole vault; the peer only Work.
    const { c, sendTo, broadcast } = setup(vault, '', { scope: 'Work', peerFolder: 'Work' });
    const remote: FileMetaSyncPayload = {
      files: [await meta('Work/a.png', 'a'), await meta('Work/theirs.png', 't'), await meta('Personal/x.png', 'x')],
      folders: ['Work', 'Elsewhere'],
      deleted: [
        { path: 'Personal/p.png', deletedAt: Date.now(), hash: await hashOf('p') },
        { path: 'Work/a.png', deletedAt: 1, hash: 'other', movedTo: 'Personal/a.png' },
      ],
      digest: 'whatever',
    };
    await c._handleRemoteFileTree('peer-1', remote);

    expect(requested(c)).toEqual(['Work/theirs.png']);
    expect(sent(c)).toEqual(['Work/mine.png']);
    expect(c.binarySync.applyRemoteDelete).not.toHaveBeenCalled();
    expect(vault.getAbstractFileByPath('Personal/p.png')).toBeInstanceOf(TFile);
    expect(vault.getAbstractFileByPath('Elsewhere')).toBeNull();
    expect(sentTypes(sendTo)).not.toContain(MessageType.FILE_DELETE);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('compares digests over the files in the folder', async () => {
    const vault = new FakeVault();
    vault.put('Work/a.png', 'a');
    vault.put('Personal/p.png', 'p');
    const { c } = setup(vault, '', { scope: 'Work', peerFolder: 'Work' });
    const noteExchange = vi.spyOn(c.health, 'noteExchange');
    const files = [await meta('Work/a.png', 'a')];
    await c._handleRemoteFileTree('peer-1', { files, folders: ['Work'], deleted: [], digest: vaultDigest(files) });
    expect(noteExchange).toHaveBeenCalledWith('peer-1', expect.objectContaining({ differing: [], digestMatch: true }));
  });

  it('applies a peer deletion of a file moved out of the folder as a deletion', async () => {
    const vault = new FakeVault();
    vault.put('Work/a.png', 'a');
    const { c } = setup(vault, 'Work', { scope: 'Work', peerFolder: '' });
    const record = { path: 'Work/a.png', deletedAt: Date.now(), hash: await hashOf('a'), movedTo: 'Personal/a.png' };
    await c._handleRemoteFileTree('peer-1', { files: [], folders: [], deleted: [record] });
    expect(c.binarySync.applyRemoteDelete).toHaveBeenCalledTimes(1);
    const [path, applied] = c.binarySync.applyRemoteDelete.mock.calls[0];
    expect(path).toBe('Work/a.png');
    expect(applied).not.toHaveProperty('movedTo');
  });

  it('syncs nothing with a peer whose folder does not overlap ours, and says so', async () => {
    const vault = new FakeVault();
    vault.put('Work/a.png', 'a');
    const { c, coordinator, sendTo, notePeerScope, events } = setup(vault, 'Work', { scope: null, peerFolder: 'Home' });
    await c._handleRemoteFileTree('peer-1', {
      files: [await meta('Home/h.png', 'h'), await meta('Work/b.png', 'b')],
      folders: ['Home'],
      deleted: [{ path: 'Work/a.png', deletedAt: Date.now(), hash: await hashOf('a') }],
    });
    expect(requested(c)).toEqual([]);
    expect(sent(c)).toEqual([]);
    expect(sendTo).not.toHaveBeenCalled();
    expect(c.binarySync.applyRemoteDelete).not.toHaveBeenCalled();
    expect(notePeerScope).toHaveBeenLastCalledWith('peer-1', { disjoint: { here: 'Work', there: 'Home' } });

    // Said once per connection, in the user's language.
    setLanguage('zh');
    c._notePeerScope('peer-1', true);
    expect(events.at(-1)).toBe('Phone 只同步 Home，本设备只同步 Work，两边没有共同的文件夹，什么都不会同步');
    void coordinator;
  });

  it('names the whole vault in the disjoint message', async () => {
    const vault = new FakeVault();
    const { c, notePeerScope, events } = setup(vault, '', { scope: null, peerFolder: '../bad' });
    c._notePeerScope('peer-1', true);
    expect(notePeerScope).toHaveBeenLastCalledWith('peer-1', { disjoint: { here: '', there: '../bad' } });
    expect(events.at(-1)).toContain('this device syncs the whole vault');
    setLanguage('zh');
    c._notePeerScope('peer-1', true);
    expect(events.at(-1)).toContain('本设备只同步 整个库');
  });

  it('tells the panel the folder a connection carries, and a folder the peer syncs that is not here', async () => {
    const vault = new FakeVault();
    vault.put('work/a.png', 'a');
    const { c, notePeerScope } = setup(vault, '', { scope: 'Work', peerFolder: 'Work' });
    c._notePeerScope('peer-1');
    expect(notePeerScope).toHaveBeenLastCalledWith('peer-1', { only: 'Work', missingHere: 'Work' });
    // Made since (or fetched from the peer): the next exchange clears it.
    await c._handleRemoteFileTree('peer-1', { files: [], folders: ['Work'], deleted: [] });
    expect(vault.getAbstractFileByPath('Work')).toBeInstanceOf(TFolder);
    expect(notePeerScope).toHaveBeenLastCalledWith('peer-1', { only: 'Work' });
  });

  it('tells the panel nothing is limited for the whole vault on both sides', async () => {
    const vault = new FakeVault();
    const { c, notePeerScope } = setup(vault, '', { scope: '', peerFolder: '' });
    c._notePeerScope('peer-1');
    expect(notePeerScope).toHaveBeenLastCalledWith('peer-1', {});
    // Our own folder is not checked here (the settings do).
    const limited = setup(new FakeVault(), 'Work', { scope: 'Work', peerFolder: '' });
    limited.c._notePeerScope('peer-1');
    expect(limited.notePeerScope).toHaveBeenLastCalledWith('peer-1', { only: 'Work' });
  });

  it('works with a ConnectionManager that knows nothing of folders (falls back to our own)', async () => {
    const vault = new FakeVault();
    vault.put('Work/a.png', 'a');
    vault.put('Personal/p.png', 'p');
    const { c } = setup(vault, 'Work', {});
    delete c.connectionManager.peerSyncFolder;
    const all = [...(await c._buildTree()).files.values()];
    const tree = treeIn(c._encodeTree(all, 'peer-1'))!;
    expect(tree.files.map((f: FileMeta) => f.path)).toEqual(['Work/a.png']);
    await c._handleRemoteFileTree('peer-1', { files: [await meta('Personal/q.png', 'q')], folders: [], deleted: [] });
    expect(requested(c)).toEqual([]);
  });
});

describe('SyncCoordinator changing the folder setting', () => {
  /** The list of synced files a run saved, as _saveFileIndex writes it. */
  async function savedIndex(adapter: MemAdapter): Promise<Record<string, string>> {
    return JSON.parse(await adapter.read(FILE_INDEX_FILE));
  }

  async function seedIndex(adapter: MemAdapter, entries: Record<string, string>): Promise<void> {
    await adapter.write(FILE_INDEX_FILE, JSON.stringify(entries));
  }

  it('A: whole vault, then only Work: files outside it are not taken for deleted', async () => {
    const adapter = new MemAdapter();
    // As the last run (whole vault) saved it. Personal/gone.png was deleted
    // since, and its content is now Work/new.png (a move into the folder).
    await seedIndex(adapter, {
      'Work/w.png': await hashOf('w'),
      'Personal/a.png': await hashOf('a'),
      'Personal/gone.png': await hashOf('g'),
      'Old/o.png': await hashOf('o'),
      Work: 'folder',
      Personal: 'folder',
      Old: 'folder',
    });
    const vault = new FakeVault(adapter);
    vault.put('Work/w.png', 'w');
    vault.put('Work/new.png', 'g');
    vault.put('Personal/a.png', 'a');
    const { c, sendTo, broadcast } = setup(vault, 'Work', { scope: 'Work', peerFolder: '' });
    await startUp(c);

    // A peer with the whole vault, which lists the files outside Work and
    // deletions there, as an older version might. Old/o.png was deleted on
    // the peer too: with that, the folder Old (gone here since the last
    // run) would count as removed while sync was off.
    await c._handleRemoteFileTree('peer-1', {
      files: [await meta('Work/w.png', 'w'), await meta('Personal/a.png', 'a'), await meta('Personal/gone.png', 'g')],
      folders: ['Work', 'Personal'],
      deleted: [
        { path: 'Personal/a.png', deletedAt: Date.now(), hash: await hashOf('a') },
        { path: 'Old/o.png', deletedAt: Date.now(), hash: await hashOf('o') },
      ],
    });

    for (const p of ['Personal/a.png', 'Personal/gone.png', 'Old/o.png', 'Personal', 'Old']) {
      expect(c.tombstones.get(p)).toBeUndefined();
    }
    expect(sentTypes(sendTo)).not.toContain(MessageType.FILE_DELETE);
    expect(sentTypes(sendTo)).not.toContain(MessageType.FOLDER_DELETE);
    expect(broadcast).not.toHaveBeenCalled();
    expect(c.binarySync.broadcastFileDelete).not.toHaveBeenCalled();
    expect(c.binarySync.applyRemoteDelete).not.toHaveBeenCalled();
    expect(c.getHeldDeletions()).toEqual([]);
    expect(vault.getAbstractFileByPath('Personal/a.png')).toBeInstanceOf(TFile);
    expect(requested(c)).toEqual([]);
    // Moved into the folder: a new file for the peer, not a rename.
    expect(sent(c)).toEqual(['Work/new.png']);

    // The list saved now holds only what this run syncs.
    await c._saveFileIndex();
    expect(Object.keys(await savedIndex(adapter)).sort()).toEqual(['Work', 'Work/new.png', 'Work/w.png']);
  });

  it('B: only Work, then the whole vault: files outside it are new, never deleted', async () => {
    const adapter = new MemAdapter();
    // As the last run (only Work) saved it.
    await seedIndex(adapter, { 'Work/w.png': await hashOf('w'), Work: 'folder' });
    const vault = new FakeVault(adapter);
    vault.put('Work/w.png', 'w');
    vault.put('Personal/a.png', 'a');
    vault.put('Personal/c.png', 'c');
    const { c, sendTo, broadcast } = setup(vault, '', { scope: '', peerFolder: '' });
    await startUp(c);

    await c._handleRemoteFileTree('peer-1', {
      files: [await meta('Work/w.png', 'w'), await meta('Personal/a.png', 'a'), await meta('Personal/b.png', 'b')],
      folders: ['Work', 'Personal'],
      deleted: [],
    });

    expect(requested(c)).toEqual(['Personal/b.png']);
    expect(sent(c)).toEqual(['Personal/c.png']);
    expect(sentTypes(sendTo)).not.toContain(MessageType.FILE_DELETE);
    expect(broadcast).not.toHaveBeenCalled();
    expect(c.tombstones.list()).toEqual([]);
    expect(c.getHeldDeletions()).toEqual([]);
  });

  it('whole vault, only Work, whole vault again: a file deleted outside Work meanwhile comes back', async () => {
    const adapter = new MemAdapter();
    await seedIndex(adapter, {
      'Work/w.png': await hashOf('w'),
      'Personal/gone.png': await hashOf('g'),
      Work: 'folder',
      Personal: 'folder',
    });
    const peerFiles = [await meta('Work/w.png', 'w'), await meta('Personal/gone.png', 'g')];

    // A run with only Work: Personal/gone.png is deleted meanwhile, which
    // is not synced.
    const vault = new FakeVault(adapter);
    vault.put('Work/w.png', 'w');
    const limited = setup(vault, 'Work', { scope: 'Work', peerFolder: '' });
    await startUp(limited.c);
    await limited.c._handleRemoteFileTree('peer-1', { files: peerFiles, folders: ['Work', 'Personal'], deleted: [] });
    await limited.c._saveFileIndex();

    // Back to the whole vault: the file is fetched again, not deleted on the peer.
    const whole = setup(vault, '', { scope: '', peerFolder: '' });
    await startUp(whole.c);
    await whole.c._handleRemoteFileTree('peer-1', { files: peerFiles, folders: ['Work', 'Personal'], deleted: [] });
    expect(requested(whole.c)).toEqual(['Personal/gone.png']);
    expect(sentTypes(whole.sendTo)).not.toContain(MessageType.FILE_DELETE);
    expect(whole.c.tombstones.get('Personal/gone.png')).toBeUndefined();
  });

  it('(for contrast) without the folder setting, a file gone since the last run is taken for deleted', async () => {
    const adapter = new MemAdapter();
    await seedIndex(adapter, { 'Work/w.png': await hashOf('w'), 'Personal/gone.png': await hashOf('g') });
    const vault = new FakeVault(adapter);
    vault.put('Work/w.png', 'w');
    const { c, sendTo } = setup(vault, '', { scope: '', peerFolder: '' });
    await startUp(c);
    await c._handleRemoteFileTree('peer-1', {
      files: [await meta('Work/w.png', 'w'), await meta('Personal/gone.png', 'g')],
      folders: [],
      deleted: [],
    });
    expect(sentTypes(sendTo)).toContain(MessageType.FILE_DELETE);
    expect(c.tombstones.get('Personal/gone.png')).toBeDefined();
  });
});

describe('SyncCoordinator wiring for folders', () => {
  it('exchanges file lists after a message across a folder edge was dropped', async () => {
    const vault = new FakeVault();
    const coordinator = new SyncCoordinator(vault as any, { ...DEFAULT_SETTINGS, deviceId: 'device-a', deviceName: 'A', manualPeers: [] }, { eventLog: new EventLog(null) });
    const c = coordinator as any;
    const scheduled = vi.spyOn(c, '_scheduleTreeSync');
    c.connectionManager.onScopeSplitCb?.('peer-1', ['Work/a.md', 'Personal/a.md']);
    expect(scheduled).toHaveBeenCalledTimes(1);
  });

  it('saves the panel\'s device list when sync stops', async () => {
    const vault = new FakeVault();
    const coordinator = new SyncCoordinator(vault as any, { ...DEFAULT_SETTINGS, deviceId: 'device-a', deviceName: 'A', manualPeers: [] }, { eventLog: new EventLog(null) });
    const flushPeers = vi.fn().mockRejectedValue(new Error('disk full'));
    (coordinator as any).health.flushPeers = flushPeers;
    await coordinator.stop();
    expect(flushPeers).toHaveBeenCalledTimes(1);
  });
});
