import { describe, expect, it, vi } from 'vitest';
import { buildFileTree, FileHashCache } from '../../src/sync/file-tree';
import { FileFilter } from '../../src/watcher/file-filter';

describe('buildFileTree', () => {
  it('reads only files that changed since the last build', async () => {
    const files = [
      { path: 'a.md', stat: { mtime: 1, size: 1 }, data: 'a' },
      { path: 'b.md', stat: { mtime: 1, size: 1 }, data: 'b' },
    ];
    const readBinary = vi.fn(async (f: any) => new TextEncoder().encode(f.data).buffer);
    const vault = { getFiles: () => files, readBinary } as any;
    const filter = new FileFilter([]);
    const cache: FileHashCache = new Map();

    const first = await buildFileTree(vault, filter, cache);
    expect(readBinary).toHaveBeenCalledTimes(2);

    files[1] = { path: 'b.md', stat: { mtime: 2, size: 2 }, data: 'bb' };
    const second = await buildFileTree(vault, filter, cache);
    expect(readBinary).toHaveBeenCalledTimes(3);
    expect(second.files.get('a.md')!.hash).toBe(first.files.get('a.md')!.hash);
    expect(second.files.get('b.md')!.hash).not.toBe(first.files.get('b.md')!.hash);

    files.pop();
    await buildFileTree(vault, filter, cache);
    expect([...cache.keys()]).toEqual(['a.md']);
  });
});
