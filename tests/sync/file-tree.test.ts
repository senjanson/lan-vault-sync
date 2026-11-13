import { describe, expect, it, vi } from 'vitest';
import { buildFileTree, FileHashCache } from '../../src/sync/file-tree';
import { FileFilter } from '../../src/watcher/file-filter';
import { isPlainUtf8, utf8Length } from '../../src/utils/utf8';

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

  it('lists text files that are not plain UTF-8 as bytes to sync', async () => {
    const bytes: Record<string, number[]> = {
      'utf8.md': [...new TextEncoder().encode('中文\n')],
      'gbk.txt': [0xd6, 0xd0, 0xce, 0xc4],
      'bom.md': [0xef, 0xbb, 0xbf, 0x61],
      'p.png': [0xff],
    };
    const files = Object.keys(bytes).map((path) => ({ path, stat: { mtime: 1, size: bytes[path].length } }));
    const vault = { getFiles: () => files, readBinary: async (f: any) => new Uint8Array(bytes[f.path]).buffer } as any;
    const cache: FileHashCache = new Map();
    for (let build = 0; build < 2; build++) {
      const tree = await buildFileTree(vault, new FileFilter([]), cache);
      expect(Object.fromEntries([...tree.files].map(([p, m]) => [p, m.isTextFile]))).toEqual({
        'utf8.md': true, 'gbk.txt': false, 'bom.md': false, 'p.png': false,
      });
    }
  });
});

describe('isPlainUtf8', () => {
  it('accepts valid UTF-8 without a byte order mark only', () => {
    expect(isPlainUtf8(new TextEncoder().encode('a \ufffd 中 😀'))).toBe(true);
    expect(isPlainUtf8(new Uint8Array([0xef, 0xbb, 0xbf, 0x61]))).toBe(false);
    expect(isPlainUtf8(new Uint8Array([0xd6, 0xd0]))).toBe(false);
    expect(isPlainUtf8(new Uint8Array([]))).toBe(true);
  });

  it('measures strings as UTF-8', () => {
    for (const s of ['', 'abc', 'é', '中文', '😀x', '\ud800']) {
      expect(utf8Length(s)).toBe(new TextEncoder().encode(s).length);
    }
  });
});
