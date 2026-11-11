import { describe, expect, it } from 'vitest';
import { ensureDirectory, ensureParentDirectory, getParentDir, MinimalAdapter } from './path-utils';

class MemoryAdapter implements MinimalAdapter {
  private dirs = new Set<string>();

  constructor(initialDirs: string[] = []) {
    for (const dir of initialDirs) {
      this.dirs.add(dir);
    }
  }

  async exists(path: string): Promise<boolean> {
    return this.dirs.has(path);
  }

  async mkdir(path: string): Promise<void> {
    this.dirs.add(path);
  }

  has(path: string): boolean {
    return this.dirs.has(path);
  }
}

describe('path-utils', () => {
  it('returns the parent directory for nested files', () => {
    expect(getParentDir('a/b/c.md')).toBe('a/b');
    expect(getParentDir('root.md')).toBe('');
  });

  it('creates nested directories recursively', async () => {
    const adapter = new MemoryAdapter();

    await ensureDirectory(adapter, 'one/two/three');

    expect(adapter.has('one')).toBe(true);
    expect(adapter.has('one/two')).toBe(true);
    expect(adapter.has('one/two/three')).toBe(true);
  });

  it('creates parent directories for files', async () => {
    const adapter = new MemoryAdapter(['existing']);

    await ensureParentDirectory(adapter, 'existing/deep/path/file.md');

    expect(adapter.has('existing/deep')).toBe(true);
    expect(adapter.has('existing/deep/path')).toBe(true);
  });
});

describe('isSafeSyncPath', () => {
  it('allows ordinary names, including dots inside a name', async () => {
    const { isSafeSyncPath } = await import('./path-utils');
    for (const ok of ['note.md', 'v1..2.md', '等等...md', '日记/2024 年/第一 篇.md', 'a/b..c/d.png']) {
      expect(isSafeSyncPath(ok)).toBe(true);
    }
  });

  it('refuses traversal, absolute, drive-letter and hidden paths', async () => {
    const { isSafeSyncPath } = await import('./path-utils');
    for (const bad of ['', '../x.md', 'a/../../x.md', '/etc/passwd', 'C:/x.md', 'a\\..\\x.md', 'a//b.md',
      '.obsidian/plugins/evil/main.js', 'notes/.hidden/x.md', 'a\0b.md']) {
      expect(isSafeSyncPath(bad)).toBe(false);
    }
  });
});
