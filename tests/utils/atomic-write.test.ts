import { describe, expect, it, vi } from 'vitest';
import { readJsonWithBackup, writeAtomic } from '../../src/utils/atomic-write';
import { MemoryAdapter } from '../diagnostics/memory-adapter';

/** Like Obsidian's DataAdapter, rename fails when the destination exists. */
class StrictAdapter extends MemoryAdapter {
  async rename(a: string, b: string) {
    if (this.files.has(b)) throw new Error('Destination file already exists!');
    return super.rename(a, b);
  }
}

const P = 'state/index.json';

describe('writeAtomic', () => {
  it('replaces the file and keeps the previous content as .bak', async () => {
    const a = new StrictAdapter();
    await writeAtomic(a, P, '{"v":1}');
    expect(a.files.get(P)).toBe('{"v":1}');
    expect(a.files.has(`${P}.bak`)).toBe(false);
    await writeAtomic(a, P, '{"v":2}');
    await writeAtomic(a, P, '{"v":3}');
    expect(a.files.get(P)).toBe('{"v":3}');
    expect(a.files.get(`${P}.bak`)).toBe('{"v":2}');
    expect(a.files.has(`${P}.tmp`)).toBe(false);
  });

  it('without a backup, only moves the new content into place', async () => {
    const a = new StrictAdapter();
    const bytes = (n: number) => new Uint8Array([n]).buffer;
    await writeAtomic(a, 's.ystate', bytes(1), { backup: false });
    await writeAtomic(a, 's.ystate', bytes(2), { backup: false });
    expect(new Uint8Array(a.files.get('s.ystate') as ArrayBuffer)).toEqual(new Uint8Array([2]));
    expect([...a.files.keys()]).toEqual(['s.ystate']);
  });

  it('runs saves of the same file one after another', async () => {
    const a = new StrictAdapter();
    await Promise.all([1, 2, 3].map((v) => writeAtomic(a, P, `{"v":${v}}`)));
    expect(a.files.get(P)).toBe('{"v":3}');
    expect(a.files.get(`${P}.bak`)).toBe('{"v":2}');
  });
});

describe('readJsonWithBackup', () => {
  it('leaves the old file readable after a crash while the new one was written', async () => {
    const a = new StrictAdapter();
    await writeAtomic(a, P, '{"v":1}');
    // The crash: the new content reached only the temporary file, half written.
    a.files.set(`${P}.tmp`, '{"v":');
    const used = vi.fn();
    expect(await readJsonWithBackup(a, P, used)).toEqual({ v: 1 });
    expect(used).not.toHaveBeenCalled();
    // The next save gets past the leftover.
    await writeAtomic(a, P, '{"v":2}');
    expect(await readJsonWithBackup(a, P)).toEqual({ v: 2 });
  });

  it('reads the backup after a crash between the two renames', async () => {
    const a = new StrictAdapter();
    a.files.set(`${P}.bak`, '{"v":1}');
    a.files.set(`${P}.tmp`, '{"v":2}');
    const used = vi.fn();
    expect(await readJsonWithBackup(a, P, used)).toEqual({ v: 1 });
    expect(used).toHaveBeenCalledWith(P, expect.stringContaining('missing'));
    await writeAtomic(a, P, '{"v":3}');
    expect(await readJsonWithBackup(a, P)).toEqual({ v: 3 });
  });

  it('reads the backup of a damaged file and says so', async () => {
    const a = new StrictAdapter();
    a.files.set(P, '{"v": 2, "cut');
    a.files.set(`${P}.bak`, '{"v":1}');
    const used = vi.fn();
    expect(await readJsonWithBackup(a, P, used)).toEqual({ v: 1 });
    expect(used).toHaveBeenCalledWith(P, expect.stringContaining('damaged'));
  });

  it('gives null when neither the file nor its backup can be read', async () => {
    const a = new StrictAdapter();
    const used = vi.fn();
    expect(await readJsonWithBackup(a, P, used)).toBeNull();
    a.files.set(P, '');
    a.files.set(`${P}.bak`, '{');
    expect(await readJsonWithBackup(a, P, used)).toBeNull();
    expect(used).not.toHaveBeenCalled();
  });
});

describe('state files that use it', () => {
  it('deletion records are read from their backup when damaged', async () => {
    const { TombstoneStore } = await import('../../src/sync/tombstones');
    const { TOMBSTONE_FILE } = await import('../../src/constants');
    const a = new StrictAdapter();
    const first = new TombstoneStore(a, () => 1000);
    await first.load();
    first.add('a.md', 'h1');
    await first.flush();
    first.add('b.md', 'h2');
    await first.flush();
    expect(a.files.has(`${TOMBSTONE_FILE}.bak`)).toBe(true);
    a.files.set(TOMBSTONE_FILE, '[{"path":"a.md"');

    const second = new TombstoneStore(a, () => 1000);
    const used = vi.fn();
    second.setOnBackupUsed(used);
    await second.load();
    expect(second.get('a.md')?.hash).toBe('h1');
    expect(used).toHaveBeenCalledWith(TOMBSTONE_FILE, expect.stringContaining('damaged'));
  });

  it('a note history save leaves no backup, and a leftover .tmp is not taken for a history', async () => {
    const Y = await import('yjs');
    const { StatePersistence } = await import('../../src/crdt/state-persistence');
    const { CRDT_STATE_DIR } = await import('../../src/constants');
    const a = new StrictAdapter();
    const p = new StatePersistence({} as any, a);
    const doc = new Y.Doc();
    doc.getText('content').insert(0, 'hello');
    expect(await p.saveDoc('n.md', doc)).toBe(true);
    doc.getText('content').insert(5, '!');
    expect(await p.saveDoc('n.md', doc)).toBe(true);
    await p.flushDigests();
    const states = [...a.files.keys()].filter((k) => k.startsWith(`${CRDT_STATE_DIR}/`) && k.includes('.ystate'));
    expect(states).toHaveLength(1);
    expect(states[0].endsWith('.ystate')).toBe(true);

    // A save cut off before its move: the history before it is what loads.
    a.files.set(`${states[0]}.tmp`, new Uint8Array([1, 2, 3]).buffer);
    const fresh = new StatePersistence({} as any, a);
    const loaded = new Y.Doc();
    expect(await fresh.loadDoc('n.md', loaded)).toBe(true);
    expect(loaded.getText('content').toString()).toBe('hello!');
    expect(await fresh.hasDoc('m.md')).toBe(false);
    expect(await fresh.digestOf('n.md')).toBeTruthy();
  });
});
