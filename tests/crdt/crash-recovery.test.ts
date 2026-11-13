import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { StatePersistence } from '../../src/crdt/state-persistence';
import { YjsDocManager } from '../../src/crdt/yjs-doc-manager';

/** The plugin's data folder; it outlives the app being killed. */
class MemoryAdapter {
  files = new Map<string, ArrayBuffer | string>();
  async exists(p: string) { return this.files.has(p) || [...this.files.keys()].some((k) => k.startsWith(p + '/')); }
  async mkdir() {}
  async writeBinary(p: string, d: ArrayBuffer) { this.files.set(p, d.slice(0)); }
  async readBinary(p: string) { return this.files.get(p) as ArrayBuffer; }
  async write(p: string, d: string) { this.files.set(p, d); }
  async read(p: string) { return this.files.get(p) as string; }
  async list() { return { files: [...this.files.keys()], folders: [] }; }
  async remove(p: string) { this.files.delete(p); }
}

/** A device: its doc manager, restarted (as after a kill) on the same data folder. */
function device(adapter = new MemoryAdapter()) {
  const manager = new YjsDocManager({ adapter } as any);
  const sent: Uint8Array[] = [];
  const written: Array<{ content: string; previous: string | undefined }> = [];
  manager.onLocalUpdate((_path, update) => sent.push(update));
  manager.onRemoteContent((_path, content, previous) => {
    written.push({ content, previous });
  });
  return { manager, adapter, sent, written };
}

/** Both devices exchange what the other lacks, as a sync on reconnect does. */
async function sync(a: YjsDocManager, b: YjsDocManager, path = 'n.md'): Promise<void> {
  await b.handleSyncStep2(path, await a.handleSyncStep1(path, await b.encodeSyncStep1(path)));
  await a.handleSyncStep2(path, await b.handleSyncStep1(path, await a.encodeSyncStep1(path)));
}

async function savedState(adapter: MemoryAdapter, path = 'n.md') {
  const doc = new Y.Doc();
  const saved = await new StatePersistence({} as any, adapter).loadState(path, doc);
  return { text: doc.getText('content').toString(), base: saved?.base, found: saved !== null };
}

describe('app killed right after an edit', () => {
  it('does not add the edit again when its file already holds it', async () => {
    const a = device();
    const b = device();
    await a.manager.initDocFromContentSilent('n.md', 'one\n');
    await b.manager.initDocFromContentSilent('n.md', '');
    await sync(a.manager, b.manager);

    // Edited on A; B gets it at once. A is killed without any shutdown.
    await a.manager.applyLocalChange('n.md', 'one\ntwo\n', true);
    for (const update of a.sent) await b.manager.applyRemoteUpdate('n.md', update);
    expect(await b.manager.getContent('n.md')).toBe('one\ntwo\n');

    const restarted = device(a.adapter);
    await restarted.manager.initDocFromContentSilent('n.md', 'one\ntwo\n');
    await sync(restarted.manager, b.manager);

    expect(await restarted.manager.getContent('n.md')).toBe('one\ntwo\n');
    expect(await b.manager.getContent('n.md')).toBe('one\ntwo\n');
  });

  it('saves an edit before handing it out for peers', async () => {
    const a = device();
    await a.manager.initDocFromContentSilent('n.md', 'one\n');
    let savedWhenSent: string | undefined;
    a.manager.onLocalUpdate(() => {
      void savedState(a.adapter).then((s) => (savedWhenSent = s.text));
    });
    await a.manager.applyLocalChange('n.md', 'one\ntwo\n', true);
    await new Promise((r) => setTimeout(r, 10));
    expect(savedWhenSent).toBe('one\ntwo\n');
  });

  it('keeps text typed in an editor that Obsidian had not saved yet', async () => {
    const a = device();
    const b = device();
    await a.manager.initDocFromContentSilent('n.md', 'one\n');
    await b.manager.initDocFromContentSilent('n.md', '');
    await sync(a.manager, b.manager);

    // Typed in the editor (not on disk yet), sent to B, then A is killed.
    await a.manager.applyLocalChange('n.md', 'one\ntyped\n');
    for (const update of a.sent) await b.manager.applyRemoteUpdate('n.md', update);

    const restarted = device(a.adapter);
    await restarted.manager.initDocFromContentSilent('n.md', 'one\n');
    // The doc is ahead of the file: the file gets the text, nothing is undone.
    expect(restarted.written).toEqual([{ content: 'one\ntyped\n', previous: 'one\n' }]);
    await sync(restarted.manager, b.manager);
    expect(await b.manager.getContent('n.md')).toBe('one\ntyped\n');
  });
});

describe('app killed while a peer\'s edit was being written', () => {
  async function killedBeforeWrite() {
    const a = device();
    const b = device();
    await a.manager.initDocFromContentSilent('n.md', 'one\n');
    await b.manager.initDocFromContentSilent('n.md', '');
    await sync(a.manager, b.manager);
    b.manager.markWritten('n.md', 'one\n', true);
    await b.manager.applyLocalChange('n.md', 'one\ntheirs\n', true);
    // A applies B's edit and is killed before the file is written.
    for (const update of b.sent) await a.manager.applyRemoteUpdate('n.md', update);
    await a.manager.getContent('n.md');
    return { adapter: a.adapter, b };
  }

  it('writes the edit to the file on the next start instead of undoing it', async () => {
    const { adapter, b } = await killedBeforeWrite();
    expect(await savedState(adapter)).toMatchObject({ text: 'one\ntheirs\n', base: 'one\n' });

    const restarted = device(adapter);
    await restarted.manager.initDocFromContentSilent('n.md', 'one\n');
    expect(restarted.written).toEqual([{ content: 'one\ntheirs\n', previous: 'one\n' }]);
    await sync(restarted.manager, b.manager);
    expect(await b.manager.getContent('n.md')).toBe('one\ntheirs\n');
  });

  it('keeps both the edit and a change made to the file while the app was closed', async () => {
    const { adapter, b } = await killedBeforeWrite();
    const restarted = device(adapter);
    await restarted.manager.initDocFromContentSilent('n.md', 'mine\none\n');
    expect(await restarted.manager.getContent('n.md')).toBe('mine\none\ntheirs\n');
    expect(restarted.written).toEqual([{ content: 'mine\none\ntheirs\n', previous: 'mine\none\n' }]);
    await sync(restarted.manager, b.manager);
    expect(await b.manager.getContent('n.md')).toBe('mine\none\ntheirs\n');
  });

  it('does the same when the first thing after the start is a local edit', async () => {
    const { adapter } = await killedBeforeWrite();
    const restarted = device(adapter);
    await restarted.manager.applyLocalChange('n.md', 'mine\none\n', true);
    expect(await restarted.manager.getContent('n.md')).toBe('mine\none\ntheirs\n');
    expect(restarted.written).toEqual([{ content: 'mine\none\ntheirs\n', previous: 'mine\none\n' }]);
  });

  it('does not add the edit again if the file got it and was changed after', async () => {
    // The record of the file's text is out of date: the file did get the
    // edit, unseen by the plugin, and was then changed while the app was closed.
    const { adapter } = await killedBeforeWrite();
    const restarted = device(adapter);
    await restarted.manager.initDocFromContentSilent('n.md', 'one\ntheirs\nmore\n');
    expect(await restarted.manager.getContent('n.md')).toBe('one\ntheirs\nmore\n');
    expect(restarted.written).toEqual([]);
  });
});

describe('saved state and the file', () => {
  it('records the file\'s text only while the doc is ahead of the file', async () => {
    const a = device();
    const b = device();
    await a.manager.initDocFromContentSilent('n.md', 'one\n');
    await b.manager.initDocFromContentSilent('n.md', '');
    await sync(a.manager, b.manager);
    b.manager.markWritten('n.md', 'one\n', true);
    await b.manager.applyLocalChange('n.md', 'one\ntheirs\n', true);
    for (const update of b.sent) await a.manager.applyRemoteUpdate('n.md', update);
    await a.manager.getContent('n.md');
    expect((await savedState(a.adapter)).base).toBe('one\n');

    // The file is written: the state file is plain again.
    a.manager.markWritten('n.md', 'one\ntheirs\n', true);
    await a.manager.getContent('n.md');
    expect(await savedState(a.adapter)).toEqual({ text: 'one\ntheirs\n', base: undefined, found: true });
  });

  it('only writes docs that changed when asked to save everything', async () => {
    const a = device();
    await a.manager.initDocFromContentSilent('n.md', 'one\n');
    await a.manager.getContent('n.md');
    const before = new Map(a.adapter.files);
    let writes = 0;
    const writeBinary = a.adapter.writeBinary.bind(a.adapter);
    a.adapter.writeBinary = async (p, d) => {
      writes++;
      await writeBinary(p, d);
    };
    await a.manager.persistAll();
    expect(writes).toBe(0);
    expect([...a.adapter.files.keys()].filter((k) => k.endsWith('.ystate'))).toEqual(
      [...before.keys()].filter((k) => k.endsWith('.ystate')),
    );
  });
});

describe('StatePersistence file text', () => {
  it('saves and loads the file text next to the state, and plain states as before', async () => {
    const adapter = new MemoryAdapter();
    const store = new StatePersistence({} as any, adapter);
    const doc = new Y.Doc();
    doc.getText('content').insert(0, '新内容 ahead');

    await store.saveDoc('a.md', doc, '磁盘上的旧内容');
    const withBase = new Y.Doc();
    expect(await store.loadState('a.md', withBase)).toEqual({ base: '磁盘上的旧内容' });
    expect(withBase.getText('content').toString()).toBe('新内容 ahead');

    await store.saveDoc('a.md', doc);
    const plain = new Y.Doc();
    expect(await store.loadState('a.md', plain)).toEqual({ base: undefined });
    expect(plain.getText('content').toString()).toBe('新内容 ahead');
    const [file] = [...adapter.files.entries()].filter(([k]) => k.endsWith('.ystate'));
    expect(new Uint8Array(file[1] as ArrayBuffer)).toEqual(Y.encodeStateAsUpdate(doc));
  });
});
