import { TOMBSTONE_FILE, TOMBSTONE_TTL_MS } from '../constants';
import { logger } from '../logger';
import { ensureParentDirectory } from '../utils/path-utils';
import type { Tombstone } from '../types';

/**
 * Remembers files deleted (or renamed away) on this device, so a peer that
 * was offline at the time is told to delete its copy instead of sending the
 * file back. Saved to disk so it survives restarts, and dropped after
 * TOMBSTONE_TTL_MS.
 */
export class TombstoneStore {
  private entries = new Map<string, Tombstone>();
  private loaded = false;
  private saveChain: Promise<void> = Promise.resolve();

  constructor(private adapter: any, private now: () => number = Date.now) {}

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      if (!this.adapter || !(await this.adapter.exists(TOMBSTONE_FILE))) return;
      const list = JSON.parse(await this.adapter.read(TOMBSTONE_FILE)) as Tombstone[];
      for (const t of list) {
        if (t && typeof t.path === 'string' && typeof t.deletedAt === 'number') {
          this.entries.set(t.path, t);
        }
      }
      this._prune();
    } catch (err) {
      logger.warn('Could not read deletion records:', err);
    }
  }

  get(path: string): Tombstone | undefined {
    return this.entries.get(path);
  }

  list(): Tombstone[] {
    this._prune();
    return Array.from(this.entries.values());
  }

  add(path: string, hash?: string, deletedAt = this.now(), movedTo?: string): void {
    const existing = this.entries.get(path);
    if (existing && existing.deletedAt >= deletedAt) return;
    const entry: Tombstone = { path, deletedAt };
    if (hash) entry.hash = hash;
    // A copy that reappeared under a renamed file's old name and was removed
    // again does not undo the rename: peers still need to know where it went.
    const moved = movedTo ?? existing?.movedTo;
    if (moved) entry.movedTo = moved;
    this.entries.set(path, entry);
    this._save();
  }

  clear(path: string): void {
    if (this.entries.delete(path)) this._save();
  }

  /**
   * Whether a peer's copy is the file this device deleted. A matching hash
   * proves it; without a hash, a copy last modified before the deletion is
   * treated as stale. A copy edited after the deletion is kept.
   */
  static covers(t: Tombstone, file: { hash: string; mtime: number }): boolean {
    return t.hash ? t.hash === file.hash : file.mtime <= t.deletedAt;
  }

  private _prune(): void {
    const cutoff = this.now() - TOMBSTONE_TTL_MS;
    let changed = false;
    for (const [p, t] of this.entries) {
      if (t.deletedAt < cutoff) {
        this.entries.delete(p);
        changed = true;
      }
    }
    if (changed) this._save();
  }

  private _save(): void {
    if (!this.adapter) return;
    const data = JSON.stringify(Array.from(this.entries.values()));
    this.saveChain = this.saveChain
      .then(async () => {
        await ensureParentDirectory(this.adapter, TOMBSTONE_FILE);
        await this.adapter.write(TOMBSTONE_FILE, data);
      })
      .catch((err) => logger.warn('Could not save deletion records:', err));
  }

  async flush(): Promise<void> {
    await this.saveChain;
  }
}
