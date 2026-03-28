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
