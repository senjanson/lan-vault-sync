import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { StatePersistence } from '../../src/crdt/state-persistence';

class MemoryAdapter {
  files = new Map<string, ArrayBuffer>();
  async exists(p: string) { return this.files.has(p) || [...this.files.keys()].some((k) => k.startsWith(p + '/')); }
  async mkdir() {}
  async writeBinary(p: string, d: ArrayBuffer) { this.files.set(p, d); }
  async readBinary(p: string) { return this.files.get(p)!; }
  async remove(p: string) { this.files.delete(p); }
}

const legacyName = (path: string) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(path))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

describe('StatePersistence', () => {
  it('uses short hashed file names, even for long CJK paths', async () => {
    const adapter = new MemoryAdapter();
    const store = new StatePersistence({} as any, adapter);
    const path = '读书笔记/' + '很长的中文文件名'.repeat(20) + '.md';
    const doc = new Y.Doc();
    doc.getText('content').insert(0, 'hello');
    await store.saveDoc(path, doc);
    const [name] = [...adapter.files.keys()];
    expect(name.split('/').pop()!.length).toBeLessThan(80);

    const loaded = new Y.Doc();
    expect(await store.loadDoc(path, loaded)).toBe(true);
    expect(loaded.getText('content').toString()).toBe('hello');
  });

  it('reads state saved under the former name and migrates it on save', async () => {
    const adapter = new MemoryAdapter();
    const store = new StatePersistence({} as any, adapter);
    const doc = new Y.Doc();
    doc.getText('content').insert(0, 'old');
    const legacy = `.obsidian/plugins/lan-vault-sync/crdt-state/${legacyName('a.md')}.ystate`;
    adapter.files.set(legacy, Y.encodeStateAsUpdate(doc).slice().buffer);

    expect(await store.hasDoc('a.md')).toBe(true);
    const loaded = new Y.Doc();
    await store.loadDoc('a.md', loaded);
    expect(loaded.getText('content').toString()).toBe('old');

    await store.saveDoc('a.md', loaded);
    expect(adapter.files.has(legacy)).toBe(false);
    expect(await store.hasDoc('a.md')).toBe(true);
  });
});
