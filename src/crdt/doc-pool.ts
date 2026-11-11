import * as Y from 'yjs';
import { MAX_ACTIVE_DOCS } from '../constants';
import { logger } from '../logger';

/**
 * A simple LRU pool that keeps at most MAX_ACTIVE_DOCS Y.Doc instances in
 * memory. When it grows past that, it asks its owner to evict the least
 * recently used doc. The owner saves and removes it (via `evict`) at a point
 * where nothing else is using that doc; evicting here directly destroyed docs
 * that were still being edited, which lost those edits.
 */
export class DocPool {
  private docs = new Map<string, { doc: Y.Doc; lastAccess: number }>();
  private onEvictRequest: ((path: string) => void) | null = null;
  private evictionRequested = new Set<string>();

  setEvictHandler(handler: (path: string) => void): void {
    this.onEvictRequest = handler;
  }

  get(path: string): Y.Doc | undefined {
    const entry = this.docs.get(path);
    if (entry) {
      entry.lastAccess = Date.now();
      return entry.doc;
    }
    return undefined;
  }

  /** Like get, without counting as a use. */
  peek(path: string): Y.Doc | undefined {
    return this.docs.get(path)?.doc;
  }

  get size(): number {
    return this.docs.size;
  }

  set(path: string, doc: Y.Doc): void {
    this.docs.set(path, { doc, lastAccess: Date.now() });
    this._maybeRequestEviction(path);
  }

  has(path: string): boolean {
    return this.docs.has(path);
  }

  delete(path: string): void {
    const entry = this.docs.get(path);
    if (entry) {
      entry.doc.destroy();
      this.docs.delete(path);
    }
    this.evictionRequested.delete(path);
  }

  /** Remove a doc the owner has saved, unless it was replaced meanwhile. */
  evict(path: string, doc: Y.Doc): void {
    this.evictionRequested.delete(path);
    if (this.docs.get(path)?.doc !== doc) return;
    logger.debug(`Evicting doc from pool: ${path}`);
    doc.destroy();
    this.docs.delete(path);
  }

  /** The owner decided not to evict; allow a later request. */
  cancelEviction(path: string): void {
    this.evictionRequested.delete(path);
  }

  rename(oldPath: string, newPath: string): void {
    if (oldPath === newPath) return;

    const entry = this.docs.get(oldPath);
    if (!entry) return;

    const existing = this.docs.get(newPath);
    if (existing && existing.doc !== entry.doc) {
      existing.doc.destroy();
    }

    this.docs.delete(oldPath);
    this.evictionRequested.delete(oldPath);
    this.docs.set(newPath, {
      doc: entry.doc,
      lastAccess: Date.now(),
    });
  }

  getAll(): Map<string, Y.Doc> {
    const result = new Map<string, Y.Doc>();
    for (const [path, entry] of this.docs) {
      result.set(path, entry.doc);
    }
    return result;
  }

  async destroyAll(save?: (path: string, doc: Y.Doc) => Promise<void>): Promise<void> {
    for (const [path, entry] of this.docs) {
      if (save) {
        await save(path, entry.doc);
      }
      entry.doc.destroy();
    }
    this.docs.clear();
    this.evictionRequested.clear();
  }

  private _maybeRequestEviction(justAdded: string): void {
    if (this.docs.size - this.evictionRequested.size <= MAX_ACTIVE_DOCS) return;

    let oldestPath: string | null = null;
    let oldestTime = Infinity;
    for (const [path, entry] of this.docs) {
      if (path === justAdded || this.evictionRequested.has(path)) continue;
      if (entry.lastAccess < oldestTime) {
        oldestTime = entry.lastAccess;
        oldestPath = path;
      }
    }

    if (oldestPath) {
      this.evictionRequested.add(oldestPath);
      this.onEvictRequest?.(oldestPath);
    }
  }
}
