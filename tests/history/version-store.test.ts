import { describe, expect, it } from 'vitest';
import { TFile, TFolder } from 'obsidian';
import { MemoryAdapter } from '../diagnostics/memory-adapter';
import { BLOB_DIR, INDEX_DIR, VersionStore, blobPath, groupEntries, type VersionEntry } from '../../src/history/version-store';
import { CONFLICT_BACKUP_DIR } from '../../src/constants';

const enc = (s: string) => new TextEncoder().encode(s);
const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
/** Noon local time, so hours either side stay on the same day file. */
const T0 = new Date(2026, 10, 18, 12, 0, 0).getTime();

/** A vault over the same in-memory adapter, as Obsidian's is over its adapter. */
function makeVault(adapter: MemoryAdapter) {
  return {
    adapter,
    getAbstractFileByPath(p: string) {
      if (adapter.files.has(p)) return new TFile(p);
      if (adapter.folders.has(p)) return new TFolder(p);
      return null;
    },
    async readBinary(f: TFile) { return adapter.readBinary(f.path); },
    async createBinary(p: string, d: ArrayBuffer) {
      if (adapter.files.has(p)) throw new Error('exists ' + p);
      adapter.files.set(p, d);
      return new TFile(p);
    },
    async modifyBinary(f: TFile, d: ArrayBuffer) { adapter.files.set(f.path, d); },
  };
}

function setup() {
  const adapter = new MemoryAdapter();
  const vault = makeVault(adapter);
  const clock = { now: T0 };
  const store = new VersionStore(adapter, vault, { now: () => clock.now, flushMs: 10_000 });
  return { adapter, vault, clock, store };
}

function text(adapter: MemoryAdapter, p: string): string | undefined {
  const v = adapter.files.get(p);
  if (v === undefined) return undefined;
  return typeof v === 'string' ? v : new TextDecoder().decode(v);
}

const blobs = (adapter: MemoryAdapter) => [...adapter.files.keys()].filter((k) => k.startsWith(BLOB_DIR + '/'));
const indexFiles = (adapter: MemoryAdapter) => [...adapter.files.keys()].filter((k) => k.startsWith(INDEX_DIR + '/'));

describe('VersionStore', () => {
  it('stores the same content once and indexes every version', async () => {
    const { adapter, store } = setup();
    const a = await store.keep('a.md', enc('same'), 'delete', { rule: 'r', peer: 'pixel' });
    const b = await store.keep('b.md', enc('same'), 'overwrite', { rule: 'r' });
    expect(a).not.toBeNull();
    expect(a!.id).toBe(b!.id);
    expect(a!.id).toMatch(/^[0-9a-f]{64}$/);
    expect(blobs(adapter)).toEqual([blobPath(a!.id)]);
    expect(blobPath(a!.id)).toContain(`/blobs/${a!.id.slice(0, 2)}/`);
    await store.flush();
    const lines = text(adapter, indexFiles(adapter)[0])!.trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ ts: T0, path: 'a.md', op: 'delete', size: 4, peer: 'pixel', rule: 'r' });
    expect(new TextDecoder().decode((await store.read(a!.id))!)).toBe('same');
  });

  it('lists newest first, including lines not yet flushed, and filters', async () => {
    const { clock, store } = setup();
    await store.keepText('a.md', 'one', 'delete', { rule: 'r' });
    clock.now += MIN;
    await store.keepText('b.md', 'two', 'delete', { rule: 'r' });
    clock.now += MIN;
    await store.keepText('a.md', 'three', 'overwrite', { rule: 'r' });
    expect((await store.list()).map((e) => e.path)).toEqual(['a.md', 'b.md', 'a.md']);
    await store.flush();
    expect((await store.list({ path: 'a.md' })).map((e) => e.op)).toEqual(['overwrite', 'delete']);
    expect(await store.list({ sinceTs: T0 + MIN })).toHaveLength(2);
    expect(await store.list({ limit: 1 })).toHaveLength(1);
  });

  it('returns null, without throwing, when the version cannot be written', async () => {
    const { adapter, store } = setup();
    adapter.failWrites = true;
    await expect(store.keep('a.md', enc('x'), 'delete', { rule: 'r' })).resolves.toBeNull();
    expect(await store.read('not-a-hash')).toBeNull();
  });

  it('keeps a merged note at most every 5 minutes, but a shrink at once', async () => {
    const { clock, store } = setup();
    const ctx = { rule: 'merge' };
    const long = 'x'.repeat(100);
    expect(await store.keepNoteWrite('n.md', long, long + 'a', ctx)).toMatchObject({ kept: true, shrink: false });
    clock.now += MIN;
    expect(await store.keepNoteWrite('n.md', long + 'a', long + 'b', ctx)).toEqual({ kept: false, shrink: false });
    // Other notes have their own clock.
    expect((await store.keepNoteWrite('m.md', long, long + 'a', ctx)).kept).toBe(true);
    clock.now += MIN;
    expect(await store.keepNoteWrite('n.md', long, 'x'.repeat(40), ctx)).toMatchObject({ kept: true, shrink: true });
    clock.now += MIN;
    expect(await store.keepNoteWrite('n.md', 'short', '', ctx)).toMatchObject({ kept: true, shrink: true });
    // Less than half is a shrink; exactly half is not.
    clock.now += MIN;
    expect(await store.keepNoteWrite('n.md', long, 'x'.repeat(50), ctx)).toEqual({ kept: false, shrink: false });
    clock.now += 5 * MIN;
    expect((await store.keepNoteWrite('n.md', long, long + 'c', ctx)).kept).toBe(true);
    const ops = (await store.list({ path: 'n.md' })).map((e) => e.op);
    expect(ops).toEqual(['merge-write', 'shrink', 'shrink', 'merge-write']);
  });

  it('restores a version, keeping the current file first', async () => {
    const { adapter, store } = setup();
    const kept = await store.keepText('n.md', 'old', 'overwrite', { rule: 'r', peer: 'pixel' });
    adapter.files.set('n.md', 'current');
    const [entry] = await store.list();
    expect(await store.restore(entry)).toBe(true);
    expect(text(adapter, 'n.md')).toBe('old');
    const before = (await store.list()).find((e) => e.op === 'before-restore')!;
    expect(before.path).toBe('n.md');
    expect(new TextDecoder().decode((await store.read(before.hash))!)).toBe('current');
    expect(before.hash).not.toBe(kept!.id);
  });

  it('recreates a deleted file in folders that are gone', async () => {
    const { adapter, store } = setup();
    await store.keepText('deep/dir/n.md', 'old', 'delete', { rule: 'r' });
    const [entry] = await store.list();
    expect(await store.restore(entry)).toBe(true);
    expect(text(adapter, 'deep/dir/n.md')).toBe('old');
    expect(adapter.folders.has('deep/dir')).toBe(true);
  });

  it('refuses to restore when the current file cannot be kept', async () => {
    const { adapter, store } = setup();
    await store.keepText('n.md', 'old', 'overwrite', { rule: 'r' });
    adapter.files.set('n.md', 'current');
    const [entry] = await store.list();
    adapter.failWrites = true;
    expect(await store.restore(entry)).toBe(false);
    expect(text(adapter, 'n.md')).toBe('current');
  });

  it('restoreGroup puts back the newest version of each path', async () => {
    const { adapter, clock, store } = setup();
    await store.keepText('a.md', 'a1', 'overwrite', { rule: 'r', batch: 'b' });
    clock.now += 1000;
    await store.keepText('a.md', 'a2', 'overwrite', { rule: 'r', batch: 'b' });
    await store.keepText('b.md', 'b1', 'delete', { rule: 'r', batch: 'b' });
    adapter.files.set('a.md', 'now');
    const [group] = await store.groups();
    const result = await store.restoreGroup(group.entries);
    expect(result.restored.sort()).toEqual(['a.md', 'b.md']);
    expect(result.failed).toEqual([]);
    expect(text(adapter, 'a.md')).toBe('a2');
    expect(text(adapter, 'b.md')).toBe('b1');
  });

  it('groups by batch, else by peer and op with gaps of at most 2 minutes', () => {
    const e = (ts: number, peer: string | undefined, op: string, batch?: string): VersionEntry =>
      ({ ts, path: `${peer}-${op}-${ts}.md`, hash: 'h', size: 1, op, peer, batch });
    const groups = groupEntries([
      e(T0, 'A', 'delete'),
      e(T0 + MIN, 'A', 'delete'),
      e(T0 + 2.5 * MIN, 'A', 'delete'),
      e(T0 + 5 * MIN, 'A', 'delete'),
      e(T0 + 30_000, 'B', 'delete'),
      e(T0 + MIN, 'A', 'overwrite'),
      e(T0, 'A', 'delete', 'x'),
      e(T0 + 60 * MIN, 'A', 'overwrite', 'x'),
    ]);
    const shape = groups.map((g) => [g.peer, g.batch ?? null, g.ops.join('+'), g.entries.length]);
    expect(shape).toEqual([
      ['A', 'x', 'delete+overwrite', 2],
      ['A', null, 'delete', 1],
      ['A', null, 'delete', 3],
      ['A', null, 'overwrite', 1],
      ['B', null, 'delete', 1],
    ]);
    // Newest first inside a group.
    expect(groups[2].entries[0].ts).toBe(T0 + 2.5 * MIN);
  });

  it('T8: 600 deletions in one batch list as one group and come back with restoreGroup', async () => {
    const { adapter, store } = setup();
    const ctx = { rule: 'tombstone-covers', peer: 'pixel', batch: 'bulk-1' };
    for (let i = 0; i < 600; i++) {
      const path = `notes/n${i}.md`;
      adapter.files.set(path, `note ${i}`);
      expect(await store.keep(path, enc(`note ${i}`), 'delete', ctx)).not.toBeNull();
      adapter.files.delete(path);
    }
    await store.flush();
    const groups = await store.groups();
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ peer: 'pixel', batch: 'bulk-1', ops: ['delete'] });
    expect(groups[0].entries).toHaveLength(600);
    const { restored, failed } = await store.restoreGroup(groups[0].entries);
    expect(restored).toHaveLength(600);
    expect(failed).toEqual([]);
    for (let i = 0; i < 600; i++) expect(text(adapter, `notes/n${i}.md`)).toBe(`note ${i}`);
  });

  it('T10: prune drops expired versions and their blobs, keeps a blob still referenced', async () => {
    const { adapter, clock, store } = setup();
    clock.now = T0 - 40 * DAY;
    const oldOnly = await store.keepText('a.md', 'old only', 'delete', { rule: 'r' });
    const shared = await store.keepText('b.md', 'shared', 'delete', { rule: 'r' });
    await store.flush();
    clock.now = T0;
    await store.keepText('c.md', 'shared', 'delete', { rule: 'r' });
    const fresh = await store.keepText('d.md', 'fresh', 'delete', { rule: 'r' });
    await store.flush();
    const todayBefore = text(adapter, indexFiles(adapter).sort().at(-1)!);

    const result = await store.prune({ keepDays: 30 });
    expect(result).toMatchObject({ removedVersions: 2, removedBlobs: 1 });
    expect(adapter.files.has(blobPath(oldOnly!.id))).toBe(false);
    expect(adapter.files.has(blobPath(shared!.id))).toBe(true);
    expect(adapter.files.has(blobPath(fresh!.id))).toBe(true);
    expect(indexFiles(adapter)).toHaveLength(1);
    expect(text(adapter, indexFiles(adapter)[0])).toBe(todayBefore);
    expect((await store.list()).map((e) => e.path).sort()).toEqual(['c.md', 'd.md']);
  });

  it('prune rewrites today\'s index with the lines that have not expired', async () => {
    const { adapter, clock, store } = setup();
    clock.now = T0 - 3 * 60 * MIN;
    await store.keepText('early.md', 'early', 'delete', { rule: 'r' });
    clock.now = T0;
    await store.keepText('late.md', 'late', 'delete', { rule: 'r' });
    await store.prune({ keepDays: 1 / 24 });
    expect(indexFiles(adapter)).toHaveLength(1);
    expect((await store.list()).map((e) => e.path)).toEqual(['late.md']);
    expect(blobs(adapter)).toHaveLength(1);
  });

  it('prune drops the oldest versions until the blobs fit maxBytes, never today\'s', async () => {
    const { adapter, clock, store } = setup();
    const keepOn = async (daysAgo: number, path: string) => {
      clock.now = T0 - daysAgo * DAY;
      await store.keepText(path, path.repeat(25).slice(0, 100), 'delete', { rule: 'r' });
    };
    await keepOn(3, 'x.md');
    await keepOn(2, 'y.md');
    await keepOn(1, 'z.md');
    await keepOn(0, 'w.md');
    expect((await store.usage()).bytes).toBe(400);
    expect(await store.nearCap(420)).toBe(true);
    expect(await store.nearCap(1000)).toBe(false);

    await store.prune({ keepDays: 30, maxBytes: 250 });
    expect((await store.list()).map((e) => e.path)).toEqual(['w.md', 'z.md']);
    expect(await store.usage()).toEqual({ bytes: 200, versions: 2 });

    await store.prune({ keepDays: 30, maxBytes: 50 });
    expect((await store.list()).map((e) => e.path)).toEqual(['w.md']);
    expect(blobs(adapter)).toHaveLength(1);
  });

  it('prune removes old conflict backups, best effort', async () => {
    const { adapter, store } = setup();
    const backup = async (id: string, savedAt: number | null) => {
      const dir = `${CONFLICT_BACKUP_DIR}/${id}`;
      for (const p of [CONFLICT_BACKUP_DIR, dir, `${dir}/files`]) await adapter.mkdir(p);
      adapter.files.set(`${dir}/files/a.md`, 'x');
      if (savedAt !== null) adapter.files.set(`${dir}/metadata.json`, JSON.stringify({ savedAt: new Date(savedAt).toISOString() }));
      return dir;
    };
    const old = await backup('2026-09-01T10-00-00-000Z-1-abcd', T0 - 60 * DAY);
    const recent = await backup('2026-11-17T10-00-00-000Z-2-abcd', T0 - DAY);
    const oldNoMeta = await backup('2026-09-02T10-00-00-000Z-3-abcd', null);
    const result = await store.prune({ keepDays: 30 });
    expect(result.removedConflictBackups).toBe(2);
    expect(adapter.files.has(`${old}/metadata.json`)).toBe(false);
    expect(adapter.files.has(`${old}/files/a.md`)).toBe(false);
    expect(adapter.files.has(`${oldNoMeta}/files/a.md`)).toBe(false);
    expect(adapter.files.has(`${recent}/files/a.md`)).toBe(true);
  });
});
