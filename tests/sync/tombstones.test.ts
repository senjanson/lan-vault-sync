import { describe, expect, it } from 'vitest';
import { TombstoneStore } from '../../src/sync/tombstones';
import { TOMBSTONE_FILE, TOMBSTONE_TTL_MS } from '../../src/constants';

function memoryAdapter() {
  const files = new Map<string, string>();
  return {
    files,
    exists: async (p: string) => files.has(p) || [...files.keys()].some((k) => k.startsWith(p + '/')),
    mkdir: async () => undefined,
    read: async (p: string) => files.get(p)!,
    write: async (p: string, d: string) => void files.set(p, d),
  };
}

describe('TombstoneStore', () => {
  it('survives a restart and forgets deletions after the retention period', async () => {
    const adapter = memoryAdapter();
    let now = 1_000_000;
    const first = new TombstoneStore(adapter, () => now);
    await first.load();
    first.add('a.md', 'h1');
    first.add('b.md');
    await first.flush();
    expect(adapter.files.has(TOMBSTONE_FILE)).toBe(true);

    const second = new TombstoneStore(adapter, () => now);
    await second.load();
    expect(second.get('a.md')).toEqual({ path: 'a.md', deletedAt: now, hash: 'h1' });

    now += TOMBSTONE_TTL_MS + 1;
    expect(second.list()).toEqual([]);
  });

  it('matches a copy by hash, or by age when no hash is known', () => {
    expect(TombstoneStore.covers({ path: 'a', deletedAt: 10, hash: 'x' }, { hash: 'x', mtime: 99 })).toBe(true);
    expect(TombstoneStore.covers({ path: 'a', deletedAt: 10, hash: 'x' }, { hash: 'y', mtime: 1 })).toBe(false);
    expect(TombstoneStore.covers({ path: 'a', deletedAt: 10 }, { hash: 'y', mtime: 5 })).toBe(true);
    expect(TombstoneStore.covers({ path: 'a', deletedAt: 10 }, { hash: 'y', mtime: 20 })).toBe(false);
  });

  it('keeps where a renamed file went when its old name is removed again', () => {
    let now = 100;
    const store = new TombstoneStore(null, () => now);
    store.add('f.md', 'h1', undefined, 'g.md');
    now = 200;
    // A peer's copy came back under the old name and was removed.
    store.add('f.md', 'h2');
    expect(store.get('f.md')).toEqual({ path: 'f.md', deletedAt: 200, hash: 'h2', movedTo: 'g.md' });
  });
});
