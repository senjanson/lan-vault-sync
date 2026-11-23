import { describe, expect, it, vi } from 'vitest';
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

  it('matches a copy by hash, or without a hash by the version both last shared, never by the clock', () => {
    expect(TombstoneStore.covers({ path: 'a', deletedAt: 10, hash: 'x' }, { hash: 'x', mtime: 99 })).toBe(true);
    expect(TombstoneStore.covers({ path: 'a', deletedAt: 10, hash: 'x' }, { hash: 'y', mtime: 1 })).toBe(false);
    // Was: an older modified time was enough, so an edit made on a device
    // whose clock is behind was deleted.
    expect(TombstoneStore.covers({ path: 'a', deletedAt: 10 }, { hash: 'y', mtime: 5 })).toBe(false);
    expect(TombstoneStore.covers({ path: 'a', deletedAt: 10 }, { hash: 'y', mtime: 5 }, 'y')).toBe(true);
    expect(TombstoneStore.covers({ path: 'a', deletedAt: 10 }, { hash: 'y', mtime: 5 }, 'z')).toBe(false);
  });

  it('takes an attachment still at the version last shared for an older version of the deleted one', () => {
    const t = { path: 'p.png', deletedAt: 10, hash: 'v2' };
    // Changed to v2 elsewhere, then deleted: the copy still at v1 goes.
    expect(TombstoneStore.covers(t, { hash: 'v1', mtime: 1 }, 'v1', true)).toBe(true);
    // Changed here (v3): kept.
    expect(TombstoneStore.covers(t, { hash: 'v3', mtime: 1 }, 'v1', true)).toBe(false);
    // No version known in common: kept.
    expect(TombstoneStore.covers(t, { hash: 'v1', mtime: 1 }, undefined, true)).toBe(false);
    // A note's record with a hash is only matched by it.
    expect(TombstoneStore.covers(t, { hash: 'v1', mtime: 1 }, 'v1')).toBe(false);
    expect(TombstoneStore.covers(t, { hash: 'v2', mtime: 1 }, undefined, true)).toBe(true);
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

  it('turns the record of a deletion into one of the file being put back', async () => {
    const adapter = memoryAdapter();
    let now = 100;
    const store = new TombstoneStore(adapter, () => now);
    await store.load();
    store.add('f.md', 'h1');
    store.add('g.md', 'h2', undefined, 'h.md');
    now = 200;
    store.revive('f.md');
    store.revive('g.md');
    expect(store.get('f.md')).toBeUndefined();
    expect(store.getRevival('f.md')).toEqual({ path: 'f.md', deletedAt: 100, hash: 'h1' });
    // A new file under a renamed file's old name undoes no deletion.
    expect(store.getRevival('g.md')).toBeUndefined();
    await store.flush();
    const again = new TombstoneStore(adapter, () => now);
    await again.load();
    expect(again.getRevival('f.md')?.deletedAt).toBe(100);
    // Deleted once more: that deletion holds again.
    again.add('f.md', 'h1');
    expect(again.getRevival('f.md')).toBeUndefined();
  });

  it('writes changes a second after them, or later while writing takes long, up to three seconds', async () => {
    vi.useFakeTimers();
    try {
      const adapter = memoryAdapter();
      let writeMs = 0;
      const writes: number[] = [];
      const write = adapter.write;
      adapter.write = async (p: string, d: string) => {
        writes.push(Date.now());
        vi.setSystemTime(Date.now() + writeMs);
        return write(p, d);
      };
      const store = new TombstoneStore(adapter);
      await store.load();
      const start = Date.now();

      writeMs = 500;
      store.add('a.md', 'h1');
      await vi.advanceTimersByTimeAsync(1000);
      expect(writes).toEqual([start + 1000]);

      // The write took half a second: the next one waits three.
      writeMs = 0;
      store.add('b.md', 'h2');
      await vi.advanceTimersByTimeAsync(2900);
      expect(writes).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(100);
      expect(writes).toHaveLength(2);

      store.add('c.md', 'h3');
      await vi.advanceTimersByTimeAsync(1000);
      expect(writes).toHaveLength(3);
      expect(JSON.parse(adapter.files.get(TOMBSTONE_FILE)!).map((t: { path: string }) => t.path)).toEqual(['a.md', 'b.md', 'c.md']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('finds the records of renames to a name, as filtering the whole list does', async () => {
    const adapter = memoryAdapter();
    let now = 1_000_000;
    const store = new TombstoneStore(adapter, () => now);
    await store.load();
    const byList = (to: string) => store.list().filter((t) => t.movedTo === to).map((t) => t.path);
    const byIndex = (to: string) => store.renamesTo(to).map((t) => t.path);
    store.add('a.md', 'h1', undefined, 'x.md');
    store.add('b.md', 'h2', undefined, 'x.md');
    store.add('c.md', 'h3', undefined, 'y.md');
    store.add('d.md', 'h4');
    expect(byIndex('x.md')).toEqual(['a.md', 'b.md']);
    now += 1;
    store.add('a.md', 'h1', undefined, 'y.md'); // moved on again: the old target no longer holds
    store.clear('b.md');
    store.revive('c.md');
    for (const to of ['x.md', 'y.md', 'd.md']) expect(byIndex(to)).toEqual(byList(to));
    expect(byIndex('y.md')).toEqual(['a.md']);
    await store.flush();

    const loaded = new TombstoneStore(adapter, () => now);
    await loaded.load();
    expect(loaded.renamesTo('y.md').map((t) => t.path)).toEqual(['a.md']);
    now += TOMBSTONE_TTL_MS + 1;
    expect(loaded.renamesTo('y.md')).toEqual([]);
  });
});
