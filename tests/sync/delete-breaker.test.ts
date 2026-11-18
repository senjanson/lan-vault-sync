import { describe, expect, it } from 'vitest';
import { DeleteBreaker } from '../../src/sync/delete-breaker';

const item = (path: string) => ({ path, del: { path } });

describe('DeleteBreaker', () => {
  it('holds a deletion another device passes on while the same file is already held', () => {
    let files = 20;
    const b = new DeleteBreaker(() => files);
    // Device x deletes most of the vault: held from the 10th on.
    const results = Array.from({ length: 15 }, (_, i) => {
      const r = b.admit('x', item(`f${i}`), 'x');
      if (r.ok) files--;
      return r;
    });
    expect(results.filter((r) => !r.ok).length).toBeGreaterThan(0);
    const held = b.list()[0].paths;
    // Device y passes the same deletions on, one at a time: still held.
    for (const p of held) expect(b.admit('y', item(p), 'y').ok).toBe(false);
    expect(b.list()).toHaveLength(1);
  });

  it('holds a peer\'s deletion of a file whose inferred deletion waits', () => {
    const b = new DeleteBreaker(() => 100);
    b.holdInferred([{ path: 'a.md', file: { path: 'a.md', hash: 'h', mtime: 1, size: 1, isTextFile: true } }]);
    expect(b.admit('x', item('a.md'), 'x').ok).toBe(false);
    expect(b.list()).toHaveLength(1);
  });

  it('lets a peer move many notes to a folder without holding them', () => {
    const b = new DeleteBreaker(() => 12);
    for (let i = 0; i < 12; i++) {
      expect(b.admit('x', { path: `y${i}.md`, del: { path: `y${i}.md`, movedTo: `sub/y${i}.md` } }, 'x').ok).toBe(true);
    }
    expect(b.admit('x', { path: 'z.md', tree: { record: { path: 'z.md', deletedAt: 1, movedTo: 'sub/z.md' }, expectHash: 'h' } }, 'x').ok).toBe(true);
    expect(b.list()).toHaveLength(0);
  });
});
