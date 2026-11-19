import { REVIVED_FILE, TOMBSTONE_FILE, TOMBSTONE_TTL_MS } from '../constants';
import { logger } from '../logger';
import { ensureParentDirectory } from '../utils/path-utils';
import { readJsonWithBackup, writeAtomic } from '../utils/atomic-write';
import type { Revival, Tombstone } from '../types';

/**
 * How long changes to the records wait before they are written. A bulk
 * delete changes them once per file, and each write rewrites the whole file
 * (hundreds of KB in a large vault), which made deleting a thousand files
 * take minutes on a phone. The app saves them when it goes to the
 * background or closes (see SyncCoordinator.persist).
 */
const SAVE_DELAY_MS = 1000;
/**
 * While changes keep coming, writes are spaced so that they take a tenth of
 * the time at most, up to this long: writing a large file of records once a
 * second through a phone's slow storage still cost much of a bulk delete. A
 * deletion is on disk a few seconds after it was made, however slow.
 */
const MAX_SAVE_DELAY_MS = 3000;

/**
 * Remembers files deleted (or renamed away) on this device, so a peer that
 * was offline at the time is told to delete its copy instead of sending the
 * file back. Saved to disk so it survives restarts, and dropped after
 * TOMBSTONE_TTL_MS.
 */
export class TombstoneStore {
  private entries = new Map<string, Tombstone>();
  /**
   * Paths of the records of renames, by the name the file went to. A file
   * list exchange looks up, for each file one side lacks, the renames that
   * led to it: going through every record each time made that exchange take
   * seconds on a phone once a bulk change left thousands of records.
   */
  private byTarget = new Map<string, Set<string>>();
  /** Files put back after a deletion, by path; see revive. */
  private revivals = new Map<string, Revival>();
  private loaded = false;
  private saveChain: Promise<void> = Promise.resolve();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private entriesDirty = false;
  private revivalsDirty = false;
  private dirReady = false;
  /** How long the last write of the records took, in ms. */
  private lastWriteMs = 0;
  /** Told when a records file was damaged and read from its backup. */
  private onBackupUsed: ((path: string, why: string) => void) | undefined;

  constructor(private adapter: any, private now: () => number = Date.now) {}

  setOnBackupUsed(listener: (path: string, why: string) => void): void {
    this.onBackupUsed = listener;
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    for (const [file, into] of [[TOMBSTONE_FILE, this.entries], [REVIVED_FILE, this.revivals]] as const) {
      try {
        if (!this.adapter) continue;
        // A damaged file is read from its backup: losing the records would
        // let peers send deleted files back.
        const list = await readJsonWithBackup<Tombstone[]>(this.adapter, file, (p, why) => this.onBackupUsed?.(p, why));
        if (!Array.isArray(list)) continue;
        for (const t of list) {
          if (t && typeof t.path === 'string' && typeof t.deletedAt === 'number') {
            if (into === this.entries) this._set(t);
            else into.set(t.path, t);
          }
        }
      } catch (err) {
        logger.warn('Could not read deletion records:', err);
      }
    }
    this._prune();
  }

  get(path: string): Tombstone | undefined {
    return this.entries.get(path);
  }

  list(): Tombstone[] {
    this._prune();
    return Array.from(this.entries.values());
  }

  /** Records of renames of a file to `path`; the same as filtering list(). */
  renamesTo(path: string): Tombstone[] {
    const paths = this.byTarget.get(path);
    if (!paths) return [];
    const cutoff = this.now() - TOMBSTONE_TTL_MS;
    const out: Tombstone[] = [];
    for (const p of paths) {
      const t = this.entries.get(p);
      if (t && t.deletedAt >= cutoff) out.push(t);
    }
    return out;
  }

  add(path: string, hash?: string, deletedAt = this.now(), movedTo?: string, by?: string): void {
    const existing = this.entries.get(path);
    if (existing && existing.deletedAt >= deletedAt) return;
    // Deleted again: it no longer undoes the earlier deletion.
    if (this.revivals.delete(path)) this.revivalsDirty = true;
    const entry: Tombstone = { path, deletedAt };
    if (hash) entry.hash = hash;
    // A copy that reappeared under a renamed file's old name and was removed
    // again does not undo the rename: peers still need to know where it went.
    const moved = movedTo ?? existing?.movedTo;
    if (moved) entry.movedTo = moved;
    if (by) entry.by = by;
    this._set(entry);
    this._changed();
  }

  clear(path: string): void {
    if (this._delete(path)) this._changed();
  }

  /**
   * The file at `path` was put back here (restored from the trash, or made
   * anew) after it was deleted. The deletion record turns into a record of
   * that, which peers see in the file list (FileMeta.revives) and which
   * makes them drop their record of the same deletion: otherwise a peer's
   * record, matching the file by its content, had the restored file deleted
   * again. Records are compared by when the deletion was made, a time every
   * device recorded the same way (see FileDeletePayload.deletedAt), so
   * clocks need not agree. A record of a rename is only cleared: the new
   * file is not the one that was moved away.
   */
  revive(path: string): void {
    const existing = this.entries.get(path);
    if (!existing) return;
    this._delete(path);
    if (!existing.movedTo) this.noteRevival(path, existing.deletedAt, existing.hash);
    this._changed();
  }

  /** Record that the file at `path` undoes the deletion made at `deletedAt`. */
  noteRevival(path: string, deletedAt: number, hash?: string): void {
    const existing = this.revivals.get(path);
    if (existing && existing.deletedAt >= deletedAt) return;
    this.revivals.set(path, hash ? { path, deletedAt, hash } : { path, deletedAt });
    this.revivalsDirty = true;
    this._scheduleSave();
  }

  getRevival(path: string): Revival | undefined {
    return this.revivals.get(path);
  }

  /**
   * Whether a copy is the file that was deleted. A matching hash proves it.
   * Without a hash (an old record), only the version the two devices last
   * shared (`agreed`) is taken for it: a copy that is still that version
   * was not changed since. Clocks are not used: a device whose clock is
   * behind made edits that look older than the deletion, and those were
   * deleted. When in doubt the copy is kept, and comes back.
   */
  static covers(t: Tombstone, file: { hash: string; mtime: number }, agreed?: string): boolean {
    if (t.hash) return t.hash === file.hash;
    return agreed !== undefined && agreed === file.hash;
  }

  private _prune(): void {
    const cutoff = this.now() - TOMBSTONE_TTL_MS;
    for (const [p, t] of this.entries) {
      if (t.deletedAt < cutoff) {
        this._delete(p);
        this.entriesDirty = true;
      }
    }
    for (const [p, r] of this.revivals) {
      if (r.deletedAt < cutoff) {
        this.revivals.delete(p);
        this.revivalsDirty = true;
      }
    }
    this._scheduleSave();
  }

  private _set(entry: Tombstone): void {
    this._delete(entry.path);
    this.entries.set(entry.path, entry);
    if (!entry.movedTo) return;
    const paths = this.byTarget.get(entry.movedTo);
    if (paths) paths.add(entry.path);
    else this.byTarget.set(entry.movedTo, new Set([entry.path]));
  }

  private _delete(path: string): boolean {
    const old = this.entries.get(path);
    if (!old) return false;
    this.entries.delete(path);
    const paths = old.movedTo ? this.byTarget.get(old.movedTo) : undefined;
    if (paths) {
      paths.delete(path);
      if (paths.size === 0) this.byTarget.delete(old.movedTo!);
    }
    return true;
  }

  private _changed(): void {
    this.entriesDirty = true;
    this._scheduleSave();
  }

  private _scheduleSave(): void {
    if (!this.adapter || this.saveTimer || (!this.entriesDirty && !this.revivalsDirty)) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this._write();
    }, Math.min(MAX_SAVE_DELAY_MS, Math.max(SAVE_DELAY_MS, this.lastWriteMs * 10)));
  }

  private _write(): Promise<void> {
    this.saveChain = this.saveChain.then(async () => {
      const files: Array<[string, Map<string, Tombstone>]> = [];
      if (this.entriesDirty) files.push([TOMBSTONE_FILE, this.entries]);
      if (this.revivalsDirty) files.push([REVIVED_FILE, this.revivals]);
      this.entriesDirty = false;
      this.revivalsDirty = false;
      for (const [file, records] of files) {
        try {
          if (!this.dirReady) {
            await ensureParentDirectory(this.adapter, file);
            this.dirReady = true;
          }
          const started = Date.now();
          await writeAtomic(this.adapter, file, JSON.stringify(Array.from(records.values())));
          if (file === TOMBSTONE_FILE) this.lastWriteMs = Date.now() - started;
        } catch (err) {
          this.dirReady = false;
          if (file === TOMBSTONE_FILE) this.entriesDirty = true;
          else this.revivalsDirty = true;
          logger.warn('Could not save deletion records:', err);
        }
      }
    });
    return this.saveChain;
  }

  /** Write pending changes now. */
  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (!this.adapter) return;
    await this._write();
  }
}
